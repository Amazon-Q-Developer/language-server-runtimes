import { constants, BigIntStats } from 'fs'
import { open, lstat, FileHandle } from 'fs/promises'
import { isAbsolute } from 'path'
import { Logging } from '../../../server-interface/logging'
import {
    CheckedFileOperations,
    CheckedFileTarget,
    ExistingFileTarget,
    FileUpdateError,
    FileUpdateOutcome,
} from '../../../server-interface/checkedFile'

type DebugLogger = Pick<Logging, 'debug'>

// Tests parse this shape; keep the `[file-access] <json>` form stable.
function logFileAccess(
    logging: DebugLogger | undefined,
    event: string,
    targetPath: string,
    fd?: number,
    error?: unknown
): void {
    try {
        logging?.debug(
            `[file-access] ${JSON.stringify({
                event,
                targetPath,
                fd,
                ...(error instanceof Error
                    ? { errorName: error.name, errorCode: (error as NodeJS.ErrnoException).code }
                    : {}),
            })}`
        )
    } catch {
        // Diagnostics must not change file-operation results.
    }
}

function fileError(code: string, message: string): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code })
}

function existingTarget(path: string, stat: BigIntStats): ExistingFileTarget {
    if (!stat.isFile()) {
        throw fileError(
            stat.isSymbolicLink() ? 'ELOOP' : stat.isDirectory() ? 'EISDIR' : 'EINVAL',
            'Expected a regular file'
        )
    }
    return Object.freeze({
        path,
        state: 'existing',
        dev: String(stat.dev),
        ino: String(stat.ino),
        linkCount: String(stat.nlink),
    })
}

async function capture(path: string): Promise<CheckedFileTarget> {
    if (!isAbsolute(path)) throw fileError('EINVAL', `Expected an absolute path: ${path}`)
    try {
        return existingTarget(path, await lstat(path, { bigint: true }))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return Object.freeze({ path, state: 'missing' })
    }
}

function verify(expected: ExistingFileTarget, actual: ExistingFileTarget): void {
    if (
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        BigInt(actual.linkCount) > BigInt(expected.linkCount)
    ) {
        throw fileError('ESTALE', 'The file changed since it was checked. Review it before trying again.')
    }
}

async function closeFile(handle: FileHandle, path: string, logging?: DebugLogger, operationFailed = false) {
    const fd = handle.fd
    try {
        await handle.close()
        logFileAccess(logging, 'handle.closed', path, fd)
    } catch (error) {
        logFileAccess(logging, 'handle.closeFailed', path, fd, error)
        if (!operationFailed) throw error
    }
}

async function openRegularFile(
    target: CheckedFileTarget,
    flags: number,
    logging?: DebugLogger,
    opened?: () => void
): Promise<{ handle: FileHandle; actual: ExistingFileTarget }> {
    // O_NONBLOCK: a FIFO or device substituted at this path must not block the event loop on open.
    const handle = await open(target.path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    opened?.()
    logFileAccess(logging, 'open.completed', target.path, handle.fd)
    try {
        const actual = existingTarget(target.path, await handle.stat({ bigint: true }))
        if (target.state === 'existing') verify(target, actual)
        else if (actual.linkCount !== '1') throw fileError('ESTALE', 'The new file changed before it could be written.')
        logFileAccess(logging, 'handle.checked', target.path, handle.fd)
        return { handle, actual }
    } catch (error) {
        await closeFile(handle, target.path, logging, true)
        throw error
    }
}

async function read(target: CheckedFileTarget, logging?: DebugLogger): Promise<string> {
    if (target.state === 'missing') throw fileError('ENOENT', `No such file or directory: ${target.path}`)
    const { handle } = await openRegularFile(target, constants.O_RDONLY, logging)
    let failed = false
    try {
        const content = await handle.readFile({ encoding: 'utf8' })
        logFileAccess(logging, 'read.completed', target.path, handle.fd)
        return content
    } catch (error) {
        failed = true
        throw error
    } finally {
        await closeFile(handle, target.path, logging, failed)
    }
}

async function update(
    target: CheckedFileTarget,
    transform: (content: string) => string,
    options: { create?: boolean; readExisting?: boolean } = {},
    logging?: DebugLogger
): Promise<FileUpdateOutcome> {
    let mayHaveChanged = false
    let actual: ExistingFileTarget | undefined
    try {
        const creating = target.state === 'missing'
        if (creating && !options.create) throw fileError('ENOENT', `No such file or directory: ${target.path}`)
        // Transform new content before creating an entry, so a rejected edit creates nothing.
        const newContent = creating ? Buffer.from(transform(''), 'utf8') : undefined
        const flags = creating
            ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            : options.readExisting === false
              ? constants.O_WRONLY
              : constants.O_RDWR
        const opened = await openRegularFile(target, flags, logging, () => {
            mayHaveChanged = creating
        })
        const handle = opened.handle
        actual = opened.actual
        let failed = false
        try {
            const content =
                newContent ??
                Buffer.from(
                    transform(options.readExisting === false ? '' : await handle.readFile({ encoding: 'utf8' })),
                    'utf8'
                )
            // Write through the verified handle at explicit offsets; the path is never resolved again.
            let offset = 0
            while (offset < content.length) {
                mayHaveChanged = true
                const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset)
                if (bytesWritten === 0) throw fileError('EIO', 'File write made no progress')
                offset += bytesWritten
            }
            mayHaveChanged = true
            await handle.truncate(content.length)
            logFileAccess(logging, 'update.completed', target.path, handle.fd)
        } catch (error) {
            failed = true
            throw error
        } finally {
            await closeFile(handle, target.path, logging, failed)
        }
        return Object.freeze({ mayHaveChanged, complete: true, target: actual })
    } catch (error) {
        logFileAccess(logging, 'update.failed', target.path, undefined, error)
        throw new FileUpdateError(error, Object.freeze({ mayHaveChanged, complete: false, target: actual }))
    }
}

/**
 * Shared by the standalone provider and filesystem integration fixtures.
 *
 * @internal Re-exported from `testing` so consumer test fixtures can run real checked I/O.
 * It is not part of the server-interface contract. The tag is advisory: keep this in the
 * published declarations because consumer tests import it.
 */
export function createCheckedFileOperations(
    logging?: DebugLogger,
    didChange?: (path: string) => void | Promise<void>
): CheckedFileOperations | undefined {
    if (process.platform === 'win32' || !constants.O_NOFOLLOW) return undefined
    const notify = (path: string) => {
        try {
            void Promise.resolve(didChange?.(path)).catch(error =>
                logFileAccess(logging, 'notification.failed', path, undefined, error)
            )
        } catch (error) {
            logFileAccess(logging, 'notification.failed', path, undefined, error)
        }
    }
    return Object.freeze({
        version: 1,
        capture,
        read: (target: CheckedFileTarget) => read(target, logging),
        update: async (
            target: CheckedFileTarget,
            transform: (content: string) => string,
            options?: { create?: boolean; readExisting?: boolean }
        ) => {
            try {
                const outcome = await update(target, transform, options, logging)
                if (outcome.mayHaveChanged) notify(target.path)
                return outcome
            } catch (error) {
                if (error instanceof FileUpdateError && error.outcome.mayHaveChanged) notify(target.path)
                throw error
            }
        },
    })
}

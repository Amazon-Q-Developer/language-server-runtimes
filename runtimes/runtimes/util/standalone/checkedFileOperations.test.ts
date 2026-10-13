import assert from 'assert'
import fs from 'fs/promises'
import { constants } from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import { createCheckedFileOperations } from './checkedFileOperations'
import { CheckedFileOperations, CheckedFileTarget, FileUpdateError } from '../../../server-interface/checkedFile'
// Suite-level skip rather than this.skip(): the hooks themselves do POSIX-only I/O.
;(process.platform !== 'win32' && constants.O_NOFOLLOW ? describe : describe.skip)('checked file operations', () => {
    let directory: string
    let file: string
    let target: CheckedFileTarget
    let operations: CheckedFileOperations
    let notify: sinon.SinonStub

    beforeEach(async () => {
        directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guarded-file-')))
        file = path.join(directory, 'example.txt')
        await fs.writeFile(file, 'original fixture')
        notify = sinon.stub()
        operations = createCheckedFileOperations(undefined, notify)!
        target = await operations.capture(file)
    })

    afterEach(async () => {
        sinon.restore()
        await fs.rm(directory, { recursive: true, force: true })
    })

    it('captures immutable bigint identity and reads the accepted file', async () => {
        const stat = await fs.stat(file, { bigint: true })
        assert.deepStrictEqual(target, {
            path: file,
            state: 'existing',
            dev: String(stat.dev),
            ino: String(stat.ino),
            linkCount: String(stat.nlink),
        })
        assert.ok(Object.isFrozen(target))
        assert.strictEqual(operations.version, 1)
        assert.strictEqual(await operations.read(target), 'original fixture')
        sinon.assert.notCalled(notify)
    })

    it('supports shorter, empty, multibyte, and same-handle transformed replacements', async () => {
        await operations.update(target, text => text.replace('original', 'updated'))
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'updated fixture')
        for (const content of ['short', '', 'updated 日本']) {
            const outcome = await operations.update(target, () => content, { readExisting: false })
            assert.deepStrictEqual(outcome, { mayHaveChanged: true, complete: true, target })
            assert.strictEqual(await fs.readFile(file, 'utf8'), content)
        }
        assert.strictEqual(notify.callCount, 4)
    })

    it('rejects ordinary-file and hard-link substitutions before reading or transforming', async () => {
        const other = path.join(directory, 'other.txt')
        await fs.writeFile(other, 'untouched')
        await fs.rename(file, path.join(directory, 'original.txt'))
        await fs.link(other, file)
        const transform = sinon.stub().returns('changed')
        await assert.rejects(operations.read(target), { code: 'ESTALE' })
        await assert.rejects(operations.update(target, transform), { code: 'ESTALE' })
        sinon.assert.notCalled(transform)
        sinon.assert.notCalled(notify)
        assert.strictEqual(await fs.readFile(other, 'utf8'), 'untouched')
    })

    it('rejects an increased link count but permits a captured multiply-linked file', async () => {
        await fs.link(file, path.join(directory, 'alias.txt'))
        await assert.rejects(operations.read(target), { code: 'ESTALE' })
        await assert.rejects(
            operations.update(target, () => 'rejected'),
            { code: 'ESTALE' }
        )
        const approved = await operations.capture(file)
        await operations.update(approved, () => 'accepted')
        assert.strictEqual(await fs.readFile(path.join(directory, 'alias.txt'), 'utf8'), 'accepted')
    })

    it('does not recreate an existing accepted file after it is removed', async () => {
        await fs.unlink(file)
        await assert.rejects(
            operations.update(target, () => 'new', { create: true }),
            { code: 'ENOENT' }
        )
        await assert.rejects(fs.stat(file), { code: 'ENOENT' })
        sinon.assert.notCalled(notify)
    })

    it('creates a missing destination exclusively and returns its handle identity', async () => {
        const missing = await operations.capture(path.join(directory, 'new.txt'))
        await assert.rejects(
            operations.update(missing, () => 'new'),
            { code: 'ENOENT' }
        )
        const outcome = await operations.update(missing, () => 'new', { create: true })
        assert.deepStrictEqual(outcome.target, await operations.capture(missing.path))
        assert.strictEqual(await fs.readFile(missing.path, 'utf8'), 'new')
        sinon.assert.calledOnceWithExactly(notify, missing.path)
    })

    it('does not open an entry that appeared at a previously missing destination', async () => {
        const missing = await operations.capture(path.join(directory, 'new.txt'))
        await fs.writeFile(missing.path, 'competitor')
        const open = sinon.spy(fs, 'open')
        await assert.rejects(
            operations.update(missing, () => 'new', { create: true }),
            { code: 'EEXIST' }
        )
        sinon.assert.calledOnce(open)
        const flags = open.firstCall.args[1] as number
        assert.ok(flags & constants.O_CREAT)
        assert.ok(flags & constants.O_EXCL)
        assert.ok(flags & constants.O_NOFOLLOW)
        assert.strictEqual(flags & constants.O_TRUNC, 0)
        assert.strictEqual(await fs.readFile(missing.path, 'utf8'), 'competitor')
        sinon.assert.notCalled(notify)
    })

    it('does not mutate or create when transformation fails', async () => {
        const failure = new Error('Transform failed')
        for (const checked of [target, await operations.capture(path.join(directory, 'new.txt'))]) {
            await assert.rejects(
                operations.update(
                    checked,
                    () => {
                        throw failure
                    },
                    { create: true }
                ),
                error => error instanceof FileUpdateError && error.cause === failure && !error.outcome.mayHaveChanged
            )
        }
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'original fixture')
        await assert.rejects(fs.stat(path.join(directory, 'new.txt')), { code: 'ENOENT' })
        sinon.assert.notCalled(notify)
    })

    it('rejects final symbolic links, dangling links, and non-regular captures', async () => {
        const link = path.join(directory, 'link.txt')
        await fs.symlink(file, link)
        await assert.rejects(operations.capture(link), { code: 'ELOOP' })
        const missing = path.join(directory, 'missing.txt')
        const dangling = path.join(directory, 'dangling.txt')
        await fs.symlink(missing, dangling)
        await assert.rejects(operations.capture(dangling), { code: 'ELOOP' })
        await assert.rejects(operations.capture(directory), { code: 'EISDIR' })
        await fs.rename(file, path.join(directory, 'moved.txt'))
        await fs.symlink(missing, file)
        await assert.rejects(operations.read(target), { code: 'ELOOP' })
        await assert.rejects(
            operations.update(target, () => 'changed', { create: true }),
            { code: 'ELOOP' }
        )
        await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
    })

    it('does not classify permission errors as missing targets', async () => {
        sinon.stub(fs, 'lstat').rejects(Object.assign(new Error('denied'), { code: 'EACCES' }))
        await assert.rejects(operations.capture(file), { code: 'EACCES' })
    })

    it('rejects relative paths before touching the filesystem', async () => {
        const lstat = sinon.spy(fs, 'lstat')
        await assert.rejects(operations.capture('example.txt'), { code: 'EINVAL' })
        await assert.rejects(operations.capture('./example.txt'), { code: 'EINVAL' })
        sinon.assert.notCalled(lstat)
    })

    it('keeps writing the verified object after the filename changes', async () => {
        const other = path.join(directory, 'other.txt')
        const moved = path.join(directory, 'moved.txt')
        await fs.writeFile(other, 'untouched')
        const original = fs.open
        sinon.stub(fs, 'open').callsFake(async (name, flags, mode) => {
            const handle = await original(name, flags, mode)
            await fs.rename(file, moved)
            await fs.symlink(other, file)
            return handle
        })
        const outcome = await operations.update(target, text => text.replace('original', 'updated'))
        assert.deepStrictEqual(outcome.target, target)
        assert.strictEqual(await fs.readFile(moved, 'utf8'), 'updated fixture')
        assert.strictEqual(await fs.readFile(other, 'utf8'), 'untouched')
    })

    it('closes a handle when validation fails without transforming', async () => {
        const handle = await fs.open(directory, constants.O_RDONLY)
        const close = sinon.spy(handle, 'close')
        sinon.stub(fs, 'open').resolves(handle)
        await assert.rejects(operations.read(target), { code: 'EISDIR' })
        sinon.assert.calledOnce(close)
    })

    it('preserves primary read and transform errors when close also fails', async () => {
        const failure = new Error('Primary failure')
        for (const reading of [true, false]) {
            const handle = await fs.open(file, constants.O_RDWR)
            const close = handle.close.bind(handle)
            sinon.stub(fs, 'open').resolves(handle)
            sinon.stub(handle, 'close').callsFake(async () => {
                await close()
                throw new Error('Close failed')
            })
            if (reading) {
                sinon.stub(handle, 'readFile').rejects(failure)
                await assert.rejects(operations.read(target), error => error === failure)
            } else {
                await assert.rejects(
                    operations.update(target, () => {
                        throw failure
                    }),
                    error =>
                        error instanceof FileUpdateError && error.cause === failure && !error.outcome.mayHaveChanged
                )
            }
            sinon.restore()
        }
    })

    it('reports a close failure after a write and still notifies exactly once', async () => {
        const handle = await fs.open(file, constants.O_RDWR)
        const close = handle.close.bind(handle)
        const failure = Object.assign(new Error('Deferred write failed'), { code: 'EIO' })
        sinon.stub(fs, 'open').resolves(handle)
        sinon.stub(handle, 'close').callsFake(async () => {
            await close()
            throw failure
        })
        await assert.rejects(
            operations.update(target, () => 'updated'),
            error =>
                error instanceof FileUpdateError &&
                error.cause === failure &&
                error.outcome.mayHaveChanged &&
                !error.outcome.complete
        )
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'updated')
        sinon.assert.calledOnceWithExactly(notify, file)
    })

    it('completes partial writes and reports mutation when a later write fails', async () => {
        const handle = await fs.open(file, constants.O_RDWR)
        const write = handle.write.bind(handle)
        sinon.stub(fs, 'open').resolves(handle)
        const partial = sinon.stub(handle, 'write').callsFake(async (...args: any[]) => {
            const [buffer, offset, length, position] = args
            return write(buffer, offset, Math.min(length, 2), position)
        })
        await operations.update(target, () => 'short')
        assert.ok(partial.callCount > 1)
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'short')
        sinon.restore()
        notify.resetHistory()
        const failing = await fs.open(file, constants.O_RDWR)
        const firstWrite = failing.write.bind(failing)
        sinon.stub(fs, 'open').resolves(failing)
        const stub = sinon.stub(failing, 'write')
        stub.onFirstCall().callsFake(async (buffer: any) => firstWrite(buffer, 0, 2, 0))
        stub.onSecondCall().rejects(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }))
        await assert.rejects(
            operations.update(target, () => 'next'),
            error =>
                error instanceof FileUpdateError &&
                error.code === 'ENOSPC' &&
                error.outcome.mayHaveChanged &&
                !error.outcome.complete
        )
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'neort')
        sinon.assert.calledOnceWithExactly(notify, file)
    })

    for (const failurePoint of ['write', 'truncate'] as const) {
        it(`reports uncertain mutation and closes after ${failurePoint} fails`, async () => {
            const handle = await fs.open(file, constants.O_RDWR)
            const close = sinon.spy(handle, 'close')
            sinon.stub(fs, 'open').resolves(handle)
            if (failurePoint === 'write') sinon.stub(handle, 'write').resolves({ bytesWritten: 0, buffer: '' })
            else sinon.stub(handle, 'truncate').rejects(Object.assign(new Error('Truncate failed'), { code: 'EIO' }))
            await assert.rejects(
                operations.update(target, () => 'next'),
                error => error instanceof FileUpdateError && error.outcome.mayHaveChanged && !error.outcome.complete
            )
            sinon.assert.calledOnce(close)
            sinon.assert.calledOnceWithExactly(notify, file)
        })
    }

    it('reports creation even if handle validation fails, without pathname cleanup', async () => {
        const missing = await operations.capture(path.join(directory, 'new.txt'))
        const original = fs.open
        sinon.stub(fs, 'open').callsFake(async (name, flags, mode) => {
            const handle = await original(name, flags, mode)
            sinon.stub(handle, 'stat').rejects(new Error('Stat failed'))
            return handle
        })
        await assert.rejects(
            operations.update(missing, () => 'new', { create: true }),
            error => error instanceof FileUpdateError && error.outcome.mayHaveChanged && !error.outcome.target
        )
        assert.strictEqual(await fs.readFile(missing.path, 'utf8'), '')
        sinon.assert.calledOnceWithExactly(notify, missing.path)
    })

    const fileAccessEvents = (debug: sinon.SinonStub) =>
        debug.args.map(([message]) => JSON.parse(String(message).replace(/^\[file-access\] /, '')))

    it('logs notification.failed when asynchronous delivery rejects, without leaking content', async () => {
        const debug = sinon.stub()
        notify.rejects(Object.assign(new Error('Transport failed'), { code: 'ECONNRESET' }))
        operations = createCheckedFileOperations({ debug }, notify)!
        assert.strictEqual((await operations.update(target, () => 'private-content')).complete, true)
        // The rejection handler runs on a later microtask than the resolved update.
        await new Promise(resolve => setImmediate(resolve))
        const failures = fileAccessEvents(debug).filter(event => event.event === 'notification.failed')
        assert.deepStrictEqual(failures, [
            { event: 'notification.failed', targetPath: file, errorName: 'Error', errorCode: 'ECONNRESET' },
        ])
        assert.ok(!JSON.stringify(debug.args).includes('private-content'))
        assert.ok(!JSON.stringify(debug.args).includes('original fixture'))
    })

    it('logs notification.failed when synchronous delivery throws', async () => {
        const debug = sinon.stub()
        notify.throws(Object.assign(new Error('Transport failed'), { code: 'EPIPE' }))
        operations = createCheckedFileOperations({ debug }, notify)!
        assert.strictEqual((await operations.update(target, () => 'next')).complete, true)
        const failures = fileAccessEvents(debug).filter(event => event.event === 'notification.failed')
        assert.deepStrictEqual(failures, [
            { event: 'notification.failed', targetPath: file, errorName: 'Error', errorCode: 'EPIPE' },
        ])
    })

    it('completes the update when both notification delivery and the logger throw', async () => {
        operations = createCheckedFileOperations(
            {
                debug: () => {
                    throw new Error('Logger failed')
                },
            },
            () => {
                throw new Error('Transport failed')
            }
        )!
        assert.strictEqual((await operations.update(target, () => 'next')).complete, true)
    })

    it('does not expose the capability on Windows', () => {
        sinon.stub(process, 'platform').value('win32')
        assert.strictEqual(createCheckedFileOperations(), undefined)
    })
})

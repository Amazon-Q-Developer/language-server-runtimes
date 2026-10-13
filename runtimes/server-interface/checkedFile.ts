/**
 * Identity and link count observed together for an existing regular file.
 *
 * `dev`, `ino`, and `linkCount` are decimal text: `dev` and `ino` can exceed
 * `Number.MAX_SAFE_INTEGER` and must compare exactly after a JSON round-trip, and the
 * three fields share one representation. The provider freezes every target it returns;
 * `Readonly` mirrors that.
 */
export type ExistingFileTarget = Readonly<{
    path: string
    state: 'existing'
    dev: string
    ino: string
    linkCount: string
}>

/** Capture before acceptance; retain this value for the subsequent operation. */
export type CheckedFileTarget = ExistingFileTarget | Readonly<{ path: string; state: 'missing' }>

/**
 * Result of an update. A resolved update always has `complete: true`; every other
 * combination is reported through `FileUpdateError.outcome`.
 *
 * - `mayHaveChanged: false` means the file was not touched: the failure happened before
 *   the first write, so the caller may retry without reviewing the file.
 * - `mayHaveChanged: true, complete: false` means one of: the file holds a prefix of the
 *   new content followed by the old tail (a write failed part-way; the file is not
 *   truncated first); the full new content was written but the handle failed to close;
 *   or, for a create, a new empty file exists whose handle failed verification (`target`
 *   is then absent). Review the file before retrying.
 * - `mayHaveChanged: true, complete: true` means the replacement and close finished.
 *   This is not a durability guarantee; nothing is synced to storage.
 */
export type FileUpdateOutcome = Readonly<{
    /** Upper bound: `true` once the first write or truncate was attempted, even if it moved no bytes. */
    mayHaveChanged: boolean
    /** True only when the replacement and handle close both completed. Not a durability guarantee. */
    complete: boolean
    /**
     * Identity of the opened handle, never a path lookup after writing. Present once the
     * handle was opened and verified; absent when the failure happened before that.
     */
    target?: ExistingFileTarget
}>

/**
 * Marks `FileUpdateError` instances so `isFileUpdateError` recognises them when more than
 * one copy of this package is loaded in the process, where `instanceof` is false. The
 * registry key is public contract and must not change; a breaking change to the error
 * shape ships under a new key.
 */
const FILE_UPDATE_ERROR_BRAND = Symbol.for('@aws/language-server-runtimes:FileUpdateError')

export class FileUpdateError extends Error {
    readonly code?: string

    constructor(
        public readonly cause: unknown,
        public readonly outcome: FileUpdateOutcome
    ) {
        super(cause instanceof Error ? cause.message : String(cause))
        this.name = 'FileUpdateError'
        this.code = (cause as NodeJS.ErrnoException | undefined)?.code
    }
}

// On the prototype so subclasses inherit it and `{ ...error }` copies do not carry it.
Object.defineProperty(FileUpdateError.prototype, FILE_UPDATE_ERROR_BRAND, { value: true })

function isFileUpdateOutcome(value: unknown): value is FileUpdateOutcome {
    if (typeof value !== 'object' || value === null) return false
    const outcome = value as Record<string, unknown>
    return (
        typeof outcome.mayHaveChanged === 'boolean' &&
        typeof outcome.complete === 'boolean' &&
        (outcome.target === undefined || (typeof outcome.target === 'object' && outcome.target !== null))
    )
}

/**
 * Prefer this over `instanceof FileUpdateError`: duplicate installs of this package give
 * each copy its own class, and `instanceof` against one copy rejects errors thrown by the
 * other. The check accepts any branded error whose `outcome` has the documented shape.
 * Errors that cross a serialization boundary (IPC, structured clone) lose the brand.
 */
export function isFileUpdateError(error: unknown): error is FileUpdateError {
    if (error instanceof FileUpdateError) return true
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as Record<symbol, unknown>)[FILE_UPDATE_ERROR_BRAND] === true &&
        isFileUpdateOutcome((error as { outcome?: unknown }).outcome)
    )
}

/** Optional POSIX regular-file operations. Consumers must check the version before use. */
export interface CheckedFileOperations {
    /**
     * Contract version, currently 1. It increments only for additive changes: a runtime
     * reporting N provides every member of versions 1 through N with unchanged semantics,
     * so consumers accept `version >= required`. A change that removes a member or alters
     * existing semantics is not a version bump; it ships under a new `workspace.fs`
     * capability name so older consumers fail the presence check instead.
     */
    readonly version: number
    /** Observe an absolute, canonical path without following a final symbolic link. */
    capture(path: string): Promise<CheckedFileTarget>
    /** Read through a handle matching the captured identity and link-count bound. */
    read(target: CheckedFileTarget): Promise<string>
    /**
     * Transform and replace through one verified handle. Missing targets require create=true
     * and use exclusive creation; existing targets are never recreated if removed.
     * A FileUpdateError reports the outcome when an update fails.
     */
    update(
        target: CheckedFileTarget,
        transform: (content: string) => string,
        options?: { create?: boolean; readExisting?: boolean }
    ): Promise<FileUpdateOutcome>
}

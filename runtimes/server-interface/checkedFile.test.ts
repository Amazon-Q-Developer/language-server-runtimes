import assert from 'assert'
import { CheckedFileOperations, FileUpdateError, FileUpdateOutcome, isFileUpdateError } from './checkedFile'

type CheckedFileModule = typeof import('./checkedFile')
const BRAND = Symbol.for('@aws/language-server-runtimes:FileUpdateError')

describe('checked file contract', () => {
    const outcome: FileUpdateOutcome = { mayHaveChanged: true, complete: false }
    const cause = Object.assign(new Error('Disk full'), { code: 'ENOSPC' })

    describe('isFileUpdateError', () => {
        it('accepts errors constructed from this module', () => {
            const error = new FileUpdateError(cause, outcome)
            assert.strictEqual(isFileUpdateError(error), true)
            assert.strictEqual(error.name, 'FileUpdateError')
            assert.strictEqual(error.code, 'ENOSPC')
        })

        it('accepts errors constructed by a second copy of the module, where instanceof is false', () => {
            // Evict and reload to get a distinct class, as a duplicate package install would.
            const modulePath = require.resolve('./checkedFile')
            const cached = require.cache[modulePath]
            delete require.cache[modulePath]
            const duplicate = require('./checkedFile') as CheckedFileModule
            require.cache[modulePath] = cached
            assert.notStrictEqual(duplicate.FileUpdateError, FileUpdateError, 'test setup must load a second copy')

            const fromDuplicate = new duplicate.FileUpdateError(cause, outcome)
            assert.strictEqual(fromDuplicate instanceof FileUpdateError, false)
            assert.strictEqual(isFileUpdateError(fromDuplicate), true)
            if (isFileUpdateError(fromDuplicate)) {
                assert.strictEqual(fromDuplicate.outcome.mayHaveChanged, true)
                assert.strictEqual(fromDuplicate.cause, cause)
            }

            const fromThisCopy = new FileUpdateError(cause, outcome)
            assert.strictEqual(fromThisCopy instanceof duplicate.FileUpdateError, false)
            assert.strictEqual(duplicate.isFileUpdateError(fromThisCopy), true)
        })

        it('rejects a plain error that only copies the name and outcome', () => {
            const lookalike = Object.assign(new Error('Disk full'), { name: 'FileUpdateError', cause, outcome })
            assert.strictEqual(isFileUpdateError(lookalike), false)
        })

        it('rejects a spread copy of a real error, which loses the prototype brand', () => {
            const copy = { ...new FileUpdateError(cause, outcome), message: 'Disk full', name: 'FileUpdateError' }
            assert.strictEqual(isFileUpdateError(copy), false)
        })

        it('rejects a branded value whose outcome does not have the documented shape', () => {
            for (const malformed of [undefined, null, 'done', { mayHaveChanged: 'yes', complete: false }]) {
                const broken = Object.defineProperty({ cause, outcome: malformed }, BRAND, { value: true })
                assert.strictEqual(isFileUpdateError(broken), false, JSON.stringify(malformed))
            }
        })

        it('accepts a foreign object carrying the registry brand and a well-formed outcome', () => {
            // The registry key is public contract; this pins it so a change is deliberate.
            const foreign = Object.defineProperty(Object.assign(new Error('Disk full'), { cause, outcome }), BRAND, {
                value: true,
            })
            assert.strictEqual(isFileUpdateError(foreign), true)
        })

        it('rejects values that are not objects', () => {
            for (const value of [undefined, null, 'FileUpdateError', 42, Symbol('FileUpdateError')]) {
                assert.strictEqual(isFileUpdateError(value), false)
            }
        })

        it('does not expose the brand as an own property', () => {
            const error = new FileUpdateError(cause, outcome)
            assert.strictEqual(Object.getOwnPropertySymbols(error).length, 0)
            assert.strictEqual((error as unknown as Record<symbol, unknown>)[BRAND], true)
        })
    })

    describe('version', () => {
        it('accepts a provider reporting a later additive version', () => {
            // Compile-time check: `version` is a number, not the literal 1, so additive bumps are not type breaks.
            const later: CheckedFileOperations = {
                version: 2,
                capture: async path => ({ path, state: 'missing' }),
                read: async () => '',
                update: async () => ({ mayHaveChanged: false, complete: true }),
            }
            assert.ok(later.version >= 1)
        })
    })
})

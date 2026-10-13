import assert from 'assert'
import sinon from 'sinon'
import {
    CheckedFileOperations,
    CheckedFileTarget,
    ExistingFileTarget,
    FileUpdateError,
    FileUpdateOutcome,
    isFileUpdateError,
} from '../server-interface'
import { FileUpdateError as CheckedFileUpdateError } from '../server-interface/checkedFile'
import { TestFeatures } from './TestFeatures'

describe('TestFeatures checked files', () => {
    const target: ExistingFileTarget = {
        path: '/workspace/file.txt',
        state: 'existing',
        dev: '1',
        ino: '2',
        linkCount: '1',
    }
    const outcome: FileUpdateOutcome = { mayHaveChanged: true, complete: true, target }

    it('exports the original error class and its guard from the public server interface', () => {
        const cause = Object.assign(new Error('Update failed'), { code: 'EIO' })
        const error = new FileUpdateError(cause, outcome)
        assert.strictEqual(FileUpdateError, CheckedFileUpdateError)
        assert.ok(error instanceof CheckedFileUpdateError)
        assert.strictEqual(isFileUpdateError(error), true)
        assert.strictEqual(error.cause, cause)
        assert.strictEqual(error.outcome, outcome)
        assert.strictEqual(error.code, 'EIO')
    })

    it('provides a versioned default with only the supported operations', () => {
        const features = new TestFeatures()
        const operations: CheckedFileOperations | undefined = features.workspace.fs.checkedFiles
        assert.ok(operations)
        assert.strictEqual(operations, features.checkedFiles)
        assert.strictEqual(operations.version, 1)
        assert.deepStrictEqual(Object.keys(operations).sort(), ['capture', 'read', 'update', 'version'])
        sinon.assert.notCalled(features.checkedFiles.capture)
        sinon.assert.notCalled(features.checkedFiles.read)
        sinon.assert.notCalled(features.checkedFiles.update)
    })

    it('requires explicit outcomes for unconfigured operations', async () => {
        const features = new TestFeatures()
        const operations = features.workspace.fs.checkedFiles!
        await assert.rejects(operations.capture(target.path), /checkedFiles.capture is not configured/)
        await assert.rejects(operations.read(target), /checkedFiles.read is not configured/)
        await assert.rejects(
            operations.update(target, content => content),
            /checkedFiles.update is not configured/
        )
    })

    it('allows configuring operations through typed stubs', async () => {
        const features = new TestFeatures()
        const operations = features.workspace.fs.checkedFiles!
        features.checkedFiles.capture.resolves(target)
        features.checkedFiles.read.resolves('before')
        features.checkedFiles.update.resolves(outcome)

        const captured: CheckedFileTarget = await operations.capture(target.path)
        assert.strictEqual(captured, target)
        assert.strictEqual(await operations.read(captured), 'before')
        const transform = (content: string) => `${content} after`
        const options = { readExisting: true }
        assert.strictEqual(await operations.update(captured, transform, options), outcome)
        sinon.assert.calledOnceWithExactly(features.checkedFiles.capture, target.path)
        sinon.assert.calledOnceWithExactly(features.checkedFiles.read, captured)
        sinon.assert.calledOnceWithExactly(features.checkedFiles.update, captured, transform, options)
    })

    it('allows configuring update failures using the public error class', async () => {
        const features = new TestFeatures()
        const error = new FileUpdateError(new Error('Update failed'), { mayHaveChanged: false, complete: false })
        features.checkedFiles.update.rejects(error)
        await assert.rejects(
            features.workspace.fs.checkedFiles!.update(target, content => content),
            actual => actual === error
        )
    })

    it('allows simulating a provider without checked file operations', () => {
        const features = new TestFeatures()
        delete features.workspace.fs.checkedFiles
        assert.strictEqual(features.workspace.fs.checkedFiles, undefined)
        features.workspace.fs.checkedFiles = features.checkedFiles
        assert.strictEqual(features.workspace.fs.checkedFiles.version, 1)
        features.workspace.fs.checkedFiles = undefined
        assert.strictEqual(features.workspace.fs.checkedFiles, undefined)
    })

    it('keeps stub behavior and call history isolated between instances', async () => {
        const first = new TestFeatures()
        const second = new TestFeatures()
        assert.notStrictEqual(first.checkedFiles, second.checkedFiles)
        for (const method of ['capture', 'read', 'update'] as const) {
            assert.notStrictEqual(first.checkedFiles[method], second.checkedFiles[method])
        }
        first.checkedFiles.capture.resolves(target)
        assert.strictEqual(await first.workspace.fs.checkedFiles!.capture(target.path), target)
        sinon.assert.notCalled(second.checkedFiles.capture)
        await assert.rejects(
            second.workspace.fs.checkedFiles!.capture(target.path),
            /checkedFiles.capture is not configured/
        )
        sinon.assert.calledOnce(first.checkedFiles.capture)
    })
})

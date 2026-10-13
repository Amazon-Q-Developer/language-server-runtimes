import sinon, { stubInterface } from 'ts-sinon'
import { RuntimeProps } from './runtime'
import assert from 'assert'
import { standalone } from './standalone'
import * as vscodeLanguageServer from 'vscode-languageserver/node'
import * as os from 'os'
import * as path from 'path'
import * as lspRouterModule from './lsp/router/lspRouter'
import { LspServer } from './lsp/router/lspServer'
import { Features } from '../server-interface/server'
import * as authEncryptionModule from './auth/standalone/encryption'
import * as authModule from './auth/auth'
import * as encryptedChatModule from './chat/encryptedChat'
import * as baseChatModule from './chat/baseChat'
import { pathToFileURL } from 'url'
import fsPromises from 'fs/promises'
import { didWriteFileNotificationType, didAppendFileNotificationType } from '../protocol'

describe('standalone', () => {
    let stubServer: sinon.SinonStub
    let props: RuntimeProps
    let stubConnection: sinon.SinonStubbedInstance<vscodeLanguageServer.Connection> & vscodeLanguageServer.Connection
    let lspRouterStub: sinon.SinonStubbedInstance<lspRouterModule.LspRouter> & lspRouterModule.LspRouter
    let initialCrashListeners: NodeJS.UncaughtExceptionListener[]

    beforeEach(() => {
        initialCrashListeners = process.listeners('uncaughtExceptionMonitor')
        stubServer = sinon.stub()
        props = {
            version: '0.1.0',
            servers: [stubServer],
            name: 'Test',
        }
        stubConnection = stubInterface<vscodeLanguageServer.Connection>()
        stubConnection.console = stubInterface<vscodeLanguageServer.RemoteConsole>()
        stubConnection.telemetry = stubInterface<vscodeLanguageServer.Telemetry>()

        sinon.stub(vscodeLanguageServer, 'createConnection').returns(stubConnection)

        lspRouterStub = stubInterface<lspRouterModule.LspRouter>()
        lspRouterStub.servers = stubInterface<LspServer[]>()
        sinon.stub(lspRouterModule, 'LspRouter').returns(lspRouterStub)
    })

    afterEach(() => {
        sinon.restore()
        // Each standalone() call registers a crash-monitor listener; remove ours so repeated calls stay under MaxListeners.
        for (const listener of process.listeners('uncaughtExceptionMonitor')) {
            if (!initialCrashListeners.includes(listener)) process.removeListener('uncaughtExceptionMonitor', listener)
        }
    })

    describe('initializeAuth', () => {
        let authStub: sinon.SinonStubbedInstance<authModule.Auth> & authModule.Auth
        let chatStub: sinon.SinonStubbedInstance<encryptedChatModule.EncryptedChat> & encryptedChatModule.EncryptedChat
        let baseChatStub: sinon.SinonStubbedInstance<baseChatModule.BaseChat> & baseChatModule.BaseChat

        it('should initialize without encryption when no key is present', () => {
            sinon.stub(authEncryptionModule, 'shouldWaitForEncryptionKey').returns(false)
            authStub = stubInterface<authModule.Auth>()
            authStub.getCredentialsProvider.returns({
                hasCredentials: sinon.stub().returns(false),
                getCredentials: sinon.stub().returns(undefined),
                getConnectionMetadata: sinon.stub().returns(undefined),
                getConnectionType: sinon.stub().returns('none'),
                onCredentialsDeleted: sinon.stub(),
            })
            sinon.stub(authModule, 'Auth').returns(authStub)
            baseChatStub = stubInterface<baseChatModule.BaseChat>()
            sinon.stub(baseChatModule, 'BaseChat').returns(baseChatStub)

            standalone(props)

            sinon.assert.calledWithExactly(authModule.Auth as unknown as sinon.SinonStub, stubConnection, lspRouterStub)
            sinon.assert.calledWithExactly(
                stubConnection.console.info as sinon.SinonStub,
                'Runtime: Initializing runtime without encryption'
            )
            sinon.assert.calledWithExactly(baseChatModule.BaseChat as unknown as sinon.SinonStub, stubConnection)
            sinon.assert.calledThrice(lspRouterStub.servers.push as sinon.SinonStub)
            sinon.assert.calledOnce(stubConnection.listen)
        })

        it('should initialize with encryption when a key is provided', async () => {
            sinon.stub(authEncryptionModule, 'shouldWaitForEncryptionKey').returns(true)
            const encryptionInitialization: authEncryptionModule.EncryptionInitialization = {
                version: '1.0',
                mode: 'JWT',
                key: 'encryption_key',
            }
            sinon
                .stub(authEncryptionModule, 'readEncryptionDetails')
                .returns(
                    new Promise<authEncryptionModule.EncryptionInitialization>((resolve, _) =>
                        resolve(encryptionInitialization)
                    )
                )
            authStub = stubInterface<authModule.Auth>()
            authStub.getCredentialsProvider.returns({
                hasCredentials: sinon.stub().returns(false),
                getCredentials: sinon.stub().returns(undefined),
                getConnectionMetadata: sinon.stub().returns(undefined),
                getConnectionType: sinon.stub().returns('none'),
                onCredentialsDeleted: sinon.stub(),
            })
            sinon.stub(authModule, 'Auth').returns(authStub)
            chatStub = stubInterface<encryptedChatModule.EncryptedChat>()
            sinon.stub(encryptedChatModule, 'EncryptedChat').returns(chatStub)

            await standalone(props)

            sinon.assert.calledWithExactly(
                stubConnection.console.info as sinon.SinonStub,
                'Runtime: Initializing runtime with encryption'
            )
            sinon.assert.calledWithExactly(
                authModule.Auth as unknown as sinon.SinonStub,
                stubConnection,
                lspRouterStub,
                encryptionInitialization.key,
                encryptionInitialization.mode
            )
            sinon.assert.calledWithExactly(
                encryptedChatModule.EncryptedChat as unknown as sinon.SinonStub,
                stubConnection,
                encryptionInitialization.key,
                encryptionInitialization.mode
            )
            sinon.assert.calledThrice(lspRouterStub.servers.push as sinon.SinonStub)
            sinon.assert.calledOnce(stubConnection.listen)
        })
    })

    describe('features', () => {
        let features: Features

        beforeEach(() => {
            standalone(props)
            features = stubServer.getCall(0).args[0]
        })

        describe('Workspace', () => {
            describe('existing filesystem compatibility', () => {
                beforeEach(() => {
                    features.workspace.fs.checkedFiles = {
                        version: 1,
                        capture: sinon.stub().rejects(new Error('Unexpected capture')),
                        read: sinon.stub().rejects(new Error('Unexpected guarded read')),
                        update: sinon.stub().rejects(new Error('Unexpected guarded update')),
                    }
                })

                it('preserves readFile defaults and encoding options', async () => {
                    const read = sinon.stub(fsPromises, 'readFile').resolves('fixture')
                    assert.strictEqual(await features.workspace.fs.readFile('/workspace/file.txt'), 'fixture')
                    sinon.assert.calledWithExactly(read, '/workspace/file.txt', { encoding: 'utf-8' })
                    await features.workspace.fs.readFile('/workspace/file.txt', { encoding: 'utf16le' })
                    sinon.assert.calledWithExactly(read, '/workspace/file.txt', { encoding: 'utf16le' })
                    sinon.assert.notCalled(stubConnection.sendNotification)
                })

                it('preserves writeFile options and the existing notification', async () => {
                    const write = sinon.stub(fsPromises, 'writeFile').resolves()
                    const options = { mode: 0o600 }
                    await features.workspace.fs.writeFile('/workspace/file.txt', 'content', options)
                    sinon.assert.calledOnceWithExactly(write, '/workspace/file.txt', 'content', options)
                    sinon.assert.calledOnceWithExactly(
                        stubConnection.sendNotification,
                        didWriteFileNotificationType.method,
                        { path: '/workspace/file.txt' }
                    )
                })

                it('preserves appendFile content and its distinct notification', async () => {
                    const append = sinon.stub(fsPromises, 'appendFile').resolves()
                    await features.workspace.fs.appendFile('/workspace/file.txt', 'content')
                    sinon.assert.calledOnceWithExactly(append, '/workspace/file.txt', 'content')
                    sinon.assert.calledOnceWithExactly(
                        stubConnection.sendNotification,
                        didAppendFileNotificationType.method,
                        { path: '/workspace/file.txt' }
                    )
                })

                it('preserves write failures without sending a success notification', async () => {
                    const failure = Object.assign(new Error('Write failed'), { code: 'EACCES' })
                    sinon.stub(fsPromises, 'writeFile').rejects(failure)
                    await assert.rejects(
                        features.workspace.fs.writeFile('/workspace/file.txt', 'content'),
                        error => error === failure
                    )
                    sinon.assert.notCalled(stubConnection.sendNotification)
                })

                it('accepts providers that implement only the existing filesystem API', async () => {
                    const methods = { ...features.workspace.fs }
                    delete methods.checkedFiles
                    const previousProvider: Omit<Features['workspace']['fs'], 'checkedFiles'> = methods
                    const compatibleProvider: Features['workspace']['fs'] = previousProvider
                    sinon.stub(fsPromises, 'readFile').resolves('fixture')
                    assert.strictEqual(await compatibleProvider.readFile('/workspace/file.txt'), 'fixture')
                    assert.strictEqual(compatibleProvider.checkedFiles, undefined)
                })

                it('preserves existing read and write behavior for file aliases', async function () {
                    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'legacy-fs-'))
                    try {
                        const file = path.join(directory, 'file.txt')
                        const alias = path.join(directory, 'alias.txt')
                        await fsPromises.writeFile(file, 'before')
                        try {
                            await fsPromises.symlink(file, alias, 'file')
                        } catch (error) {
                            if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                                this.skip()
                                return
                            }
                            throw error
                        }
                        assert.strictEqual(await features.workspace.fs.readFile(alias), 'before')
                        await features.workspace.fs.writeFile(alias, 'after')
                        assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'after')
                        sinon.assert.calledOnceWithExactly(
                            stubConnection.sendNotification,
                            didWriteFileNotificationType.method,
                            { path: alias }
                        )
                    } finally {
                        await fsPromises.rm(directory, { recursive: true, force: true })
                    }
                })
            })
            // Suite-level skip rather than this.skip(): the hooks themselves do POSIX-only I/O.
            ;(process.platform !== 'win32' ? describe : describe.skip)('checked file operations', () => {
                let directory: string
                let file: string
                beforeEach(async () => {
                    directory = await fsPromises.realpath(
                        await fsPromises.mkdtemp(path.join(os.tmpdir(), 'standalone-fs-'))
                    )
                    file = path.join(directory, 'example file.txt')
                    await fsPromises.writeFile(file, 'before')
                    ;(stubConnection.sendNotification as sinon.SinonStub).resolves()
                })
                afterEach(async () => {
                    await fsPromises.rm(directory, { recursive: true, force: true })
                })

                it('uses actual checked I/O and the existing write notification', async () => {
                    const operations = features.workspace.fs.checkedFiles!
                    const target = await operations.capture(file)
                    assert.strictEqual(await operations.read(target), 'before')
                    sinon.assert.notCalled(stubConnection.sendNotification)
                    const outcome = await operations.update(target, text => text + ' after')
                    assert.strictEqual(outcome.complete, true)
                    assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'before after')
                    sinon.assert.calledOnceWithExactly(
                        stubConnection.sendNotification,
                        didWriteFileNotificationType.method,
                        { path: file }
                    )
                })

                it('does not notify or use legacy writes after identity rejection', async () => {
                    const operations = features.workspace.fs.checkedFiles!
                    const target = await operations.capture(file)
                    await fsPromises.rename(file, path.join(directory, 'original.txt'))
                    await fsPromises.writeFile(file, 'replacement')
                    const write = sinon.spy(fsPromises, 'writeFile')
                    await assert.rejects(
                        operations.update(target, () => 'changed'),
                        { code: 'ESTALE' }
                    )
                    sinon.assert.notCalled(write)
                    sinon.assert.notCalled(stubConnection.sendNotification)
                    assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'replacement')
                })

                it('refreshes after a real write followed by a close failure', async () => {
                    const operations = features.workspace.fs.checkedFiles!
                    const target = await operations.capture(file)
                    const handle = await fsPromises.open(file, 'r+')
                    const close = handle.close.bind(handle)
                    sinon.stub(fsPromises, 'open').resolves(handle)
                    sinon.stub(handle, 'close').callsFake(async () => {
                        await close()
                        throw Object.assign(new Error('Close failed'), { code: 'EIO' })
                    })
                    await assert.rejects(
                        operations.update(target, () => 'after'),
                        { code: 'EIO' }
                    )
                    assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'after')
                    sinon.assert.calledOnceWithExactly(
                        stubConnection.sendNotification,
                        didWriteFileNotificationType.method,
                        { path: file }
                    )
                })

                it('does not fail or wait on a failed or pending notification transport', async () => {
                    const operations = features.workspace.fs.checkedFiles!
                    const target = await operations.capture(file)
                    ;(stubConnection.sendNotification as sinon.SinonStub).rejects(new Error('Connection closed'))
                    assert.strictEqual((await operations.update(target, () => 'first')).complete, true)
                    ;(stubConnection.sendNotification as sinon.SinonStub).returns(new Promise<void>(() => {}))
                    assert.strictEqual((await operations.update(target, () => 'second')).complete, true)
                    sinon.assert.calledTwice(stubConnection.sendNotification)
                })
            })

            describe('fs.getTempDirPath', () => {
                it('should use /tmp path when on Darwin', () => {
                    // Only run this test on Darwin
                    if (os.type() !== 'Darwin') {
                        return // Skip on non-Darwin
                    }

                    const result = features.workspace.fs.getTempDirPath()
                    const expected = path.join('/tmp', 'aws-language-servers')

                    assert.strictEqual(result, expected)
                })

                it('should use os.tmpdir() path when on non-Darwin systems', () => {
                    // Only run this test on non-Darwin
                    if (os.type() === 'Darwin') {
                        return // Skip on Darwin
                    }

                    const result = features.workspace.fs.getTempDirPath()
                    const expected = path.join(os.tmpdir(), 'aws-language-servers')

                    assert.strictEqual(result, expected)
                })
            })

            describe('getWorkspaceFolder', () => {
                it('should return undefined when no workspace folders are configured', () => {
                    const fileUri = pathToFileURL('/sample/files').href
                    const result = features.workspace.getWorkspaceFolder(fileUri)

                    assert.strictEqual(result, undefined)
                })

                it('should return undefined when workspace folders are empty', () => {
                    const fileUri = pathToFileURL('/sample/files').href
                    lspRouterStub.getAllWorkspaceFolders = sinon.stub().returns([]) as sinon.SinonStub<
                        [],
                        vscodeLanguageServer.WorkspaceFolder[]
                    >

                    const result = features.workspace.getWorkspaceFolder(fileUri)

                    assert.strictEqual(result, undefined)
                })

                it('should return the workspace folder that contains the given file path', () => {
                    const fileUri = pathToFileURL('/sample/workspace/file.ts').href
                    let workspaceFolders = [
                        { name: 'folder1', uri: '/folder/workspace' },
                        { name: 'name', uri: '/tmp/tmp' },
                        { name: 'name1', uri: '/sample/workspace/folder' },
                        { name: 'workspace', uri: '/sample/workspace' },
                        { name: 'name2', uri: '/sample' },
                    ]
                    workspaceFolders = workspaceFolders.map(folder => ({
                        name: folder.name,
                        uri: pathToFileURL(folder.uri).href,
                    }))
                    // @ts-ignore
                    lspRouterStub.getAllWorkspaceFolders = sinon.stub().returns(workspaceFolders)

                    const result = features.workspace.getWorkspaceFolder(fileUri)

                    assert.strictEqual(result, workspaceFolders[3])
                })
            })

            describe('getAllWorkspaceFolders', () => {
                it('should return workspace folders when configured', () => {
                    let workspaceFolders = [
                        { name: 'folder1', uri: '/folder/workspace' },
                        { name: 'name', uri: '/tmp/tmp' },
                        { name: 'name1', uri: '/sample/workspace/folder' },
                        { name: 'workspace', uri: '/sample/workspace' },
                        { name: 'name2', uri: '/sample' },
                    ]
                    workspaceFolders = workspaceFolders.map(folder => ({
                        name: folder.name,
                        uri: pathToFileURL(folder.uri).href,
                    }))
                    // @ts-ignore
                    lspRouterStub.getAllWorkspaceFolders = sinon.stub().returns(workspaceFolders)
                    const result = features.workspace.getAllWorkspaceFolders()

                    assert.strictEqual(result, workspaceFolders)
                })
            })
        })

        describe('Runtime', () => {
            it('should set params from runtime properties', () => {
                assert.strictEqual(features.runtime.serverInfo.name, props.name)
                assert.strictEqual(features.runtime.serverInfo.version, props.version)
            })
        })
    })
})

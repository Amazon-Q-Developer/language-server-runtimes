import { IamCredentials, BearerCredentials, ConnectionMetadata } from '../protocol'

// Exports for Capability implementor
export { IamCredentials, BearerCredentials, ConnectionMetadata }

export type CredentialsType = 'iam' | 'bearer'
export type Credentials = IamCredentials | BearerCredentials
export type SsoConnectionType = 'builderId' | 'identityCenter' | 'external_idp' | 'none'

export interface CredentialsProvider {
    hasCredentials: (type: CredentialsType) => boolean
    getCredentials: (type: CredentialsType) => Credentials | undefined
    getConnectionMetadata: () => ConnectionMetadata | undefined
    getConnectionType: () => SsoConnectionType
    onCredentialsDeleted: (handler: (type: CredentialsType) => void) => void
    /**
     * Notifies the server that credentials of the given type have been stored, so work that depends on
     * them can start immediately rather than waiting for the first consumer to ask.
     *
     * Fired after the credentials are available from {@link getCredentials}, so a handler can read them
     * synchronously. Handlers must not throw; a throwing handler is logged and ignored so it cannot
     * fail the client's credentials request.
     *
     * Optional so that adding it is not a breaking change: this interface is implemented by test
     * doubles across several consumers, and requiring a new member would fail their builds on upgrade.
     * Servers should call it with optional chaining, which also means a server built against this
     * version still runs on an older runtime -- it simply never gets the event.
     */
    onCredentialsUpdated?: (handler: (type: CredentialsType) => void) => void
}

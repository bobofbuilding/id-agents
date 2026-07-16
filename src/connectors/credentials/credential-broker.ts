// SPDX-License-Identifier: MIT
/**
 * Credential broker seam. The real interface makes it structurally
 * impossible for a caller to receive or persist a token outside the
 * `withAccessToken` callback — the router, agent, logs, and prompts only
 * ever see an opaque ConnectionRef.
 *
 * FakeVaultCredentialBroker below is test/dev-only: it never talks to a real
 * vault or provider and is the default in this slice because no vault,
 * OAuth client, or credential storage decision has been made yet (see
 * docs/connectors/gmail-first-connector-architecture.md#open-decisions).
 * Wiring a real broker (Vault/KMS-backed) is an explicit later stage that
 * requires operator sign-off on vault choice and OAuth callback ownership.
 */

export interface ConnectionRef {
  connectionId: string;
  agentId: string;
  tenantId: string;
}

export interface OAuthStart {
  agentId: string;
  tenantId: string;
  connectorId: string;
  scopes: string[];
}

export interface OAuthChallenge {
  authorizationUrl: string;
  state: string;
}

export interface OAuthCallback {
  state: string;
  code: string;
}

export interface CredentialBroker {
  beginOAuth(input: OAuthStart): Promise<OAuthChallenge>;
  completeOAuth(input: OAuthCallback): Promise<ConnectionRef>;
  /**
   * The only way to reach a token: it is passed into `fn` and never
   * returned from this method. Implementations must not log, cache outside
   * the callback scope, or otherwise expose the resolved token.
   */
  withAccessToken<T>(connection: ConnectionRef, scopes: string[], fn: (token: string) => Promise<T>): Promise<T>;
  revoke(connection: ConnectionRef): Promise<void>;
}

/**
 * Always denies. No connection is ever considered connected, so every
 * capability that requires a live token deterministically returns
 * "not_connected" instead of attempting network access. Safe default until
 * a real vault-backed broker is wired in a later, operator-approved stage.
 */
export class FakeVaultCredentialBroker implements CredentialBroker {
  async beginOAuth(): Promise<OAuthChallenge> {
    throw new Error('FakeVaultCredentialBroker: OAuth is not configured in this environment');
  }

  async completeOAuth(): Promise<ConnectionRef> {
    throw new Error('FakeVaultCredentialBroker: OAuth is not configured in this environment');
  }

  async withAccessToken<T>(): Promise<T> {
    throw new Error('FakeVaultCredentialBroker: no credential is available for this connection');
  }

  async revoke(): Promise<void> {
    // No-op: nothing was ever connected.
  }
}

// SPDX-License-Identifier: MIT
/**
 * Gmail OAuth/API backend. This slice intentionally ships with zero live
 * network capability: `invoke` always resolves through `credentialBroker`
 * first, and the default FakeVaultCredentialBroker (see
 * ../credentials/credential-broker.ts) always throws before any fetch would
 * happen. A `fetchImpl` seam exists purely so a future real implementation
 * can inject an HTTP client without changing this file's shape; it is never
 * called unless a caller supplies a real CredentialBroker AND a real
 * fetchImpl, both of which are explicit, reviewed, later-stage wiring.
 */

import type { BackendBinding, BackendInvocation, BackendResult, ConnectorBackend, HealthResult } from './connector-backend.js';
import type { CredentialBroker } from '../credentials/credential-broker.js';

const ALLOWED_GMAIL_ORIGIN = 'https://gmail.googleapis.com';

export interface OAuthApiBackendOptions {
  credentialBroker: CredentialBroker;
  /** Injected for testability; defaults to the global fetch. Never invoked without a resolved token. */
  fetchImpl?: typeof fetch;
}

export class OAuthApiBackend implements ConnectorBackend {
  readonly kind = 'oauth_api' as const;
  private readonly credentialBroker: CredentialBroker;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OAuthApiBackendOptions) {
    this.credentialBroker = options.credentialBroker;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async validateBinding(binding: BackendBinding): Promise<void> {
    if (binding.allowlistedOrigin !== ALLOWED_GMAIL_ORIGIN) {
      throw new Error(
        `OAuthApiBackend: binding origin "${binding.allowlistedOrigin}" is not the reviewed Gmail origin`,
      );
    }
  }

  async health(binding: BackendBinding): Promise<HealthResult> {
    try {
      await this.validateBinding(binding);
      return { healthy: true };
    } catch (err) {
      return { healthy: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async invoke(ctx: BackendInvocation): Promise<BackendResult> {
    try {
      return await this.credentialBroker.withAccessToken(
        { connectionId: ctx.connection.id, agentId: ctx.connection.agentId, tenantId: ctx.connection.tenantId },
        ctx.connection.approvedScopes,
        async (_token) => {
          // Real Gmail API calls (this.fetchImpl against ALLOWED_GMAIL_ORIGIN,
          // per-capability method mapping, pagination, redaction) are Slice 5
          // work gated on an accepted vault/OAuth decision. Reaching this
          // branch requires a real CredentialBroker to have resolved a token,
          // which does not happen with FakeVaultCredentialBroker.
          throw new Error('OAuthApiBackend: live Gmail API invocation is not implemented in this slice');
        },
      );
    } catch (err) {
      return {
        ok: false,
        errorKind: 'not_connected',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

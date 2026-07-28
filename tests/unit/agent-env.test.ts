// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  isReservedAgentEnvironmentKey,
  resolveAgentEnvironment,
  sanitizeAgentEnvironment,
} from '../../src/agent-env.js';
import {
  parseManagedAllowedTools,
  parseManagedBoolean,
} from '../../src/local-agent-server.js';

describe('declarative agent environment', () => {
  it('prefers top-level env while retaining resources.env compatibility', () => {
    expect(resolveAgentEnvironment({
      resources: {
        env: {
          LEGACY_ONLY: 'legacy',
          SHARED: 'legacy',
        },
      },
      env: {
        TOP_LEVEL_ONLY: 'preferred',
        SHARED: 'preferred',
      },
    })).toEqual({
      LEGACY_ONLY: 'legacy',
      TOP_LEVEL_ONLY: 'preferred',
      SHARED: 'preferred',
    });
  });

  it('filters invalid values and every Manager-owned envelope key', () => {
    expect(sanitizeAgentEnvironment({
      APP_FEATURE_FLAG: 'enabled',
      CUSTOM_TOKEN: 'allowed',
      CUSTOM_OBJECT: { unsafe: true },
      CURSOR_AGENT_PATH: '/attacker/cursor',
      aNtHrOpIc_BaSe_Url: 'https://attacker.invalid',
      All_Proxy: 'http://attacker.invalid:8080',
      Http_Proxy: 'http://attacker.invalid:8080',
      node_extra_ca_certs: '/attacker/ca.pem',
      Node_Tls_Reject_Unauthorized: '0',
      sslKeyLogFile: '/attacker/session-keys.log',
      SSL_CERT_FILE: '/attacker/cert.pem',
      ld_library_path: '/attacker/lib',
      Ld_Audit: '/attacker/audit.so',
      provider_api_base_url: 'https://attacker.invalid',
      oLlAmA_HoSt: 'attacker.invalid',
      'INVALID-KEY': 'invalid',
      ID_AGENT_ID: 'attacker',
      id_workspace_dir: '/attacker',
      idAcc_instance_nonce: 'attacker-nonce',
      MANAGER_URL: 'http://attacker.invalid',
      OPENAI_API_KEY: 'attacker-key',
      PATH: '/attacker/bin',
      XMTP_OPEN_MODE: 'true',
    })).toEqual({
      APP_FEATURE_FLAG: 'enabled',
      CUSTOM_TOKEN: 'allowed',
    });

    expect(isReservedAgentEnvironmentKey('id_agent_id')).toBe(true);
    expect(isReservedAgentEnvironmentKey('IdAcc_Instance_Nonce')).toBe(true);
    expect(isReservedAgentEnvironmentKey('aNtHrOpIc_BaSe_Url')).toBe(true);
    expect(isReservedAgentEnvironmentKey('Http_Proxy')).toBe(true);
    expect(isReservedAgentEnvironmentKey('node_extra_ca_certs')).toBe(true);
    expect(isReservedAgentEnvironmentKey('Ld_Audit')).toBe(true);
    expect(isReservedAgentEnvironmentKey('provider_api_base_url')).toBe(true);
    expect(isReservedAgentEnvironmentKey('Custom_Token')).toBe(false);
  });
});

describe('managed local-agent envelope parsing', () => {
  it('accepts a valid allowed-tools array and preserves an explicit empty set', () => {
    expect(parseManagedAllowedTools('["Read","Grep","Read"]')).toEqual(['Read', 'Grep']);
    expect(parseManagedAllowedTools('[]')).toEqual([]);
    expect(parseManagedAllowedTools(undefined)).toBeUndefined();
  });

  it('fails malformed allowed-tools and open-mode values closed', () => {
    expect(parseManagedAllowedTools('{"Read":true}')).toEqual([]);
    expect(parseManagedAllowedTools('["Read",42]')).toEqual([]);
    expect(parseManagedAllowedTools('not-json')).toEqual([]);
    expect(parseManagedBoolean('true')).toBe(true);
    expect(parseManagedBoolean('false')).toBe(false);
    expect(parseManagedBoolean('unexpected')).toBe(false);
    expect(parseManagedBoolean(undefined)).toBeUndefined();
  });
});

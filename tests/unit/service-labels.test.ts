// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANAGER_LAUNCHD_LABEL,
  managerHealthAttestation,
  managerLaunchdLabel,
} from '../../src/lib/service-labels.js';

describe('Manager service labels', () => {
  it('uses the consumer-neutral IDACC launchd label by default', () => {
    expect(DEFAULT_MANAGER_LAUNCHD_LABEL).toBe('app.idacc.manager');
    expect(managerLaunchdLabel(undefined)).toBe(DEFAULT_MANAGER_LAUNCHD_LABEL);
    expect(DEFAULT_MANAGER_LAUNCHD_LABEL).not.toMatch(/idchain|bittrees|bobofbuilding/i);
  });

  it('preserves a deliberate deployment override and ignores blank values', () => {
    expect(managerLaunchdLabel('  com.example.private-manager  ')).toBe('com.example.private-manager');
    expect(managerLaunchdLabel('   ')).toBe(DEFAULT_MANAGER_LAUNCHD_LABEL);
  });

  it('reports the exact supervisor-provided service identity, version, and nonce', () => {
    expect(managerHealthAttestation({
      IDACC_SERVICE_ID: 'idagents-manager',
      IDACC_RUNTIME_VERSION: '0.1.143',
      IDACC_INSTANCE_NONCE: 'fresh-process-nonce',
    })).toEqual({
      service: 'idagents-manager',
      runtimeVersion: '0.1.143',
      instanceNonce: 'fresh-process-nonce',
      protocolVersion: 'idacc.health.v1',
    });
    expect(managerHealthAttestation({})).toEqual({
      protocolVersion: 'idacc.health.v1',
    });
  });
});

// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { CC_API_VERSION, CC_FEATURES, CC_ROUTES, ccCapabilities } from '../../src/control-center/manifest.js';

describe('Control Center manifest', () => {
  it('advertises manager-authoritative runtime preflight', () => {
    expect(CC_API_VERSION).toBeGreaterThanOrEqual(5);
    expect(CC_FEATURES).toContain('runtime-preflight');
    expect(CC_ROUTES).toContainEqual({
      method: 'POST',
      path: '/runtime/preflight',
      group: 'manager-controls',
    });
    expect(ccCapabilities().cc_api_version).toBe(CC_API_VERSION);
  });
});

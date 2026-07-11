// SPDX-License-Identifier: MIT

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, validateConfig } from '../../src/config-parser.js';

describe('default contributor signing config', () => {
  it('parses as disabled-by-default and validates Base-only contributor/forum policy', () => {
    const config = parseConfig(path.resolve('configs/default.yaml'));
    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(config.contributorSigning?.enabled).toBe(false);
    expect(config.contributorSigning?.chains.map(chain => chain.chainId)).toEqual([1, 8453]);
    expect(config.contributorSigning?.policies.every(policy => policy.chainId === 8453)).toBe(true);
  });
});

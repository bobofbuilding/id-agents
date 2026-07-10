// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { mergeCatalogSeed } from '../../src/agent-manager-db.js';

describe('mergeCatalogSeed', () => {
  it('preserves live PATCHed catalog fields across simulated deploy/sync reseeds', () => {
    const yamlCatalog = {
      role: 'architecture-engineer',
      status: 'available',
      contributorTitle: 'YAML title',
      profileStatus: 'seeded',
      costTier: 'medium',
    };
    const livePatchedCatalog = {
      status: 'busy',
      contributorTitle: 'Runtime title',
      profileStatus: 'in-flight',
      bittreesLanes: ['engineering', 'architecture'],
    };

    const afterDeployReseed = mergeCatalogSeed(yamlCatalog, livePatchedCatalog);
    const afterSyncReseed = mergeCatalogSeed(yamlCatalog, afterDeployReseed);

    expect(afterDeployReseed).toEqual({
      role: 'architecture-engineer',
      status: 'busy',
      contributorTitle: 'Runtime title',
      profileStatus: 'in-flight',
      costTier: 'medium',
      bittreesLanes: ['engineering', 'architecture'],
    });
    expect(afterSyncReseed).toEqual(afterDeployReseed);
  });

  it('keeps existing live values when the YAML seed contains nullish fields', () => {
    expect(mergeCatalogSeed(
      {
        role: 'seed-role',
        description: null,
        profileStatus: undefined,
        status: 'available',
      },
      {
        role: 'live-role',
        description: 'live description',
        profileStatus: 'active',
        contributorTitle: 'Runtime principal',
      },
    )).toEqual({
      role: 'live-role',
      description: 'live description',
      profileStatus: 'active',
      status: 'available',
      contributorTitle: 'Runtime principal',
    });
  });
});

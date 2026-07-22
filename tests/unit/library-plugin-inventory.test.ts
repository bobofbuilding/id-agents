import { describe, expect, it } from 'vitest';
import { pluginIsVisible } from '../../src/lib/library-inventory.js';

describe('library plugin inventory', () => {
  const optInManifest = { distribution: 'opt-in' };

  it('omits opt-in plugins from a standard fresh install', () => {
    expect(pluginIsVisible('skillmesh', optInManifest, new Set())).toBe(false);
  });

  it('surfaces an opt-in plugin only after explicit enablement', () => {
    expect(pluginIsVisible('skillmesh', optInManifest, new Set(['skillmesh']))).toBe(true);
    expect(pluginIsVisible('skillmesh', optInManifest, new Set(['*']))).toBe(true);
  });

  it('continues to surface standard plugins', () => {
    expect(pluginIsVisible('brain', { distribution: 'standard' }, new Set())).toBe(true);
    expect(pluginIsVisible('frontend-design', null, new Set())).toBe(true);
  });
});

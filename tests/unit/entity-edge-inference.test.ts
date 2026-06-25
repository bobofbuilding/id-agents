import { describe, expect, it } from 'vitest';

import { inferEntityEdges } from '../../src/lib/entity-edge-inference.js';

const entities = [
  {
    id: 'agent:coder',
    type: 'agent',
    name: 'coder',
    description: 'coder uses SkillMesh and is part of Default Team.',
    data: { parent_entity_id: 'team:default' },
  },
  {
    id: 'skill:skillmesh',
    type: 'skill',
    name: 'SkillMesh',
    description: 'SkillMesh helps coder coordinate graph updates.',
  },
  {
    id: 'team:default',
    type: 'team',
    name: 'Default Team',
  },
];

describe('inferEntityEdges', () => {
  it('idempotently infers mentions, uses, and part-of edges from entity descriptions and data', () => {
    const once = inferEntityEdges({ entities });
    const twice = inferEntityEdges({
      entities: [
        ...entities,
        entities[0],
      ],
    });

    expect(twice).toEqual(once);
    expect(once).toEqual(expect.arrayContaining([
      { from: 'agent:coder', to: 'skill:skillmesh', kind: 'mentions' },
      { from: 'agent:coder', to: 'skill:skillmesh', kind: 'uses' },
      { from: 'agent:coder', to: 'team:default', kind: 'mentions' },
      { from: 'agent:coder', to: 'team:default', kind: 'part-of' },
    ]));
    expect(new Set(once.map((edge) => `${edge.kind}:${edge.from}->${edge.to}`)).size).toBe(once.length);
  });

  it('idempotently infers pairwise mention edges from text units and timeline events', () => {
    const edges = inferEntityEdges({
      entities,
      textUnits: [
        {
          id: 1,
          title: 'Coordination note',
          content: 'coder, SkillMesh, and Default Team are all referenced here.',
        },
        {
          id: 1,
          title: 'Coordination note duplicate',
          content: 'coder, SkillMesh, and Default Team are all referenced here.',
        },
      ],
      timelineEvents: [
        {
          id: 9,
          type: 'task:completed',
          data: { message: 'Default Team saw coder finish SkillMesh work.' },
        },
      ],
      texts: [
        'Default Team asks coder to use SkillMesh.',
      ],
    });

    expect(edges).toEqual(expect.arrayContaining([
      { from: 'agent:coder', to: 'skill:skillmesh', kind: 'mentions' },
      { from: 'agent:coder', to: 'team:default', kind: 'mentions' },
      { from: 'skill:skillmesh', to: 'team:default', kind: 'mentions' },
    ]));
    const mentionKeys = edges
      .filter((edge) => edge.kind === 'mentions')
      .map((edge) => `${edge.from}->${edge.to}`);
    expect(new Set(mentionKeys).size).toBe(mentionKeys.length);
  });
});

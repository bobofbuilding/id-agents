// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import { appendSpecialistRoutingNote, inferSpecialistOwnerTeam } from '../../src/core/specialist-routing.js';

describe('inferSpecialistOwnerTeam', () => {
  it('routes high-confidence onchain Learn work out of research', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'research',
      explicitTeam: 'research',
      name: 'learn-tinyrouter-onchain-fit',
      title: 'Learn tinyrouter onchain fit',
      description: 'Goal ID: goal_mr4khc5x_lf68y\nExpected output: Onchain-lead digests wallet, Safe, treasury, and contract relevance.',
    });

    expect(decision).toMatchObject({
      ownerTeam: 'onchain-execution',
      reason: expect.stringContaining('onchain'),
    });
  });

  it('routes high-confidence security Learn work to technology-security', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'research',
      explicitTeam: 'research',
      name: 'learn-logto-security-fit',
      title: 'Security fit review for Logto Learn material',
      description: 'Goal ID: goal_mqx09y9d_acrer\nAssess auth, secrets, and abuse-path risks before adoption.',
    });

    expect(decision).toMatchObject({
      ownerTeam: 'technology-security',
      reason: expect.stringContaining('security'),
    });
  });

  it('routes high-confidence legal Learn work to legal', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'default',
      name: 'learn-license-legal-review',
      title: 'Learn repo license legal review',
      description: 'Goal ID: goal_mr4khc5x_lf68y\nCheck license, IP, and compliance constraints.',
    });

    expect(decision).toMatchObject({
      ownerTeam: 'legal',
      reason: expect.stringContaining('legal'),
    });
  });

  it('leaves research-only Learn work in research', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'research',
      explicitTeam: 'research',
      name: 'learn-medusa-research-fit',
      title: 'Learn Medusa research and fact fit',
      description: 'Goal ID: goal_mqx08wgp_m8mix\nVerify source-grounded facts and memory fit.',
    });

    expect(decision).toBeNull();
  });

  it('routes high-confidence research Learn work from default to research', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'default',
      name: 'learn-medusa-research-fit',
      title: 'Learn Medusa source-grounding research fit',
      description: 'Goal ID: goal_mqx08wgp_m8mix\nVerify primary sources, facts, and evidence quality.',
    });

    expect(decision).toMatchObject({
      ownerTeam: 'research',
      reason: expect.stringContaining('research'),
    });
  });

  it('does not auto-route mixed body-only domain signals', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'research',
      explicitTeam: 'research',
      name: 'review-possible-idacc-workflow-update',
      title: 'Review possible IDACC workflow update',
      description: 'Goal ID: goal_mr4khc5x_lf68y\nThe material includes research, onchain, operations, and security signals. Review for feature or guardrail updates.',
    });

    expect(decision).toBeNull();
  });

  it('does not reroute tasks already created in a specialist team', () => {
    const decision = inferSpecialistOwnerTeam({
      currentTeam: 'onchain-execution',
      explicitTeam: 'onchain-execution',
      name: 'learn-tinyrouter-onchain-fit',
      title: 'Learn tinyrouter onchain fit',
      description: 'Goal ID: goal_mr4khc5x_lf68y',
    });

    expect(decision).toBeNull();
  });
});

describe('appendSpecialistRoutingNote', () => {
  it('records the routing decision in the task description', () => {
    const decision = {
      ownerTeam: 'technology-security' as const,
      reason: 'high-confidence security Learn/goal routing signal',
      matchedSignals: ['security:title'],
    };

    expect(appendSpecialistRoutingNote('Base brief.', 'research', decision)).toContain(
      'Manager specialist routing: research to technology-security',
    );
  });
});

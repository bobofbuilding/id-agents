// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';

import {
  AgentRestServer,
  evaluateValidatorRecommendationRouteGuard,
} from '../../src/claude-agent-server.js';

const VALIDATOR_LOOP_PROMPT = `Event-driven validator recommendation loop triggered.

Required response:
Create a concise recommendation packet for lead.`;

async function freshServer(): Promise<{ server: AgentRestServer; baseUrl: string }> {
  const server = new AgentRestServer({
    agentName: 'researcher',
    agentIdentity: { name: 'researcher', team: 'default' },
    workingDirectory: process.cwd(),
    sharedDirectory: process.cwd(),
  });
  await server.start(0);
  const httpServer = (server as any).httpServer as { address: () => AddressInfo };
  const port = httpServer.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('validator recommendation loop route guard', () => {
  let originalManagerUrl: string | undefined;
  let server: AgentRestServer | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    originalManagerUrl = process.env.MANAGER_URL;
    delete process.env.MANAGER_URL;
    const created = await freshServer();
    server = created.server;
    baseUrl = created.baseUrl;
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    if (originalManagerUrl === undefined) delete process.env.MANAGER_URL;
    else process.env.MANAGER_URL = originalManagerUrl;
  });

  it('does not block ordinary query routing', () => {
    const guard = evaluateValidatorRecommendationRouteGuard({
      currentQuery: {
        queryId: 'query-normal',
        prompt: 'Please coordinate with another agent.',
      },
      endpoint: '/news-to',
      target: 'research-lead',
    });

    expect(guard).toBeNull();
  });

  it('blocks local /news-to during validator recommendation loop processing', async () => {
    (server as any).currentQueryExecution = {
      queryId: 'query-validator-loop',
      prompt: VALIDATOR_LOOP_PROMPT,
      from: 'manager',
    };

    const res = await fetch(`${baseUrl}/news-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'research-lead',
        message: 'APPROVE and create follow-up tasks.',
        trigger: true,
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string; query_id?: string; endpoint?: string; to?: string };
    expect(body).toMatchObject({
      error: 'validator_recommendation_routing_blocked',
      query_id: 'query-validator-loop',
      endpoint: '/news-to',
      to: 'research-lead',
    });
  });

  it('blocks local /talk-to during validator recommendation loop processing', async () => {
    (server as any).currentQueryExecution = {
      queryId: 'query-validator-loop',
      prompt: VALIDATOR_LOOP_PROMPT,
      from: 'manager',
    };

    const res = await fetch(`${baseUrl}/talk-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'lead',
        message: 'Here is the recommendation packet.',
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string; query_id?: string; endpoint?: string; to?: string };
    expect(body).toMatchObject({
      error: 'validator_recommendation_routing_blocked',
      query_id: 'query-validator-loop',
      endpoint: '/talk-to',
      to: 'lead',
    });
  });
});

// SPDX-License-Identifier: MIT
/**
 * Replies posted to /news with `in_reply_to` and no explicit `trigger`
 * field must default to triggering the receiver — so an agent that
 * already gave up on its /talk-to wait still wakes when the answer
 * eventually arrives.
 *
 * We don't drive the harness here; we only assert the /news handler's
 * dispatch decision, surfaced in its response payload (`triggered: true`
 * + a generated `query_id`). Loop safety is provided by the existing
 * `noAutoReply: true` flag the handler passes through to startQuery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { AgentRestServer } from '../../src/claude-agent-server.js';
import type { AgentHarness, HarnessMessage, HarnessOptions, HarnessType } from '../../src/harness/index.js';

class ImmediateHarness implements AgentHarness {
  readonly type = 'claude-code-cli' as HarnessType;

  async *run(_prompt: string, _options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    yield { type: 'result', result: 'processed triggered news' };
  }
}

async function freshServer(): Promise<{ server: AgentRestServer; baseUrl: string }> {
  const server = new AgentRestServer({
    agentName: 'news-default-trigger-test',
    workingDirectory: process.cwd(),
    sharedDirectory: process.cwd(),
  });
  await server.start(0);
  const httpServer = (server as any).httpServer as { address: () => AddressInfo };
  const port = httpServer.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('POST /news — trigger default for replies', () => {
  let server: AgentRestServer | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    const created = await freshServer();
    server = created.server;
    baseUrl = created.baseUrl;
  });

  afterEach(async () => {
    delete process.env.ID_AGENT_NEWS_TRIGGER_MESSAGE_CHARS;
    if (server) await server.stop();
    server = null;
  });

  it('triggers when in_reply_to is present and trigger is omitted', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        in_reply_to: 'qid-from-a',
        message: 'long-running answer arrives after caller hung up',
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { triggered?: boolean; query_id?: string };
    expect(body.triggered).toBe(true);
    expect(body.query_id).toMatch(/^news_/);
  });

  it('does not trigger when caller explicitly opts out with trigger:false', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        in_reply_to: 'qid-from-a',
        message: 'silent reply',
        trigger: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { triggered?: boolean };
    expect(body.triggered).toBe(false);
  });

  it('does not trigger plain inbound messages with no in_reply_to', async () => {
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-b',
        message: 'just an FYI, no reply expected',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { triggered?: boolean };
    expect(body.triggered).toBe(false);
  });

  it('prewrites a pending query row before accepting triggered news work', async () => {
    if (server) await server.stop();
    server = null;

    const db: any = {
      queries: {
        upsert: vi.fn(async () => undefined),
      },
      news: {
        add: vi.fn(async () => undefined),
      },
    };
    const dbServer = new AgentRestServer({
      agentName: 'news-pending-row-test',
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness: new ImmediateHarness(),
    });
    await dbServer.start(0);
    server = dbServer;
    const httpServer = (server as any).httpServer as { address: () => AddressInfo };
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'checkin-service',
        trigger: true,
        skip_persist: true,
        type: 'checkin_due',
        message: 'Checkin due (normal) - task-a',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { triggered?: boolean; query_id?: string };
    expect(body.triggered).toBe(true);
    expect(body.query_id).toMatch(/^news_/);
    expect(db.queries.upsert).toHaveBeenCalled();
    expect(db.queries.upsert.mock.calls[0]).toEqual([
      'team-1',
      'agent-1',
      expect.objectContaining({
        query_id: body.query_id,
        status: 'pending',
        prompt: expect.stringContaining('[Incoming Message from "checkin-service"]'),
      }),
    ]);
  });

  it('bounds automatic checkin wake prompts before prewriting the query row', async () => {
    if (server) await server.stop();
    server = null;
    process.env.ID_AGENT_NEWS_TRIGGER_MESSAGE_CHARS = '320';

    const db: any = {
      queries: {
        upsert: vi.fn(async () => undefined),
      },
      news: {
        add: vi.fn(async () => undefined),
      },
    };
    const dbServer = new AgentRestServer({
      agentName: 'news-bounded-checkin-test',
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
      db: { db, teamId: 'team-1', agentId: 'agent-1' },
      harness: new ImmediateHarness(),
    });
    await dbServer.start(0);
    server = dbServer;
    const httpServer = (server as any).httpServer as { address: () => AddressInfo };
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    const tailMarker = 'TAIL_MARKER_SHOULD_NOT_REACH_TRIGGER_PROMPT';
    const res = await fetch(`${baseUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'checkin-service',
        trigger: true,
        skip_persist: true,
        type: 'checkin_due',
        message: `Checkin due (normal) - task-a\n${'x'.repeat(600)}\n${tailMarker}`,
      }),
    });

    expect(res.status).toBe(202);
    const pendingCall = db.queries.upsert.mock.calls.find((call: any[]) => call[2]?.status === 'pending');
    const prompt = pendingCall?.[2]?.prompt as string;
    expect(prompt).toContain('[Incoming Message from "checkin-service"]');
    expect(prompt).toContain('[message truncated:');
    expect(prompt).toContain('INBOUND WAKE BOUNDARY');
    expect(prompt).toContain('AUTOMATED CHECK-IN BOUNDARY');
    expect(prompt).toContain('Produce the smallest useful action/result');
    expect(prompt).not.toContain(tailMarker);
    expect(prompt).not.toContain('What would you like to do');
  });
});

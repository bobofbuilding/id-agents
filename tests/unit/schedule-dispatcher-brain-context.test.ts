// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { ScheduleDispatcher } from '../../src/scheduling/schedule-dispatcher.js';
import type { ScheduleDefinitionRow } from '../../src/db/types.js';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

function startServer(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void): Promise<http.Server> {
  return new Promise(async (resolve) => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        handler(req, body, res);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server: http.Server): string {
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

const originalBrainUrl = process.env.BRAIN_URL;
const originalBrainToken = process.env.BRAIN_TOKEN;
const originalDisabled = process.env.BRAIN_CONTEXT_DISABLED;

afterEach(() => {
  if (originalBrainUrl === undefined) delete process.env.BRAIN_URL;
  else process.env.BRAIN_URL = originalBrainUrl;
  if (originalBrainToken === undefined) delete process.env.BRAIN_TOKEN;
  else process.env.BRAIN_TOKEN = originalBrainToken;
  if (originalDisabled === undefined) delete process.env.BRAIN_CONTEXT_DISABLED;
  else process.env.BRAIN_CONTEXT_DISABLED = originalDisabled;
});

describe('ScheduleDispatcher Brain context', () => {
  it('appends volunteered cited bundles to scheduled dispatch payloads', async () => {
    const received = { brain: [] as any[], agent: [] as any[] };
    const brain = await startServer((req, body, res) => {
      received.brain.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          bundles: [{
            query: 'deployment',
            entities: [{ id: 'skill:deploy', name: 'Deployment' }],
            facts: [{ id: 9, entity_id: 'skill:deploy', field: 'status', value: 'ready' }],
            textUnits: [{ id: 12, title: 'Deploy note', content: 'Use the release checklist.' }],
          }],
          cited: { canonical_source_ids: ['entity:skill:deploy', 'fact:9', 'text:12'] },
          timelineEventId: 44,
        },
      }));
    });
    const agent = await startServer((_req, body, res) => {
      received.agent.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    process.env.BRAIN_URL = serverUrl(brain);
    process.env.BRAIN_TOKEN = 'scheduler-token';
    delete process.env.BRAIN_CONTEXT_DISABLED;

    try {
      const dispatcher = new ScheduleDispatcher();
      const def: ScheduleDefinitionRow = {
        id: 'sched-1',
        kind: 'heartbeat',
        title: 'Heartbeat',
        description: null,
        active: true,
        message: 'review deployment state',
        sender: 'schedule',
        delivery_mode: 'talk',
        timezone: null,
        catch_up_policy: 'skip',
        dedupe_window_seconds: 60,
        interval_seconds: 60,
        anchor_at: null,
        max_runs: null,
        expires_at: null,
        local_time_seconds: null,
        local_date: null,
        days_of_week: null,
        source_type: 'test',
        source_key: 'test:sched-1',
        created_at: 1,
        updated_at: 1,
      };

      const result = await dispatcher.dispatch(
        def,
        {
          id: 'agent-coder',
          name: 'coder',
          endpoint: serverUrl(agent),
          talkPath: '/talk',
          schedulePath: null,
          status: 'running',
        },
        'interval:1',
      );

      expect(result.success).toBe(true);
      expect(received.brain[0]).toMatchObject({
        url: '/context/volunteer',
        body: {
          agent_id: 'agent-coder',
          text: 'review deployment state',
          limit: 3,
        },
      });
      expect(received.brain[0].headers.authorization).toBe('Bearer scheduler-token');
      expect(received.agent[0].message).toContain('Brain context:');
      expect(received.agent[0].message).toContain('[text:12]');
      expect(received.agent[0].brain_context.cited.canonical_source_ids).toEqual(['entity:skill:deploy', 'fact:9', 'text:12']);
    } finally {
      await new Promise<void>((resolve) => brain.close(() => resolve()));
      await new Promise<void>((resolve) => agent.close(() => resolve()));
    }
  });
});

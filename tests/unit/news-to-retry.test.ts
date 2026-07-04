// SPDX-License-Identifier: MIT

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRestServer } from '../../src/claude-agent-server.js';

async function startHttpServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopHttpServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readJson(res: Response): Promise<any> {
  return res.json();
}

describe('AgentRestServer /news-to retry', () => {
  let originalManagerUrl: string | undefined;
  let agentServer: AgentRestServer | null = null;
  let managerServer: http.Server | null = null;
  let targetServer: http.Server | null = null;

  afterEach(async () => {
    if (agentServer) await agentServer.stop();
    await stopHttpServer(managerServer);
    await stopHttpServer(targetServer);
    agentServer = null;
    managerServer = null;
    targetServer = null;
    if (originalManagerUrl === undefined) delete process.env.MANAGER_URL;
    else process.env.MANAGER_URL = originalManagerUrl;
  });

  it('preserves team headers when notifying the manager', async () => {
    originalManagerUrl = process.env.MANAGER_URL;

    const managerHits: Array<{ team?: string; body: any }> = [];
    const manager = await startHttpServer((req, res) => {
      if (req.url !== '/news' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        managerHits.push({
          team: req.headers['x-id-team'] as string | undefined,
          body: raw ? JSON.parse(raw) : null,
        });
        res.statusCode = 202;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });
    managerServer = manager.server;
    process.env.MANAGER_URL = manager.baseUrl;

    agentServer = new AgentRestServer({
      agentName: 'sender',
      agentIdentity: { name: 'sender', team: 'engineering-team' },
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
    });
    await agentServer.start(0);
    const port = ((agentServer as any).httpServer as { address: () => AddressInfo }).address().port;
    const agentBaseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${agentBaseUrl}/news-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'manager',
        message: 'manager notify',
        trigger: true,
      }),
    });

    expect(res.status).toBe(202);
    expect(await readJson(res)).toMatchObject({
      success: true,
      delivered_to: 'manager',
      status: 'delivered',
    });
    expect(managerHits).toHaveLength(1);
    expect(managerHits[0]).toMatchObject({
      team: 'engineering-team',
      body: {
        type: 'notify',
        message: 'manager notify',
        trigger: true,
        reply_expected: false,
      },
    });
  });

  it('retries agent-target notify delivery once and refreshes the manager catalog before retrying', async () => {
    originalManagerUrl = process.env.MANAGER_URL;

    let targetHits = 0;
    const target = await startHttpServer((req, res) => {
      if (req.url !== '/news' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      targetHits += 1;
      res.statusCode = targetHits === 1 ? 503 : 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: targetHits > 1 }));
    });
    targetServer = target.server;

    let agentLookups = 0;
    const manager = await startHttpServer((req, res) => {
      if (req.url !== '/agents' || req.method !== 'GET') {
        res.statusCode = 404;
        res.end();
        return;
      }
      agentLookups += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        agents: [
          {
            id: 'worker-1',
            name: 'worker',
            url: target.baseUrl,
            internal_url: target.baseUrl,
          },
        ],
      }));
    });
    managerServer = manager.server;
    process.env.MANAGER_URL = manager.baseUrl;

    agentServer = new AgentRestServer({
      agentName: 'sender',
      agentIdentity: { name: 'sender', team: 'default' },
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
    });
    await agentServer.start(0);
    const port = ((agentServer as any).httpServer as { address: () => AddressInfo }).address().port;
    const agentBaseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${agentBaseUrl}/news-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'worker',
        message: 'retry me',
        trigger: true,
      }),
    });

    expect(res.status).toBe(202);
    expect(await readJson(res)).toMatchObject({
      success: true,
      to: 'worker',
      status: 'accepted',
    });

    await vi.waitFor(() => {
      expect(targetHits).toBe(2);
      expect(agentLookups).toBe(2);
    }, { timeout: 3000 });
  });

  it('records a failed outbound notify when both delivery attempts fail', async () => {
    originalManagerUrl = process.env.MANAGER_URL;

    let targetHits = 0;
    const target = await startHttpServer((req, res) => {
      if (req.url !== '/news' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }
      targetHits += 1;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'still unavailable' }));
    });
    targetServer = target.server;

    const manager = await startHttpServer((req, res) => {
      if (req.url !== '/agents' || req.method !== 'GET') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        agents: [
          {
            id: 'worker-1',
            name: 'worker',
            url: target.baseUrl,
            internal_url: target.baseUrl,
          },
        ],
      }));
    });
    managerServer = manager.server;
    process.env.MANAGER_URL = manager.baseUrl;

    agentServer = new AgentRestServer({
      agentName: 'sender',
      agentIdentity: { name: 'sender', team: 'default' },
      workingDirectory: process.cwd(),
      sharedDirectory: process.cwd(),
    });
    await agentServer.start(0);
    const port = ((agentServer as any).httpServer as { address: () => AddressInfo }).address().port;
    const agentBaseUrl = `http://127.0.0.1:${port}`;

    const res = await fetch(`${agentBaseUrl}/news-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: 'worker',
        message: 'this one will fail',
      }),
    });

    expect(res.status).toBe(202);

    await vi.waitFor(async () => {
      expect(targetHits).toBe(2);
      const newsRes = await fetch(`${agentBaseUrl}/news`);
      expect(newsRes.status).toBe(200);
      const body = await readJson(newsRes) as { items?: Array<{ type?: string; data?: Record<string, unknown> }> };
      expect(body.items?.some((item) =>
        item.type === 'outbound.notify_failed'
        && item.data?.to === 'worker'
        && item.data?.attempts === 2,
      )).toBe(true);
    }, { timeout: 3000 });
  });
});

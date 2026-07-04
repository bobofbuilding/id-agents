// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { AgentManagerDb } from '../../src/agent-manager-db.js';

async function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test port');
  return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe('AgentManagerDb startup port guard', () => {
  const workDirs: string[] = [];

  afterEach(() => {
    for (const dir of workDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects occupied manager ports before installing startup services', async () => {
    const { server: blocker, port } = await listenOnFreePort();
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-port-guard-'));
    workDirs.push(workDir);
    const manager = new AgentManagerDb(workDir, {} as any, { libraryRoot: null }) as any;
    const reconcileSpy = vi.spyOn(manager, 'reconcileDefaultCoderRuntimeFromConfig');

    try {
      const started = manager.start(port);
      await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(manager.schedulerService).toBeNull();
      expect(manager.checkinService).toBeNull();
      expect(reconcileSpy).not.toHaveBeenCalled();
    } finally {
      reconcileSpy.mockRestore();
      await manager.shutdown();
      await closeServer(blocker);
    }
  });
});

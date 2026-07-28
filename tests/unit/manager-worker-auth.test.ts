// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { AgentManagerDb } from '../../src/agent-manager-db.js';
import {
  MANAGER_AGENT_TOKEN_ENV,
  MANAGER_TASK_RECEIPT_TTL_MS,
  captureManagerServiceToken,
  deriveManagerAgentToken,
  issueManagerTaskReceipt,
  managerAgentBearerMatches,
  managerServiceBearerMatches,
  managerWorkerRequestHeaders,
  validateManagerServiceToken,
  verifyManagerTaskReceipt,
} from '../../src/manager-worker-auth.js';

const ADMIN_TOKEN = 'manager-only-admin-root';
const SERVICE_TOKEN = 'service-root-00000000000000000000000000000000';

const saved = new Map<string, string | undefined>();
const ENV_KEYS = [
  'IDACC_ADMIN_TOKEN',
  'IDACC_MANAGER_SERVICE_TOKEN',
  MANAGER_AGENT_TOKEN_ENV,
  'ID_AGENT_ID',
  'ID_DB_AGENT_ID',
  'ID_AGENT_TEAM',
  'ID_TEAM',
] as const;

function rememberEnv(): void {
  if (saved.size > 0) return;
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('managed Manager service and worker credentials', () => {
  it('fails Manager construction closed when the managed service token is missing or malformed', () => {
    rememberEnv();
    process.env.IDACC_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.IDACC_MANAGER_SERVICE_TOKEN;
    expect(() => new AgentManagerDb('/tmp/unused-manager-auth', {} as any, {
      libraryRoot: null,
    })).toThrow(/IDACC_MANAGER_SERVICE_TOKEN is required/);
    expect(process.env.IDACC_ADMIN_TOKEN).toBeUndefined();
    expect(process.env.IDACC_MANAGER_SERVICE_TOKEN).toBeUndefined();

    process.env.IDACC_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.IDACC_MANAGER_SERVICE_TOKEN = 'short-placeholder';
    expect(() => new AgentManagerDb('/tmp/unused-manager-auth', {} as any, {
      libraryRoot: null,
    })).toThrow(/random 32-4096 byte value/);
    expect(process.env.IDACC_MANAGER_SERVICE_TOKEN).toBeUndefined();

    process.env.IDACC_ADMIN_TOKEN = SERVICE_TOKEN;
    process.env.IDACC_MANAGER_SERVICE_TOKEN = SERVICE_TOKEN;
    expect(() => new AgentManagerDb('/tmp/unused-manager-auth', {} as any, {
      libraryRoot: null,
    })).toThrow(/must be distinct/);
  });

  it('captures the base service secret while leaving standalone behavior unconfigured', () => {
    const managedEnv = {
      IDACC_ADMIN_TOKEN: ADMIN_TOKEN,
      IDACC_MANAGER_SERVICE_TOKEN: SERVICE_TOKEN,
    };
    expect(captureManagerServiceToken(
      managedEnv,
      true,
      ADMIN_TOKEN,
    )).toBe(SERVICE_TOKEN);
    expect(managedEnv).not.toHaveProperty('IDACC_MANAGER_SERVICE_TOKEN');

    const standaloneEnv = {
      IDACC_MANAGER_SERVICE_TOKEN: SERVICE_TOKEN,
      PATH: '/usr/bin',
    };
    expect(captureManagerServiceToken(standaloneEnv, false)).toBe('');
    expect(standaloneEnv).toEqual({ PATH: '/usr/bin' });
  });

  it('rejects weak service secrets and compares the service bearer exactly', () => {
    expect(() => validateManagerServiceToken('a'.repeat(31))).toThrow();
    expect(() => validateManagerServiceToken(`${'a'.repeat(32)} `)).toThrow();
    expect(validateManagerServiceToken(SERVICE_TOKEN)).toBe(SERVICE_TOKEN);
    expect(managerServiceBearerMatches(
      `Bearer ${SERVICE_TOKEN}`,
      SERVICE_TOKEN,
    )).toBe(true);
    expect(managerServiceBearerMatches(SERVICE_TOKEN, SERVICE_TOKEN)).toBe(false);
    expect(managerServiceBearerMatches('Bearer wrong', SERVICE_TOKEN)).toBe(false);
  });

  it('binds worker credentials to manager-only root, team, agent, and generation', () => {
    const token = deriveManagerAgentToken(
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-1',
    );
    expect(token).not.toBe(ADMIN_TOKEN);
    expect(token).not.toBe(SERVICE_TOKEN);
    expect(managerAgentBearerMatches(
      `Bearer ${token}`,
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-1',
    )).toBe(true);
    expect(managerAgentBearerMatches(
      `Bearer ${token}`,
      ADMIN_TOKEN,
      'team-2',
      'agent-1',
      'generation-1',
    )).toBe(false);
    expect(managerAgentBearerMatches(
      `Bearer ${token}`,
      ADMIN_TOKEN,
      'team-1',
      'agent-2',
      'generation-1',
    )).toBe(false);
    expect(managerAgentBearerMatches(
      `Bearer ${token}`,
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-2',
    )).toBe(false);
    expect(managerAgentBearerMatches(
      `Bearer ${deriveManagerAgentToken(
        SERVICE_TOKEN,
        'team-1',
        'agent-1',
        'generation-1',
      )}`,
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-1',
    )).toBe(false);
  });

  it('adds derived worker headers without leaking or weakening standalone calls', () => {
    const standalone = { Accept: 'application/json' };
    expect(managerWorkerRequestHeaders(standalone, {
      ID_AGENT_ID: 'agent-1',
      ID_TEAM: 'team-1',
    })).toEqual(standalone);

    const token = deriveManagerAgentToken(
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-1',
    );
    const headers = managerWorkerRequestHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer attacker',
      'X-Id-Agent': 'attacker',
      'X-Id-Team': 'attacker-team',
    }, {
      [MANAGER_AGENT_TOKEN_ENV]: token,
      ID_AGENT_ID: 'agent-1',
      ID_TEAM: 'team-1',
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Id-Agent': 'agent-1',
      'X-Id-Team': 'team-1',
    });
    expect(JSON.stringify(headers)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(headers)).not.toContain(SERVICE_TOKEN);
  });

  it('issues bounded target-only task receipts without disclosing the worker bearer', () => {
    const workerBearer = deriveManagerAgentToken(
      ADMIN_TOKEN,
      'team-1',
      'agent-1',
      'generation-1',
    );
    const issuedAt = 10_000;
    const receipt = issueManagerTaskReceipt(workerBearer, {
      team_id: 'team-1',
      owner_agent_id: 'agent-1',
      task_name: 'canonical-task',
      task_uuid: '11111111-1111-4111-8111-111111111111',
      assignment_id: '22222222-2222-4222-8222-222222222222',
    }, issuedAt);

    expect(receipt).not.toContain(workerBearer);
    expect(verifyManagerTaskReceipt(receipt, workerBearer, issuedAt)).toMatchObject({
      version: 1,
      team_id: 'team-1',
      owner_agent_id: 'agent-1',
      task_name: 'canonical-task',
      task_uuid: '11111111-1111-4111-8111-111111111111',
      assignment_id: '22222222-2222-4222-8222-222222222222',
      issued_at: issuedAt,
      expires_at: issuedAt + MANAGER_TASK_RECEIPT_TTL_MS,
    });
    expect(verifyManagerTaskReceipt(
      receipt,
      deriveManagerAgentToken(
        ADMIN_TOKEN,
        'team-1',
        'agent-2',
        'generation-1',
      ),
      issuedAt,
    )).toBeNull();
    expect(verifyManagerTaskReceipt(
      receipt,
      workerBearer,
      issuedAt + MANAGER_TASK_RECEIPT_TTL_MS,
    )).toBeNull();
    expect(verifyManagerTaskReceipt(`${receipt}tampered`, workerBearer, issuedAt)).toBeNull();
    expect(() => issueManagerTaskReceipt(workerBearer, {
      team_id: 'team-1',
      owner_agent_id: 'agent-1',
      task_name: 'INVALID TASK NAME',
      task_uuid: '11111111-1111-4111-8111-111111111111',
      assignment_id: '22222222-2222-4222-8222-222222222222',
    }, issuedAt)).toThrow(/claims are invalid/);
  });
});

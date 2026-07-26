import { describe, expect, it } from 'vitest';
import { parseControlBrainRequest, redactControlBrainValue } from '../src/control-center/brain-relay.js';
import { configEventForRequest } from '../src/agent-manager-db.js';

describe('control-center Brain relay contract', () => {
  it('accepts allowlisted reads and acknowledged writes', () => {
    expect(parseControlBrainRequest({ method: 'GET', path: '/skills/index?limit=1' })).toEqual({
      method: 'GET',
      path: '/skills/index?limit=1',
    });
    expect(parseControlBrainRequest({ method: 'GET', path: '/memory/tiers' })).toEqual({
      method: 'GET',
      path: '/memory/tiers',
    });
    expect(parseControlBrainRequest({
      method: 'GET',
      path: '/timeline?type=control%3Atest&source=idacc&since=00042&limit=005',
    })).toEqual({
      method: 'GET',
      path: '/timeline?type=control%3Atest&source=idacc&since=42&limit=5',
    });
    expect(parseControlBrainRequest({
      method: 'POST',
      path: '/timeline',
      idempotency_key: 'idacc:phase1:0001',
      body: { type: 'control:test' },
    })).toMatchObject({ method: 'POST', path: '/timeline', idempotency_key: 'idacc:phase1:0001' });
    expect(parseControlBrainRequest({
      method: 'POST',
      path: '/learning-tasks',
      idempotency_key: 'idacc:brain-review:0001',
      body: { kind: 'skill.evidence.repair', approval_id: 1515 },
    })).toMatchObject({ method: 'POST', path: '/learning-tasks', idempotency_key: 'idacc:brain-review:0001' });
  });

  it('rejects arbitrary proxy targets and writes without idempotency', () => {
    expect(() => parseControlBrainRequest({ method: 'GET', path: 'https://example.com' })).toThrow('invalid_brain_path');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/admin/export' })).toThrow('brain_path_not_allowed');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/timeline' })).toThrow('invalid_brain_timeline_query');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/timeline?limit=0' })).toThrow('invalid_brain_timeline_query');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/timeline?limit=101' })).toThrow('invalid_brain_timeline_query');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/timeline?limit=5&limit=6' })).toThrow('invalid_brain_timeline_query');
    expect(() => parseControlBrainRequest({ method: 'GET', path: '/timeline?cursor=secret&limit=5' })).toThrow('invalid_brain_timeline_query');
    expect(() => parseControlBrainRequest({ method: 'POST', path: '/learning-tasks/1515', idempotency_key: 'idacc:brain-review:0002', body: {} })).toThrow('brain_path_not_allowed');
    expect(() => parseControlBrainRequest({ method: 'POST', path: '/timeline', body: {} })).toThrow('invalid_idempotency_key');
  });

  it('redacts nested credentials and private keys before journaling or forwarding', () => {
    expect(redactControlBrainValue({
      token: 'secret-token',
      nested: { api_key: 'secret-key', safe: 'visible' },
      signer: `0x${'a'.repeat(64)}`,
    })).toEqual({
      token: '[redacted]',
      nested: { api_key: '[redacted]', safe: 'visible' },
      signer: '[redacted-hex-secret]',
    });
    expect(redactControlBrainValue({
      events: [{
        id: 1,
        data: {
          authorization: 'Bearer private-value',
          nested: { access_token: 'private-value', summary: 'visible' },
        },
      }],
    })).toEqual({
      events: [{
        id: 1,
        data: {
          authorization: '[redacted]',
          nested: { access_token: '[redacted]', summary: 'visible' },
        },
      }],
    });
  });
});

describe('config event classification', () => {
  it('extracts concrete subjects before Express route params are populated', () => {
    const req = (path: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}, method = 'POST') => ({ method, path, body, headers }) as any;
    expect(configEventForRequest(req('/agents/agent_123/runtime'))).toMatchObject({ topic: 'config:agent-updated', subject: 'agent_123' });
    expect(configEventForRequest(req('/agents/by-name/research-lead/metadata'))).toMatchObject({ topic: 'config:agent-updated', subject: 'research-lead' });
    expect(configEventForRequest(req('/teams/engineering-team/delegates'))).toMatchObject({ topic: 'config:team-updated', subject: 'engineering-team' });
    expect(configEventForRequest(req('/deploy', {}, { 'x-id-team': 'default' }))).toMatchObject({ topic: 'config:team-deploy', subject: 'default' });
    expect(configEventForRequest(req('/agents/agent_123/onchain/register'))).toMatchObject({ topic: 'config:agent-updated', subject: 'agent_123' });
    expect(configEventForRequest(req('/agents/by-name/research-lead', {}, {}, 'DELETE'))).toMatchObject({ topic: 'config:agent-removed', subject: 'research-lead' });
    expect(configEventForRequest(req('/teams/research', {}, {}, 'DELETE'))).toMatchObject({ topic: 'config:team-removed', subject: 'research' });
  });
});

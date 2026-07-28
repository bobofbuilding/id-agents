// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  mergeDefaults,
  parseConfig,
  parseCatalogMarkdown,
  parseTeamConfig,
  processConfig,
  resolveCatalogFile,
  resolveConfigLibraryRoot,
  resolveLibraryAgentPath,
  validateConfig,
} from '../../src/config-parser.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-team-config-'));
}

describe('team-config parser helpers', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('parses a foundry-demo style config with name and agent', () => {
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'configs', 'foundry-demo.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `name: foundry-demo

agents:
  - name: solidity-dev
    runtime: claude-code-cli
    workingDirectory: ~/projects/demo-solidity
    agent: foundry-dev
`);

    const config = parseTeamConfig(configPath);
    expect(config.name).toBe('foundry-demo');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].agent).toBe('foundry-dev');
  });

  it('resolves env placeholders without parameters or YAML retyping/injection', () => {
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'team.yaml');
    const envName = 'ID_AGENTS_TEAM_CONFIG_OPAQUE_TEST';
    const previous = process.env[envName];
    const opaque = 'true # still data: "quoted"\\path\nnext: must-not-be-a-key';
    process.env[envName] = opaque;
    fs.writeFileSync(configPath, `version: "1"
agents:
  - name: worker
    env:
      CUSTOM_API_TOKEN: \${env:${envName}}
`);
    try {
      const deploy = parseConfig(configPath);
      const team = parseTeamConfig(configPath);
      expect(deploy.agents[0].env?.CUSTOM_API_TOKEN).toBe(opaque);
      expect(team.agents[0].env?.CUSTOM_API_TOKEN).toBe(opaque);
      expect((team.agents[0].env as any).next).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  it('preserves typed exact parameters, timestamp scalars, and unrelated template literals', () => {
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'typed-team.yaml');
    fs.writeFileSync(configPath, `version: "1"
parameters:
  - name: seconds
  - name: wallet
calendar:
  - title: release
    date: 2026-07-28
    time: "10:00"
    agents: [worker]
agents:
  - name: worker
    heartbeat: \${seconds}
    wallet: \${wallet}
    description: 'consumer literal \${UNDECLARED_TEMPLATE}'
`);

    const config = parseConfig(configPath, ['seconds=15', 'wallet=false']);
    expect(config.agents[0].heartbeat).toBe(15);
    expect(config.agents[0].wallet).toBe(false);
    expect(config.agents[0].description).toContain('${UNDECLARED_TEMPLATE}');
    expect((config.calendar?.[0] as any).date).toBeInstanceOf(Date);
  });

  it('defaults the library root to the config parent directory', () => {
    const configPath = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
    expect(resolveConfigLibraryRoot(configPath)).toBe('/Users/nxt3d/projects/id2/public-agents/configs');
  });

  it('resolves agent references under <library-root>/agents/<agent>', () => {
    const configPath = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
    expect(resolveLibraryAgentPath(configPath, 'foundry-dev')).toBe(
      '/Users/nxt3d/projects/id2/public-agents/configs/agents/foundry-dev'
    );
  });

  it('rejects non-string agent values in deploy config validation', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'solidity-dev', agent: 42 as unknown as string }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].agent',
      message: 'agent must be a string',
    });
  });

  it('validates stable identity keys as unique, explicit agent-only values', () => {
    const valid = validateConfig({
      version: '1',
      agents: [
        { name: 'builder', identityKey: 'builder-v1' },
        { name: 'auditor', identityKey: 'security.audit_2' },
      ],
    });
    expect(valid).toEqual({ valid: true, errors: [] });

    for (const identityKey of ['', ' builder', 'Builder', 'builder/key', 'builder-']) {
      const invalid = validateConfig({
        version: '1',
        agents: [{ name: 'builder', identityKey }],
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.map((error) => error.path)).toContain('agents[0].identityKey');
    }

    const duplicate = validateConfig({
      version: '1',
      agents: [
        { name: 'builder', identityKey: 'worker-v1' },
        { name: 'auditor', identityKey: 'worker-v1' },
      ],
    });
    expect(duplicate.errors).toContainEqual({
      path: 'agents[1].identityKey',
      message: 'identityKey "worker-v1" is already used by agents[0]',
    });

    const inherited = validateConfig({
      version: '1',
      defaults: { identityKey: 'shared-worker' } as any,
      agents: [{ name: 'builder' }],
    });
    expect(inherited.errors).toContainEqual({
      path: 'defaults.identityKey',
      message: 'identityKey is agent-only and cannot be inherited from defaults',
    });

    expect(mergeDefaults(
      { name: 'renamed-builder', identityKey: 'builder-v1' },
      { model: 'gpt-5' },
    )).toMatchObject({
      name: 'renamed-builder',
      identityKey: 'builder-v1',
      model: 'gpt-5',
    });
  });

  it('rejects duplicate effective names and domains even with different identity keys', () => {
    const duplicateName = validateConfig({
      version: '1',
      agents: [
        { name: 'worker', identityKey: 'worker-a' },
        { name: 'WORKER', identityKey: 'worker-b' },
      ],
    });
    expect(duplicateName.errors).toContainEqual({
      path: 'agents[1].name',
      message: 'name "WORKER" conflicts with agents[0].name',
    });

    const duplicateDomain = validateConfig({
      version: '1',
      agents: [
        { name: 'worker-a', domain: 'shared.xid.eth', identityKey: 'worker-a' },
        { name: 'worker-b', domain: 'SHARED.XID.ETH', identityKey: 'worker-b' },
      ],
    });
    expect(duplicateDomain.errors).toContainEqual({
      path: 'agents[1].domain',
      message: 'domain "SHARED.XID.ETH" conflicts with agents[0].domain',
    });
  });

  it('rejects canonically equivalent ENS domains before deployment', () => {
    const result = validateConfig({
      version: '1',
      agents: [
        { name: 'composed', domain: 'é.eth' },
        { name: 'decomposed', domain: 'e\u0301.eth' },
      ],
    });

    expect(result.errors).toContainEqual({
      path: 'agents[1].domain',
      message: 'domain "é.eth" conflicts with agents[0].domain',
    });
  });

  it('reports a non-string agent name without throwing', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 42 as any }],
    });

    expect(result.errors).toContainEqual({
      path: 'agents[0].name',
      message: 'agent name must contain only alphanumeric characters, hyphens, and underscores',
    });
  });

  it('parses v3 peer `agent:` and `skills:` as siblings on the same agent entry', () => {
    // Slice-2/5 v3 surface contract — `agent:` selects one
    // configs/agents/<name>/ entry and `skills:` selects zero or more
    // configs/skills/<name>/ entries. The two are peers on the agent
    // entry, NOT nested under each other. Regressing this shape would
    // silently break library-backed teams.
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'configs', 'solidity-pair.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        'version: "1"',
        'team: solidity-pair',
        '',
        'agents:',
        '  - name: builder',
        '    agent: foundry-dev',
        '    skills:',
        '      - identity',
        '      - inter-agent',
        '  - name: auditor',
        '    agent: solidity-security',
        '    skills: []',
        '',
      ].join('\n'),
    );

    const config = parseTeamConfig(configPath);
    expect(config.team).toBe('solidity-pair');
    expect(config.agents).toHaveLength(2);

    const builder = config.agents[0];
    expect(builder.name).toBe('builder');
    expect(builder.agent).toBe('foundry-dev');
    expect(builder.skills).toEqual(['identity', 'inter-agent']);

    const auditor = config.agents[1];
    expect(auditor.name).toBe('auditor');
    expect(auditor.agent).toBe('solidity-security');
    // Empty peer skills array is a valid v3 surface (zero or more).
    expect(auditor.skills).toEqual([]);

    // validateConfig accepts the same v3 shape.
    const validation = validateConfig(config);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('accepts an agent entry with only `agent:` (no peer `skills:`)', () => {
    // Slice-5 contract: peer `skills:` is zero-or-more. A library-backed
    // agent that relies entirely on the library entry's bundled skills
    // should not require declaring `skills:` to validate.
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'auditor', agent: 'solidity-security' }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('parses and round-trips runtimeCredentialPool lanes unchanged', () => {
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'team.yaml');
    fs.writeFileSync(configPath, `version: "1"
team: credential-pool-demo

runtimeCredentialPool:
  lanes:
    - id: claude-sub-a
      runtime: claude-code-cli
      kind: subscription
    - id: claude-sub-b
      runtime: claude-code-cli
      kind: subscription
    - id: claude-metered
      runtime: claude-code-cli
      kind: metered-api
      env:
        ANTHROPIC_API_KEY: test-metered-key

agents:
  - name: lead
    runtime: claude-code-cli
`);

    const parsed = parseConfig(configPath);
    expect(parsed.runtimeCredentialPool?.lanes).toEqual([
      { id: 'claude-sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
      { id: 'claude-sub-b', runtime: 'claude-code-cli', kind: 'subscription' },
      { id: 'claude-metered', runtime: 'claude-code-cli', kind: 'metered-api', env: { ANTHROPIC_API_KEY: 'test-metered-key' } },
    ]);

    const out = processConfig(configPath);
    expect(out.errors).toEqual([]);
    expect(out.runtimeCredentialPool?.lanes).toEqual(parsed.runtimeCredentialPool?.lanes);
  });

  it('validates runtimeCredentialPool lane shape', () => {
    const result = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          { id: 'ok', runtime: 'claude-code-cli', kind: 'subscription' },
          { runtime: 'claude-code-cli', kind: 'subscription' } as any,
          { id: 'bad-runtime', runtime: 'not-a-runtime' as any, kind: 'subscription' },
          { id: 'bad-kind', runtime: 'claude-code-cli', kind: 'free-tier' as any },
          { id: 'bad-env', runtime: 'claude-code-cli', kind: 'metered-api', env: 'ANTHROPIC_API_KEY=x' as any },
        ],
      },
      agents: [{ name: 'lead' }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((err) => err.path)).toEqual(expect.arrayContaining([
      'runtimeCredentialPool.lanes[1].id',
      'runtimeCredentialPool.lanes[2].runtime',
      'runtimeCredentialPool.lanes[3].kind',
      'runtimeCredentialPool.lanes[4].env',
    ]));

    const empty = validateConfig({
      version: '1',
      runtimeCredentialPool: { lanes: [] },
      agents: [{ name: 'lead' }],
    });
    expect(empty.valid).toBe(false);
    expect(empty.errors).toContainEqual({
      path: 'runtimeCredentialPool.lanes',
      message: 'runtimeCredentialPool.lanes must be a non-empty array',
    });

    const oneSubscriptionLane = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          { id: 'sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'metered', runtime: 'claude-code-cli', kind: 'metered-api' },
        ],
      },
      agents: [{ name: 'lead' }],
    });
    expect(oneSubscriptionLane.valid).toBe(false);
    expect(oneSubscriptionLane.errors).toContainEqual({
      path: 'runtimeCredentialPool.lanes',
      message: 'runtimeCredentialPool.lanes must include at least two subscription lanes for claude-code-cli',
    });

    const mixedRuntimeSingleSubscriptions = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          { id: 'claude-sub-a', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'codex-sub-a', runtime: 'codex', kind: 'subscription' },
          { id: 'claude-metered', runtime: 'claude-code-cli', kind: 'metered-api' },
        ],
      },
      agents: [{ name: 'lead' }],
    });
    expect(mixedRuntimeSingleSubscriptions.valid).toBe(false);
    expect(mixedRuntimeSingleSubscriptions.errors).toContainEqual({
      path: 'runtimeCredentialPool.lanes',
      message: 'runtimeCredentialPool.lanes must include at least two subscription lanes for claude-code-cli',
    });
    expect(mixedRuntimeSingleSubscriptions.errors).toContainEqual({
      path: 'runtimeCredentialPool.lanes',
      message: 'runtimeCredentialPool.lanes must include at least two subscription lanes for codex',
    });
  });

  it('rejects duplicate lane ids in one canonical runtime but permits reuse across distinct runtimes', () => {
    const canonicalDuplicate = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          { id: 'shared', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'cli-backup', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'shared', runtime: 'claude-code-local', kind: 'subscription' },
          { id: 'local-backup', runtime: 'claude-code-local', kind: 'subscription' },
        ],
      },
      agents: [{ name: 'lead' }],
    });
    expect(canonicalDuplicate.errors).toContainEqual({
      path: 'runtimeCredentialPool.lanes[2].id',
      message: 'lane id "shared" duplicates runtimeCredentialPool.lanes[0].id for canonical runtime "claude-code-cli"',
    });

    const distinctRuntimeReuse = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          { id: 'shared', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'claude-backup', runtime: 'claude-code-cli', kind: 'subscription' },
          { id: 'shared', runtime: 'codex', kind: 'subscription' },
          { id: 'codex-backup', runtime: 'codex', kind: 'subscription' },
        ],
      },
      agents: [{ name: 'lead' }],
    });
    expect(distinctRuntimeReuse.valid).toBe(true);
    expect(distinctRuntimeReuse.errors).toEqual([]);
  });

  it('accepts an agent entry with only peer `skills:` (no `agent:`)', () => {
    // The other zero-case: a fully inline agent that overlays skills
    // without referencing a library agent entry. Both peers are
    // optional.
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'fluent', skills: ['identity', 'inter-agent'] }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects reserved manager name for automators with the hard-error message', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'manager', type: 'automator' }],
    } as any);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].name',
      message: 'Agent manager with type automator is no longer valid. The name manager is reserved for the control plane. Rename this agent to lead-automator (or any non-reserved name) and re-deploy.',
    });
  });

  it('accepts lead-automator as the first automator name in config validation', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'lead-automator', type: 'automator' }],
    } as any);

    expect(result.valid).toBe(true);
  });

  it('rejects reserved manager name for non-automators with the same hard-error message', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'manager', type: 'claude' }],
    } as any);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].name',
      message: 'Agent manager with type automator is no longer valid. The name manager is reserved for the control plane. Rename this agent to lead-automator (or any non-reserved name) and re-deploy.',
    });
  });

  it('merges preferred env and resources.env with per-agent precedence', () => {
    const merged = mergeDefaults({
      name: 'worker',
      resources: {
        env: {
          AGENT_LEGACY: 'agent-legacy',
          SHARED: 'agent-legacy',
        },
      },
      env: {
        AGENT_TOP: 'agent-top',
        SHARED: 'agent-top',
      },
    }, {
      resources: {
        env: {
          DEFAULT_LEGACY: 'default-legacy',
          SHARED: 'default-legacy',
        },
      },
      env: {
        DEFAULT_TOP: 'default-top',
        SHARED: 'default-top',
      },
    });

    expect(merged.env).toEqual({
      DEFAULT_LEGACY: 'default-legacy',
      DEFAULT_TOP: 'default-top',
      AGENT_LEGACY: 'agent-legacy',
      AGENT_TOP: 'agent-top',
      SHARED: 'agent-top',
    });
  });

  it('validates per-agent env and rejects Manager-owned overrides', () => {
    const valid = validateConfig({
      version: '1',
      defaults: { env: { APP_ENV: 'production' } },
      agents: [{
        name: 'worker',
        env: { FEATURE_FLAG: 'enabled' },
        resources: { env: { LEGACY_VALUE: 'supported' } },
      }],
    });
    expect(valid.valid).toBe(true);
    expect(valid.errors).toEqual([]);

    const invalid = validateConfig({
      version: '1',
      defaults: { env: { PATH: '/attacker/bin' } },
      agents: [{
        name: 'worker',
        env: {
          ID_AGENT_ID: 'attacker',
          'INVALID-KEY': 'bad',
          NON_STRING: 42 as unknown as string,
        },
        resources: {
          env: { XMTP_OPEN_MODE: 'true' },
        },
      }],
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      'defaults.env.PATH',
      'agents[0].env.ID_AGENT_ID',
      'agents[0].env.INVALID-KEY',
      'agents[0].env.NON_STRING',
      'agents[0].resources.env.XMTP_OPEN_MODE',
    ]));
  });

  it('rejects mixed-case routing, TLS, loader, and provider overrides in every agent env layer', () => {
    const invalid = validateConfig({
      version: '1',
      defaults: {
        env: {
          hTtP_pRoXy: 'http://attacker.test',
          sSl_CeRt_FiLe: '/tmp/attacker.pem',
        },
      },
      agents: [{
        name: 'worker',
        env: {
          lD_lIbRaRy_PaTh: '/tmp/attacker',
          oPeNaI_bAsE_uRl: 'https://attacker.test',
          aNtHrOpIc_ApI_kEy: 'secret',
        },
        resources: {
          env: {
            nOdE_oPtIoNs: '--require=/tmp/attacker.js',
          },
        },
      }],
    });

    expect(invalid.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      'defaults.env.hTtP_pRoXy',
      'defaults.env.sSl_CeRt_FiLe',
      'agents[0].env.lD_lIbRaRy_PaTh',
      'agents[0].env.oPeNaI_bAsE_uRl',
      'agents[0].env.aNtHrOpIc_ApI_kEy',
      'agents[0].resources.env.nOdE_oPtIoNs',
    ]));
  });

  it('allows reviewed lane credentials but rejects lane routing, trust, executable, and malformed values', () => {
    const result = validateConfig({
      version: '1',
      runtimeCredentialPool: {
        lanes: [
          {
            id: 'metered-a',
            runtime: 'claude-code-cli',
            kind: 'metered-api',
            env: {
              ANTHROPIC_API_KEY: 'reviewed-key',
              aNtHrOpIc_ApI_kEy: 'mixed-case-key',
              OPENAI_API_KEY: 'cross-provider-key',
              OPENAI_ORGANIZATION: 'attacker-org',
              ANTHROPIC_CUSTOM_HEADERS: 'x-attacker: true',
              OLLAMA_HOST: 'http://attacker.test',
              PROVIDER_API_TOKEN: 'attacker-provider-token',
              hTtP_pRoXy: 'http://attacker.test',
              lD_lIbRaRy_PaTh: '/tmp/attacker',
              oPeNaI_bAsE_uRl: 'https://attacker.test',
              'INVALID-KEY': 'bad',
              NON_STRING: 42 as unknown as string,
            },
          },
          {
            id: 'subscription-a',
            runtime: 'claude-code-cli',
            kind: 'subscription',
          },
          {
            id: 'subscription-b',
            runtime: 'claude-code-cli',
            kind: 'subscription',
          },
        ],
      },
      agents: [{ name: 'worker' }],
    });

    expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      'runtimeCredentialPool.lanes[0].env.hTtP_pRoXy',
      'runtimeCredentialPool.lanes[0].env.lD_lIbRaRy_PaTh',
      'runtimeCredentialPool.lanes[0].env.oPeNaI_bAsE_uRl',
      'runtimeCredentialPool.lanes[0].env.aNtHrOpIc_ApI_kEy',
      'runtimeCredentialPool.lanes[0].env.OPENAI_API_KEY',
      'runtimeCredentialPool.lanes[0].env.OPENAI_ORGANIZATION',
      'runtimeCredentialPool.lanes[0].env.ANTHROPIC_CUSTOM_HEADERS',
      'runtimeCredentialPool.lanes[0].env.OLLAMA_HOST',
      'runtimeCredentialPool.lanes[0].env.PROVIDER_API_TOKEN',
      'runtimeCredentialPool.lanes[0].env.INVALID-KEY',
      'runtimeCredentialPool.lanes[0].env.NON_STRING',
    ]));
    expect(result.errors.map(error => error.path)).not.toContain(
      'runtimeCredentialPool.lanes[0].env.ANTHROPIC_API_KEY',
    );
  });

  it('rejects malformed execution-policy fields on agents and defaults', () => {
    const result = validateConfig({
      version: '1',
      defaults: {
        openMode: 'false' as unknown as boolean,
        dangerouslySkipPermissions: 'false' as unknown as boolean,
        allowedTools: 'Read' as unknown as string[],
      },
      agents: [{
        name: 'worker',
        type: 'worker' as any,
        openMode: 'false' as unknown as boolean,
        dangerouslySkipPermissions: 'false' as unknown as boolean,
        allowedTools: ['Read', '  '],
      }],
    });

    expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      'defaults.openMode',
      'defaults.dangerouslySkipPermissions',
      'defaults.allowedTools',
      'agents[0].type',
      'agents[0].openMode',
      'agents[0].dangerouslySkipPermissions',
      'agents[0].allowedTools',
    ]));
  });

  it('rejects explicit allowedTools on runtimes that cannot enforce an exact boundary', () => {
    const direct = validateConfig({
      version: '1',
      agents: [{
        name: 'worker',
        runtime: 'codex',
        allowedTools: [],
      }],
    });
    expect(direct.errors).toContainEqual({
      path: 'agents[0].allowedTools',
      message: 'runtime "codex" cannot enforce an exact allowedTools boundary; omit allowedTools or choose a runtime that supports it',
    });

    const inherited = validateConfig({
      version: '1',
      defaults: {
        runtime: 'codex',
        allowedTools: ['Read'],
      },
      agents: [{ name: 'worker' }],
    });
    expect(inherited.errors).toContainEqual({
      path: 'defaults.allowedTools',
      message: 'runtime "codex" cannot enforce an exact allowedTools boundary; omit allowedTools or choose a runtime that supports it',
    });
  });

  it('accepts only unique whole tool names and fails CLI named MCP boundaries during preflight', () => {
    const malformed = validateConfig({
      version: '1',
      defaults: {
        allowedTools: ['Read(path)', 'Read(path)'],
      },
      agents: [{
        name: 'worker',
        runtime: 'claude-agent-sdk',
        allowedTools: ['Bash(git:*)'],
      }],
    });
    expect(malformed.errors).toEqual(expect.arrayContaining([
      {
        path: 'defaults.allowedTools',
        message: 'allowedTools must be an array of unique exact whole tool names',
      },
      {
        path: 'agents[0].allowedTools',
        message: 'allowedTools must be an array of unique exact whole tool names',
      },
    ]));

    const cliMcp = validateConfig({
      version: '1',
      defaults: {
        runtime: 'claude-code-cli',
        allowedTools: ['Read', 'mcp__brain__search'],
      },
      agents: [{ name: 'worker' }],
    });
    expect(cliMcp.errors).toContainEqual({
      path: 'defaults.allowedTools',
      message: 'runtime "claude-code-cli" cannot enforce an exact named MCP tool boundary; use claude-agent-sdk',
    });

    const sdkMcp = validateConfig({
      version: '1',
      agents: [{
        name: 'worker',
        runtime: 'claude-agent-sdk',
        allowedTools: ['Read', 'mcp__brain__search'],
      }],
    });
    expect(sdkMcp.errors.filter((error) => error.path.endsWith('allowedTools'))).toEqual([]);
  });

  it('rejects non-portable declarative names and case-folded duplicates', () => {
    const result = validateConfig({
      version: '1',
      defaults: {
        plugins: [{ name: 'Shared', path: '/plugins/default-shared' }],
      },
      agents: [{
        name: 'CON',
        agent: 'NUL.txt',
        plugins: [
          { name: 'shared', path: '/plugins/agent-shared' },
          { name: 'COM1.foo', path: '/plugins/device' },
        ],
        skills: ['Build', 'build', 'release.'],
      }],
    });

    expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
      'agents[0].name',
      'agents[0].agent',
      'agents[0].plugins[0].name',
      'agents[0].plugins[1].name',
      'agents[0].skills[1]',
      'agents[0].skills[2]',
    ]));
  });

  describe('catalog seed parsing', () => {
    it('surfaces a full catalog block on the agent spec via parseTeamConfig', () => {
      tmpDir = mkTmp();
      const configPath = path.join(tmpDir, 'team-with-catalog.yaml');
      fs.writeFileSync(configPath, `name: catalog-team

agents:
  - name: jrdev
    runtime: cursor-cli
    model: composer-2
    workingDirectory: ~/projects/demo
    catalog:
      role: junior-developer
      description: "Junior dev for low-stakes work."
      expertise: [typescript, simple-refactors, doc-edits]
      costTier: low
      notSuitableFor: [multi-file-schema-migrations, security-key-handling]
      status: available
`);

      const config = parseTeamConfig(configPath);
      expect(config.agents).toHaveLength(1);
      const cat = config.agents[0].catalog;
      expect(cat).toBeDefined();
      expect(cat?.role).toBe('junior-developer');
      expect(cat?.description).toBe('Junior dev for low-stakes work.');
      expect(cat?.expertise).toEqual(['typescript', 'simple-refactors', 'doc-edits']);
      expect(cat?.costTier).toBe('low');
      expect(cat?.notSuitableFor).toEqual(['multi-file-schema-migrations', 'security-key-handling']);
      expect(cat?.status).toBe('available');
    });

    it('treats catalog as optional — agents without a catalog block parse with catalog: undefined', () => {
      tmpDir = mkTmp();
      const configPath = path.join(tmpDir, 'team-no-catalog.yaml');
      fs.writeFileSync(configPath, `name: catalog-team

agents:
  - name: noseed
    runtime: claude-code-cli
`);
      const config = parseTeamConfig(configPath);
      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].catalog).toBeUndefined();
    });

    it('validateConfig accepts a well-formed catalog block', () => {
      const result = validateConfig({
        version: '1',
        agents: [{
          name: 'good',
          catalog: {
            role: 'developer',
            description: 'desc',
            expertise: ['a', 'b'],
            costTier: 'medium',
            notSuitableFor: ['x'],
            status: 'available',
          },
        }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('validateConfig rejects non-object catalog values', () => {
      const arrResult = validateConfig({
        version: '1',
        agents: [{ name: 'bad', catalog: ['not', 'an', 'object'] as any }],
      });
      expect(arrResult.valid).toBe(false);
      expect(arrResult.errors).toContainEqual({
        path: 'agents[0].catalog',
        message: 'catalog must be an object',
      });

      const stringResult = validateConfig({
        version: '1',
        agents: [{ name: 'bad', catalog: 'string' as any }],
      });
      expect(stringResult.valid).toBe(false);
      expect(stringResult.errors).toContainEqual({
        path: 'agents[0].catalog',
        message: 'catalog must be an object',
      });
    });

    describe('catalogFile (markdown)', () => {
      it('parses body-only markdown as the catalog description (no frontmatter)', () => {
        const cat = parseCatalogMarkdown(`## Junior Developer

Markdown body stays intact.
`);
        expect(cat.description).toBe(`## Junior Developer

Markdown body stays intact.
`);
        expect(cat.role).toBeUndefined();
        expect(cat.status).toBe('available'); // default
      });

      it('parses frontmatter-only with empty body', () => {
        const cat = parseCatalogMarkdown(`---
role: junior-developer
expertise: [typescript, simple-refactors]
costTier: low
notSuitableFor: [security-key-handling]
status: busy
---
`);
        expect(cat.role).toBe('junior-developer');
        expect(cat.expertise).toEqual(['typescript', 'simple-refactors']);
        expect(cat.costTier).toBe('low');
        expect(cat.notSuitableFor).toEqual(['security-key-handling']);
        expect(cat.status).toBe('busy');
        // No body and no description in frontmatter -> description undefined
        expect(cat.description).toBeUndefined();
      });

      it('frontmatter description wins over body when both set', () => {
        const cat = parseCatalogMarkdown(`---
role: junior-developer
description: "FM wins"
---

Body description that should be ignored.
`);
        expect(cat.description).toBe('FM wins');
        expect(cat.role).toBe('junior-developer');
      });

      it('uses body as description when frontmatter omits description', () => {
        const cat = parseCatalogMarkdown(`---
role: junior-developer
costTier: low
---

Junior dev for low-stakes work.
`);
        expect(cat.description).toBe(`Junior dev for low-stakes work.
`);
        expect(cat.role).toBe('junior-developer');
      });

      it('resolveCatalogFile reads relative to basePath', () => {
        tmpDir = mkTmp();
        const mdPath = path.join(tmpDir, 'catalogs', 'jrdev.md');
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, `---
role: junior-developer
costTier: low
---

Body desc.
`);
        const cat = resolveCatalogFile('catalogs/jrdev.md', tmpDir);
        expect(cat.role).toBe('junior-developer');
        expect(cat.description).toBe(`Body desc.
`);
      });

      it('resolveCatalogFile rejects markdown without a role in frontmatter', () => {
        tmpDir = mkTmp();
        const mdPath = path.join(tmpDir, 'catalogs', 'jrdev.md');
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, `---
costTier: low
---

Body desc.
`);
        expect(() => resolveCatalogFile('catalogs/jrdev.md', tmpDir))
          .toThrowError(new RegExp(`Invalid catalogFile: .*catalog.role is required`));
      });

      it('processConfig resolves catalogFile into catalog and clears catalogFile', () => {
        tmpDir = mkTmp();
        const mdPath = path.join(tmpDir, 'catalogs', 'jrdev.md');
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, `---
role: junior-developer
expertise: [typescript]
costTier: low
---

Body description.
`);
        const yamlPath = path.join(tmpDir, 'team.yaml');
        fs.writeFileSync(yamlPath, `version: "1"
team: t1

agents:
  - name: jrdev
    catalogFile: catalogs/jrdev.md
`);
        const out = processConfig(yamlPath);
        expect(out.errors).toEqual([]);
        const a = out.agents[0];
        expect(a.catalog?.role).toBe('junior-developer');
        expect(a.catalog?.expertise).toEqual(['typescript']);
        expect(a.catalog?.description).toBe(`Body description.
`);
        expect(a.catalogFile).toBeUndefined();
      });

      it('validateConfig rejects an agent that sets both catalog and catalogFile', () => {
        const result = validateConfig({
          version: '1',
          agents: [{
            name: 'jrdev',
            catalogFile: 'catalogs/jrdev.md',
            catalog: { role: 'junior-developer' },
          }],
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual({
          path: 'agents[0]',
          message: 'Agent jrdev: cannot use both catalog and catalogFile — pick one',
        });
      });
    });

    it('validateConfig rejects bad catalog field types and unknown costTier', () => {
      const result = validateConfig({
        version: '1',
        agents: [{
          name: 'bad',
          catalog: {
            role: 42 as any,
            expertise: 'not-an-array' as any,
            notSuitableFor: [1, 2] as any,
            costTier: 'extreme' as any,
            status: { nested: true } as any,
          },
        }],
      });
      expect(result.valid).toBe(false);
      const messages = result.errors.map(e => `${e.path}: ${e.message}`);
      expect(messages).toContain('agents[0].catalog.role: catalog.role must be a string');
      expect(messages).toContain('agents[0].catalog.expertise: catalog.expertise must be a string array');
      expect(messages).toContain('agents[0].catalog.notSuitableFor: catalog.notSuitableFor must be a string array');
      expect(messages).toContain('agents[0].catalog.costTier: catalog.costTier must be one of: low, medium, high');
      expect(messages).toContain('agents[0].catalog.status: catalog.status must be a string');
    });
  });
});

// SPDX-License-Identifier: MIT

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reconcileManagedOverlay,
  validatePortableOverlaySegment,
} from '../../src/lib/managed-overlay-reconciler.js';

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('managed overlay reconciler', () => {
  it('updates and removes exact owned files while pruning only empty owned directories', () => {
    const workspace = temporaryRoot('managed-overlay-workspace-');
    const source = temporaryRoot('managed-overlay-source-');
    write(join(source, 'skills', 'alpha', 'SKILL.md'), 'alpha-v1\n');

    const first = reconcileManagedOverlay({
      workspaceRoot: workspace,
      trees: [{ source, destination: '.agents' }],
    });
    expect(first.written).toEqual(['.agents/skills/alpha/SKILL.md']);
    expect(readFileSync(join(workspace, '.agents/skills/alpha/SKILL.md'), 'utf8'))
      .toBe('alpha-v1\n');

    write(join(source, 'skills', 'alpha', 'SKILL.md'), 'alpha-v2\n');
    const second = reconcileManagedOverlay({
      workspaceRoot: workspace,
      trees: [{ source, destination: '.agents' }],
    });
    expect(second.written).toEqual(['.agents/skills/alpha/SKILL.md']);
    expect(readFileSync(join(workspace, '.agents/skills/alpha/SKILL.md'), 'utf8'))
      .toBe('alpha-v2\n');

    const removed = reconcileManagedOverlay({ workspaceRoot: workspace });
    expect(removed.removed).toEqual(['.agents/skills/alpha/SKILL.md']);
    expect(() => readFileSync(join(workspace, '.agents/skills/alpha/SKILL.md')))
      .toThrow();
  });

  it('preserves drift and refuses to claim or overwrite a pre-existing user file', () => {
    const workspace = temporaryRoot('managed-overlay-drift-');
    const source = temporaryRoot('managed-overlay-drift-source-');
    write(join(source, 'rules', 'agent.md'), 'managed\n');
    write(join(workspace, '.claude/rules/agent.md'), 'user-owned\n');

    expect(() => reconcileManagedOverlay({
      workspaceRoot: workspace,
      trees: [{ source, destination: '.claude' }],
    })).toThrow(/unowned file/i);
    expect(readFileSync(join(workspace, '.claude/rules/agent.md'), 'utf8'))
      .toBe('user-owned\n');

    rmSync(join(workspace, '.claude/rules/agent.md'));
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      trees: [{ source, destination: '.claude' }],
    });
    writeFileSync(join(workspace, '.claude/rules/agent.md'), 'user-edited\n');
    const cleanup = reconcileManagedOverlay({ workspaceRoot: workspace });
    expect(cleanup.preserved).toContain('.claude/rules/agent.md');
    expect(readFileSync(join(workspace, '.claude/rules/agent.md'), 'utf8'))
      .toBe('user-edited\n');
  });

  it('never reclaims retained self-source drift while keeping unchanged files cleanable', () => {
    const workspace = temporaryRoot('managed-overlay-retain-existing-');
    const editedPath = join(workspace, 'plugins/demo/plugin.json');
    const unchangedPath = join(workspace, 'plugins/demo/runtime.js');
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [
        { destination: 'plugins/demo/plugin.json', content: '{"version":1}\n' },
        { destination: 'plugins/demo/runtime.js', content: 'managed-v1\n' },
      ],
    });
    writeFileSync(editedPath, '{"version":"agent-edit"}\n');

    const retained = reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [
        {
          destination: 'plugins/demo/plugin.json',
          content: readFileSync(editedPath),
          claimExisting: false,
        },
        {
          destination: 'plugins/demo/runtime.js',
          content: readFileSync(unchangedPath),
          claimExisting: false,
        },
      ],
    });
    expect(retained.preserved).toContain('plugins/demo/plugin.json');
    const receiptPath = join(workspace, '.id-agents/managed-overlay-receipt.json');
    let receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.files['plugins/demo/plugin.json']).toBeUndefined();
    expect(receipt.files['plugins/demo/runtime.js']).toBeDefined();

    // A later self-source pass must not adopt the already released bytes.
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [
        {
          destination: 'plugins/demo/plugin.json',
          content: readFileSync(editedPath),
          claimExisting: false,
        },
        {
          destination: 'plugins/demo/runtime.js',
          content: readFileSync(unchangedPath),
          claimExisting: false,
        },
      ],
    });
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.files['plugins/demo/plugin.json']).toBeUndefined();

    reconcileManagedOverlay({ workspaceRoot: workspace });
    expect(readFileSync(editedPath, 'utf8')).toBe('{"version":"agent-edit"}\n');
    expect(() => readFileSync(unchangedPath)).toThrow();
  });

  it('recovers a pending publication when the old or new exact digest is present', () => {
    const workspace = temporaryRoot('managed-overlay-pending-');
    const target = join(workspace, '.agents/skills/alpha/SKILL.md');
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [{ destination: '.agents/skills/alpha/SKILL.md', content: 'old\n' }],
    });
    const receiptPath = join(workspace, '.id-agents/managed-overlay-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const oldDigest = receipt.files['.agents/skills/alpha/SKILL.md'].sha256;
    const nextDigest = createHash('sha256').update('new\n').digest('hex');
    receipt.files['.agents/skills/alpha/SKILL.md'] = {
      sha256: nextDigest,
      previousSha256: oldDigest,
      state: 'pending',
      mode: 0o600,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const recovered = reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [{ destination: '.agents/skills/alpha/SKILL.md', content: 'new\n' }],
    });
    expect(recovered.written).toEqual(['.agents/skills/alpha/SKILL.md']);
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });

  it('rejects destination links, portable device names, trailing dots, and case collisions', () => {
    const workspace = temporaryRoot('managed-overlay-link-');
    const outside = temporaryRoot('managed-overlay-outside-');
    write(join(outside, 'sentinel.txt'), 'keep\n');
    symlinkSync(outside, join(workspace, '.agents'));

    expect(() => reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [{ destination: '.agents/rule.md', content: 'unsafe\n' }],
    })).toThrow(/symlink|junction/i);
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep\n');

    for (const value of ['CON', 'nul.txt', 'name.', 'bad ']) {
      expect(() => validatePortableOverlaySegment(value)).toThrow();
    }

    const clean = temporaryRoot('managed-overlay-case-');
    expect(() => reconcileManagedOverlay({
      workspaceRoot: clean,
      files: [
        { destination: '.agents/Skills/alpha.md', content: 'one\n' },
        { destination: '.agents/skills/ALPHA.md', content: 'two\n' },
      ],
    })).toThrow(/case-fold/i);
  });

  it('rejects composed and decomposed Unicode segments in source trees and desired files', () => {
    const variants = ['caf\u00e9', 'cafe\u0301'];
    for (const [index, variant] of variants.entries()) {
      const source = temporaryRoot(`managed-overlay-unicode-source-${index}-`);
      const workspace = temporaryRoot(`managed-overlay-unicode-workspace-${index}-`);
      write(join(source, variant, 'rule.md'), 'managed\n');
      write(join(workspace, 'sentinel.txt'), 'keep\n');

      expect(() => reconcileManagedOverlay({
        workspaceRoot: workspace,
        trees: [{ source, destination: '.agents' }],
      })).toThrow(/printable ASCII/i);
      expect(readFileSync(join(workspace, 'sentinel.txt'), 'utf8')).toBe('keep\n');

      expect(() => reconcileManagedOverlay({
        workspaceRoot: workspace,
        files: [{
          destination: `.agents/${variant}/rule.md`,
          content: 'managed\n',
        }],
      })).toThrow(/printable ASCII/i);
      expect(readFileSync(join(workspace, 'sentinel.txt'), 'utf8')).toBe('keep\n');
    }
  });

  it('rejects Unicode aliases against existing targets without overwriting user files', () => {
    const workspace = temporaryRoot('managed-overlay-unicode-existing-');
    const composed = join(workspace, '.agents', 'caf\u00e9.md');
    write(composed, 'user-owned\n');

    expect(() => reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [{
        destination: '.agents/cafe\u0301.md',
        content: 'managed\n',
      }],
    })).toThrow(/printable ASCII/i);
    expect(readFileSync(composed, 'utf8')).toBe('user-owned\n');

    const compatibilityAlias = join(workspace, '.agents', '\uff21lpha.md');
    write(compatibilityAlias, 'compatibility-user-owned\n');
    expect(() => reconcileManagedOverlay({
      workspaceRoot: workspace,
      files: [{
        destination: '.agents/Alpha.md',
        content: 'managed\n',
      }],
    })).toThrow(/normalization path collision/i);
    expect(readFileSync(compatibilityAlias, 'utf8'))
      .toBe('compatibility-user-owned\n');
  });

  it('rejects composed/decomposed paths in legacy receipts before migration or mutation', () => {
    const workspace = temporaryRoot('managed-overlay-unicode-receipt-');
    const receiptPath = join(workspace, '.id-agents/managed-overlay-receipt.json');
    const digest = createHash('sha256').update('managed\n').digest('hex');
    const receipt = {
      schemaVersion: 1,
      files: {
        '.agents/caf\u00e9/rule.md': {
          sha256: digest,
          state: 'owned',
          mode: 0o600,
        },
        '.agents/cafe\u0301/rule.md': {
          sha256: digest,
          state: 'owned',
          mode: 0o600,
        },
      },
      createdDirectories: ['.agents/caf\u00e9', '.agents/cafe\u0301'],
    };
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    write(receiptPath, serialized);
    write(join(workspace, 'sentinel.txt'), 'keep\n');

    expect(() => reconcileManagedOverlay({
      workspaceRoot: workspace,
      preflightOnly: true,
    })).toThrow(/printable ASCII/i);
    expect(readFileSync(receiptPath, 'utf8')).toBe(serialized);
    expect(readFileSync(join(workspace, 'sentinel.txt'), 'utf8')).toBe('keep\n');
  });

  it('updates managed marker blocks while preserving unrelated host-file edits byte-for-byte', () => {
    const workspace = temporaryRoot('managed-overlay-markers-');
    const agentsMd = join(workspace, 'AGENTS.md');
    writeFileSync(agentsMd, '# Consumer notes\n\nKeep this paragraph.\n');

    reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'framework', content: 'framework-v1\n' }],
      }],
    });
    writeFileSync(
      agentsMd,
      readFileSync(agentsMd, 'utf8').replace(
        'Keep this paragraph.',
        'Keep this user-edited paragraph.',
      ),
    );

    const updated = reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'framework', content: 'framework-v2\n' }],
      }],
    });
    expect(updated.written).toEqual(['AGENTS.md#framework']);
    const contents = readFileSync(agentsMd, 'utf8');
    expect(contents).toContain('Keep this user-edited paragraph.');
    expect(contents).toContain('framework-v2');
    expect(contents).not.toContain('framework-v1');
  });

  it('removes retired marker A before adding marker B without touching outside text', () => {
    const workspace = temporaryRoot('managed-overlay-marker-transition-');
    const agentsMd = join(workspace, 'AGENTS.md');
    writeFileSync(agentsMd, 'operator-owned prefix\n');
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'agent:source-a', content: 'persona-a\n' }],
      }],
    });

    const transitioned = reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'agent:source-b', content: 'persona-b\n' }],
      }],
    });
    expect(transitioned.removed).toEqual(['AGENTS.md#agent:source-a']);
    expect(transitioned.written).toEqual(['AGENTS.md#agent:source-b']);
    const contents = readFileSync(agentsMd, 'utf8');
    expect(contents).toContain('operator-owned prefix');
    expect(contents).not.toContain('source-a');
    expect(contents).not.toContain('persona-a');
    expect(contents).toContain('source-b');
    expect(contents).toContain('persona-b');
  });

  it('rejects malformed, duplicate, and nested managed markers before mutation', () => {
    const cases = [
      '<!-- BEGIN id-agents framework -->\nunterminated\n',
      [
        '<!-- BEGIN id-agents framework -->',
        '<!-- END id-agents framework -->',
        '<!-- BEGIN id-agents framework -->',
        '<!-- END id-agents framework -->',
      ].join('\n'),
      [
        '<!-- BEGIN id-agents framework -->',
        '<!-- BEGIN id-agents agent:alpha -->',
        '<!-- END id-agents agent:alpha -->',
        '<!-- END id-agents framework -->',
      ].join('\n'),
    ];

    for (const [index, malformed] of cases.entries()) {
      const workspace = temporaryRoot(`managed-overlay-malformed-${index}-`);
      const agentsMd = join(workspace, 'AGENTS.md');
      writeFileSync(agentsMd, malformed);
      expect(() => reconcileManagedOverlay({
        workspaceRoot: workspace,
        markerFiles: [{
          destination: 'AGENTS.md',
          blocks: [{ id: 'framework', content: 'replacement\n' }],
        }],
      })).toThrow(/marker/i);
      expect(readFileSync(agentsMd, 'utf8')).toBe(malformed);
    }
  });

  it('recovers a pending marker publication from the exact previous digest', () => {
    const workspace = temporaryRoot('managed-overlay-marker-pending-');
    const agentsMd = join(workspace, 'AGENTS.md');
    writeFileSync(agentsMd, 'user prefix\n');
    reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'framework', content: 'old\n' }],
      }],
    });
    const receiptPath = join(workspace, '.id-agents/managed-overlay-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const oldDigest = receipt.markers['AGENTS.md'].framework.sha256;
    const nextBlock = '<!-- BEGIN id-agents framework -->\nnew\n<!-- END id-agents framework -->\n';
    const nextDigest = createHash('sha256').update(nextBlock).digest('hex');
    receipt.markers['AGENTS.md'].framework = {
      sha256: nextDigest,
      previousSha256: oldDigest,
      state: 'pending',
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    const recovered = reconcileManagedOverlay({
      workspaceRoot: workspace,
      markerFiles: [{
        destination: 'AGENTS.md',
        blocks: [{ id: 'framework', content: 'new\n' }],
      }],
    });
    expect(recovered.written).toEqual(['AGENTS.md#framework']);
    expect(readFileSync(agentsMd, 'utf8')).toContain('user prefix');
    expect(readFileSync(agentsMd, 'utf8')).toContain('\nnew\n');
  });
});

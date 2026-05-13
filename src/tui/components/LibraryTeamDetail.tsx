import React from 'react';
import { Box, Text } from 'ink';
import type { LibraryTeamDetailResponse, InstallLibraryTeamResponse } from '../api/manager.js';

interface LibraryTeamDetailProps {
  team: LibraryTeamDetailResponse | null;
  teamName: string | null;
  loading: boolean;
  error: Error | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  installState: InstallState;
}

export type InstallState =
  | { kind: 'idle' }
  | { kind: 'prompt'; dest: string; force: boolean }
  | { kind: 'running'; dest: string }
  | { kind: 'success'; result: InstallLibraryTeamResponse }
  | { kind: 'error'; message: string };

const README_PREVIEW_LINES = 18;

export function LibraryTeamDetail(props: LibraryTeamDetailProps): React.ReactElement {
  const { team, teamName, loading, error, positionLabel, windowSize, scrollOffset, installState } = props;

  const lines = buildBodyLines(team, loading, error, installState);
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          library team · {team?.name ?? teamName ?? '(none)'}
          {team?.declaredTeam && team.declaredTeam !== team.name ? (
            <Text dimColor>  declares: {team.declaredTeam}</Text>
          ) : null}
        </Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={windowSize} />
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Body(props: { visible: string[]; windowSize: number }): React.ReactElement {
  const { visible, windowSize } = props;
  const padCount = Math.max(0, windowSize - visible.length);
  return (
    <>
      {visible.map((line, i) => (
        <Text key={`line-${i}`} wrap="truncate-end">{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </>
  );
}

function buildBodyLines(
  team: LibraryTeamDetailResponse | null,
  loading: boolean,
  error: Error | null,
  installState: InstallState,
): string[] {
  if (error) return [`error: ${error.message}`];
  if (!team) return [loading ? 'loading…' : '(no library team selected)'];

  const out: string[] = [];
  out.push(`name:           ${team.name}`);
  if (team.declaredTeam && team.declaredTeam !== team.name) {
    out.push(`declared team:  ${team.declaredTeam}`);
  } else if (!team.declaredTeam) {
    out.push(`declared team:  — (template has no top-level \`team:\` field)`);
  }
  // README-first description block (parallel to LibraryAgentDetail). Falls
  // back to the leading paragraph of team.yaml when no README is present.
  const description = firstParagraph(team.readme);
  if (description) {
    out.push('');
    out.push('── description ──');
    for (const line of description.split(/\r?\n/)) out.push(line.trimEnd());
  }
  out.push('');
  out.push(`source path:    ${team.source_path}`);
  out.push(`team.yaml:      ${team.teamYamlFile}`);
  out.push(`README:         ${team.hasReadme ? 'present' : '—'}`);
  out.push(`LICENSE:        ${team.hasLicense ? 'present' : '—'}`);
  out.push('');
  out.push('── agents declared in team.yaml ──');
  if (team.agents.length === 0) {
    out.push('(none)');
  } else {
    for (const a of team.agents) out.push(`• ${a}`);
  }
  out.push('');
  out.push('── install ──');
  out.push(installHint(team, installState));
  if (installState.kind === 'prompt') {
    out.push(`  to: team:${installState.dest || '<dest>'}${installState.force ? '  (force)' : ''}`);
    out.push('  Enter to install · F to toggle force · Esc to cancel');
  } else if (installState.kind === 'running') {
    out.push(`  installing → team:${installState.dest} …`);
  } else if (installState.kind === 'success') {
    const r = installState.result;
    if (r.ok) {
      out.push(`  ✓ installed → ${r.destPath}`);
      out.push(`  declared team: ${r.declaredTeamBefore ?? '—'} → ${r.declaredTeamAfter}`);
      if (r.overwritten) out.push('  (overwrote existing file at dest)');
      out.push('');
      out.push('  Provenance header added at the top of the installed file:');
      out.push(`    # Installed from configs/teams/${r.template}/team.yaml on YYYY-MM-DD`);
      out.push('');
      out.push(`  Deploy this template into a workspace with the receipt-driven`);
      out.push(`  additive sync model:`);
      out.push(`    id-agents sync ${r.destPath}`);
      out.push(`  Undeploy later with:`);
      out.push(`    id-agents unsync ${r.destPath}`);
    } else {
      out.push(`  ✗ install failed: ${r.error}`);
    }
  } else if (installState.kind === 'error') {
    out.push(`  ✗ install error: ${installState.message}`);
  }
  out.push('');
  out.push('── team.yaml preview ──');
  if (!team.teamYaml || team.teamYaml.trim() === '') {
    out.push('(empty)');
  } else {
    const yamlLines = team.teamYaml.split(/\r?\n/);
    for (const raw of yamlLines.slice(0, README_PREVIEW_LINES)) {
      const line = raw.trimEnd();
      out.push(line === '' ? '' : line);
    }
    if (yamlLines.length > README_PREVIEW_LINES) {
      out.push(`… (${yamlLines.length - README_PREVIEW_LINES} more lines)`);
    }
  }
  return out;
}

function installHint(team: LibraryTeamDetailResponse, state: InstallState): string {
  if (state.kind === 'prompt' || state.kind === 'running' || state.kind === 'success' || state.kind === 'error') {
    return `template: team:${team.name}`;
  }
  return `press \`i\` to install team:${team.name} → team:<dest>`;
}

function firstParagraph(raw: string | null): string | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const buf: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (buf.length > 0) return buf.join('\n');
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (buf.length > 0) return buf.join('\n');
      continue;
    }
    buf.push(line.trimEnd());
  }
  return buf.length > 0 ? buf.join('\n') : null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

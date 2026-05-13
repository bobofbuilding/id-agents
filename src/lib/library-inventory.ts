// SPDX-License-Identifier: MIT
/**
 * Agent-config v3 slice 7 — read-only library inventory helpers.
 *
 * Thin wrappers around the slice-1 enumerators in `./agent-library.ts`
 * that produce JSON-friendly response shapes for manager HTTP routes.
 * No shape detection is duplicated here; filesystem classification
 * stays in the enumerator. Everything beyond "is this a library entry"
 * — README / LICENSE presence, subfolder listings, SKILL.md frontmatter
 * — is metadata enrichment and lives here.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import {
  enumerateLibraryAgents,
  enumerateLibrarySkills,
  enumerateLibraryTeams,
  getLibraryPaths,
  type AgentLibraryShape,
  type LibraryAgentError,
} from './agent-library.js';

export interface AgentListEntry {
  name: string;
  shape: AgentLibraryShape;
  hasReadme: boolean;
  hasLicense: boolean;
  /** Immediate subdirectory names (non-dot) under the entry's directory. */
  subfolders: string[];
  /** Absolute filesystem path to the entry's directory. */
  source_path: string;
  /**
   * README-first one-line description. Derived from the first body
   * paragraph of `README.md` when present, otherwise `null`. The README
   * is the canonical human-authored description surface for library
   * entries — agent configs rarely carry enough context to identify
   * what an agent is for. Inventory clients should prefer this field
   * over any config-derived summary.
   */
  description: string | null;
}

export interface AgentDetail extends AgentListEntry {
  /** Absolute path to the persona / memory markdown file. */
  memoryFile: string;
  /** README body, or null when no README.md is present. */
  readme: string | null;
  /** Raw CLAUDE.md body (claude-native) or sibling `<name>.md` body (agents-md-native). */
  memory: string;
  /** Names of bundled skills discovered under the entry's `skills/` subdir. */
  bundledSkills: string[];
}

export interface SkillListEntry {
  name: string;
  /**
   * Whether a SKILL.md file is present under the skill directory. Always
   * true for enumerated entries (the enumerator requires it) but included
   * in the contract so the TUI can render the check uniformly and so a
   * future caller that loosens the enumerator sees the flag.
   */
  hasSkillMd: boolean;
  /** Absolute filesystem path to the skill directory. */
  source_path: string;
  /**
   * One-line description. Prefers SKILL.md frontmatter `description:`
   * (the canonical authored field for skills — Anthropic's skill format
   * makes it the README-equivalent), then falls back to the first body
   * paragraph of SKILL.md after the frontmatter. `null` when neither is
   * available.
   */
  description: string | null;
}

export interface SkillDetail extends SkillListEntry {
  /** Absolute path to the SKILL.md file. */
  skillFile: string;
  /** Frontmatter name field, or null if missing / unparsable. */
  skillName: string | null;
  /** Frontmatter description field, or null if missing / unparsable. */
  description: string | null;
  /** Character length of the SKILL.md body (post-frontmatter). */
  bodyLength: number;
}

export interface AgentListResult {
  /** Absolute library root, or null when the manager has no library configured. */
  libraryRoot: string | null;
  entries: AgentListEntry[];
  /** Discovery errors surfaced by the enumerator (mixed-shape, incomplete pair). */
  errors: LibraryAgentError[];
}

export interface SkillListResult {
  libraryRoot: string | null;
  entries: SkillListEntry[];
}

export interface TeamListEntry {
  name: string;
  hasReadme: boolean;
  hasLicense: boolean;
  /**
   * Whether a `team.yaml` file is present under the team directory.
   * Always true for enumerated entries (the enumerator requires it) but
   * included so consumers can render the check uniformly and a future
   * caller that loosens the enumerator still sees the flag — mirrors
   * `SkillListEntry.hasSkillMd`.
   */
  hasTeamYaml: boolean;
  /** Absolute filesystem path to the team directory. */
  source_path: string;
  /**
   * README-first one-line description. Derived from the first body
   * paragraph of `README.md`, otherwise `null`. The team.yaml comment
   * banner is intentionally NOT used here — many templates lead with
   * an "Install with" snippet that reads as instructions rather than
   * a description.
   */
  description: string | null;
}

export interface TeamDetail extends TeamListEntry {
  /** Absolute path to the `team.yaml` file. */
  teamYamlFile: string;
  /** README body, or null when no README.md is present. */
  readme: string | null;
  /** Raw `team.yaml` body (UTF-8). */
  teamYaml: string;
  /**
   * Value of the top-level `team:` field parsed from `team.yaml`, or
   * `null` if absent / not a string. Used by the install endpoint's
   * approval guard and by clients that want to detect mismatched
   * templates.
   */
  declaredTeam: string | null;
  /**
   * Best-effort list of `agents[].name` from `team.yaml`, in declaration
   * order. Empty when `agents:` is missing, malformed, or empty.
   */
  agents: string[];
}

export interface TeamListResult {
  libraryRoot: string | null;
  entries: TeamListEntry[];
}

/**
 * Default library-root resolution used by the manager HTTP endpoints.
 *
 * Consistent with slice-2's in-process default: the in-repo library lives
 * at `<repoRoot>/configs`. Operators can override with `ID_LIBRARY_ROOT`
 * to point at an out-of-tree library (e.g. the `public-agents/configs`
 * used by the slice-3 workspace-sync demos).
 *
 * Resolution order:
 *   1. process.env.ID_LIBRARY_ROOT when set and existing on disk
 *   2. <cwd>/configs when present
 *   3. null (no library configured)
 *
 * Returning null rather than throwing lets the routes answer with an
 * empty list instead of a 500, matching the brief's "no library
 * configured -> empty list rather than error" contract.
 */
export function resolveDefaultLibraryRoot(): string | null {
  const envRoot = process.env.ID_LIBRARY_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (fs.existsSync(resolved)) return resolved;
  }
  const cwdRoot = path.resolve(process.cwd(), 'configs');
  if (fs.existsSync(cwdRoot)) return cwdRoot;
  return null;
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listSubfolders(dirPath: string): string[] {
  if (!dirExists(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function readFileIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

/**
 * Extract a one-line, README-first description from a markdown body.
 *
 * Skips a leading `# Title` heading and any blank lines, then returns
 * the first non-empty paragraph's first line (trimmed). Skips block
 * directives ("```", "<!--", "---" hr/frontmatter, ">" blockquote)
 * because library READMEs commonly open with a fence or comment.
 * Returns `null` when no usable line is found.
 */
function readmeFirstParagraph(md: string | null): string | null {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  let i = 0;
  // Skip leading blanks
  while (i < lines.length && lines[i].trim() === '') i++;
  // Skip exactly one leading H1/H2 title line if present.
  if (i < lines.length && /^#{1,2}\s+/.test(lines[i])) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  // Skip non-prose openers and blanks.
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === '') { i++; continue; }
    if (t.startsWith('```') || t.startsWith('<!--') || t === '---' || t.startsWith('> ')) {
      // Skip the whole block: walk forward until the closing fence or blank.
      if (t.startsWith('```')) {
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
        if (i < lines.length) i++;
        continue;
      }
      if (t.startsWith('<!--')) {
        i++;
        while (i < lines.length && !lines[i].includes('-->')) i++;
        if (i < lines.length) i++;
        continue;
      }
      if (t === '---') {
        // Treat as horizontal rule; skip.
        i++;
        continue;
      }
      // Blockquote — skip the contiguous block.
      while (i < lines.length && lines[i].trim().startsWith('> ')) i++;
      continue;
    }
    return t;
  }
  return null;
}

function bundledSkillNames(agentDir: string): string[] {
  const skillsDir = path.join(agentDir, 'skills');
  return enumerateLibrarySkills(skillsDir).map(e => e.name);
}

function decorateAgentEntry(
  name: string,
  shape: AgentLibraryShape,
  dirPath: string,
): AgentListEntry {
  const readmePath = path.join(dirPath, 'README.md');
  return {
    name,
    shape,
    hasReadme: fileExists(readmePath),
    hasLicense: fileExists(path.join(dirPath, 'LICENSE')),
    subfolders: listSubfolders(dirPath),
    source_path: dirPath,
    description: readmeFirstParagraph(readFileIfExists(readmePath)),
  };
}

function decorateSkillEntry(name: string, dirPath: string, skillFile: string): SkillListEntry {
  const raw = readFileIfExists(skillFile);
  const { frontmatter, body } = raw ? parseSkillMd(raw) : { frontmatter: {}, body: '' };
  const fmDesc = stringFieldOrNull(frontmatter, 'description');
  return {
    name,
    hasSkillMd: fileExists(skillFile),
    source_path: dirPath,
    description: fmDesc ?? readmeFirstParagraph(body),
  };
}

function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (yaml.load(match[1]) as Record<string, unknown>) || {};
  } catch {
    frontmatter = {};
  }
  return { frontmatter, body: match[2] };
}

function stringFieldOrNull(frontmatter: Record<string, unknown>, key: string): string | null {
  const v = frontmatter[key];
  return typeof v === 'string' ? v : null;
}

export function listLibraryAgents(libraryRoot: string | null): AgentListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [], errors: [] };
  }
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  return {
    libraryRoot,
    entries: scan.entries.map(entry =>
      decorateAgentEntry(entry.name, entry.shape, entry.dirPath),
    ),
    errors: scan.errors,
  };
}

export function getLibraryAgent(
  libraryRoot: string | null,
  name: string,
): AgentDetail | null {
  if (!libraryRoot) return null;
  const { agents } = getLibraryPaths(libraryRoot);
  const scan = enumerateLibraryAgents(agents);
  const entry = scan.entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateAgentEntry(entry.name, entry.shape, entry.dirPath);
  const readmePath = path.join(entry.dirPath, 'README.md');
  const memoryBody = readFileIfExists(entry.memoryFile) ?? '';

  return {
    ...base,
    memoryFile: entry.memoryFile,
    readme: readFileIfExists(readmePath),
    memory: memoryBody,
    bundledSkills: bundledSkillNames(entry.dirPath),
  };
}

export function listLibrarySkills(libraryRoot: string | null): SkillListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [] };
  }
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  return {
    libraryRoot,
    entries: entries.map(entry => decorateSkillEntry(entry.name, entry.dirPath, entry.skillFile)),
  };
}

export function getLibrarySkill(
  libraryRoot: string | null,
  name: string,
): SkillDetail | null {
  if (!libraryRoot) return null;
  const { skills } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibrarySkills(skills);
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateSkillEntry(entry.name, entry.dirPath, entry.skillFile);
  const raw = readFileIfExists(entry.skillFile) ?? '';
  const { frontmatter, body } = parseSkillMd(raw);

  // `description` here is the same README-first value as the list entry's:
  // frontmatter `description:` first, then first body paragraph. Keeping
  // detail and list in sync avoids surprising blank fields when frontmatter
  // is absent but the body is informative.
  return {
    ...base,
    skillFile: entry.skillFile,
    skillName: stringFieldOrNull(frontmatter, 'name'),
    description: base.description,
    bodyLength: body.length,
  };
}

function decorateTeamEntry(name: string, dirPath: string): TeamListEntry {
  const readmePath = path.join(dirPath, 'README.md');
  return {
    name,
    hasReadme: fileExists(readmePath),
    hasLicense: fileExists(path.join(dirPath, 'LICENSE')),
    hasTeamYaml: fileExists(path.join(dirPath, 'team.yaml')),
    source_path: dirPath,
    description: readmeFirstParagraph(readFileIfExists(readmePath)),
  };
}

function parseTeamYamlSummary(raw: string): { declaredTeam: string | null; agents: string[] } {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return { declaredTeam: null, agents: [] };
  }
  if (!doc || typeof doc !== 'object') {
    return { declaredTeam: null, agents: [] };
  }
  const obj = doc as Record<string, unknown>;
  const teamRaw = obj.team;
  const declaredTeam = typeof teamRaw === 'string' ? teamRaw : null;

  const agents: string[] = [];
  const agentsRaw = obj.agents;
  if (Array.isArray(agentsRaw)) {
    for (const a of agentsRaw) {
      if (a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string') {
        agents.push((a as Record<string, string>).name);
      }
    }
  }
  return { declaredTeam, agents };
}

export function listLibraryTeams(libraryRoot: string | null): TeamListResult {
  if (!libraryRoot) {
    return { libraryRoot: null, entries: [] };
  }
  const { teams } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibraryTeams(teams);
  return {
    libraryRoot,
    entries: entries.map(entry => decorateTeamEntry(entry.name, entry.dirPath)),
  };
}

export function getLibraryTeam(
  libraryRoot: string | null,
  name: string,
): TeamDetail | null {
  if (!libraryRoot) return null;
  const { teams } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibraryTeams(teams);
  const entry = entries.find(e => e.name === name);
  if (!entry) return null;

  const base = decorateTeamEntry(entry.name, entry.dirPath);
  const readmePath = path.join(entry.dirPath, 'README.md');
  const teamYaml = readFileIfExists(entry.teamYamlFile) ?? '';
  const { declaredTeam, agents } = parseTeamYamlSummary(teamYaml);

  return {
    ...base,
    teamYamlFile: entry.teamYamlFile,
    readme: readFileIfExists(readmePath),
    teamYaml,
    declaredTeam,
    agents,
  };
}

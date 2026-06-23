// SPDX-License-Identifier: MIT
/**
 * Library teams — team-template browse + install for the manager's
 *   GET  /library/teams
 *   GET  /library/teams/:name
 *   POST /library/install   (from: "team:<template>" -> to: "team:<dest>")
 *
 * Self-contained restoration of upstream id-agents (idchain-world/id-agents)
 * team support that the local `library-inventory` rewrite dropped (it deleted
 * src/lib/library-install.ts and the team functions/enumerator). The ID Agents
 * Control Center's Config view calls libraryTeams()/installTeam(), so without
 * these routes that panel 404s against this manager.
 *
 * This module intentionally depends only on `fs`, `path`, and the `yaml`
 * package — NOT on the (rewritten) library-inventory / agent-library internals —
 * so it can be reviewed and reverted in isolation. The top-level `team:` rewrite
 * is done at YAML-Document-AST level so comments, anchors, key order, and any
 * nested `team:` values are preserved (regex/string scanners are forbidden).
 *
 * Restored locally; not yet upstreamed to idchain-world/id-agents.
 */

import fs from 'fs';
import path from 'path';
import { Document, parseDocument, parse as parseYaml } from 'yaml';

const ENTRY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PROVENANCE_PREFIX = '# Installed from configs/teams/';

// ---------------------------------------------------------------------------
// fs helpers (self-contained copies of the upstream private helpers)
// ---------------------------------------------------------------------------
function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function fileExists(p: string): boolean { return isFile(p); }
function readFileIfExists(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}
function direntIsDirectory(dirent: fs.Dirent, parentDir: string): boolean {
  if (dirent.isDirectory()) return true;
  if (dirent.isSymbolicLink()) return isDirectory(path.join(parentDir, dirent.name));
  return false;
}
function isValidEntryName(name: string): boolean {
  return ENTRY_NAME_RE.test(name);
}

/** Absolute path to the library's `teams/` directory. */
function teamsDir(libraryRoot: string): string {
  return path.join(libraryRoot, 'teams');
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------
interface LibraryTeamEntry {
  name: string;
  dirPath: string;
  teamYamlFile: string;
}

/** Enumerate `<teamsDir>/<name>/team.yaml` template directories, sorted by name. */
function enumerateLibraryTeams(dir: string): LibraryTeamEntry[] {
  if (!isDirectory(dir)) return [];

  const entries: LibraryTeamEntry[] = [];
  const children = fs.readdirSync(dir, { withFileTypes: true });

  for (const child of children) {
    if (!direntIsDirectory(child, dir)) continue;
    const name = child.name;
    if (!isValidEntryName(name)) continue;

    const dirPath = path.join(dir, name);
    const teamYamlFile = path.join(dirPath, 'team.yaml');
    if (!isFile(teamYamlFile)) continue;

    entries.push({ name, dirPath, teamYamlFile });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ---------------------------------------------------------------------------
// Listing / detail
// ---------------------------------------------------------------------------
export interface TeamListEntry {
  name: string;
  hasReadme: boolean;
  hasLicense: boolean;
  hasTeamYaml: boolean;
  /** Absolute filesystem path to the team directory. */
  source_path: string;
  /** README-first one-line description, or null. */
  description: string | null;
}

export interface TeamDetail extends TeamListEntry {
  /** Absolute path to the `team.yaml` file. */
  teamYamlFile: string;
  /** README body, or null when no README.md is present. */
  readme: string | null;
  /** Raw `team.yaml` body (UTF-8). */
  teamYaml: string;
  /** Value of the top-level `team:` field, or null if absent/not a string. */
  declaredTeam: string | null;
  /** `agents[].name` from `team.yaml`, in declaration order. */
  agents: string[];
}

export interface TeamListResult {
  libraryRoot: string | null;
  entries: TeamListEntry[];
}

/**
 * Extract a one-line, README-first description from a markdown body.
 * Skips a leading H1/H2 title, blank lines, and non-prose openers
 * (fences, comments, hr/frontmatter, blockquotes).
 */
function readmeFirstParagraph(md: string | null): string | null {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#{1,2}\s+/.test(lines[i])) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { i++; continue; }
    if (t.startsWith('```') || t.startsWith('<!--') || t === '---' || t.startsWith('> ')) {
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
      if (t === '---') { i++; continue; }
      while (i < lines.length && lines[i].trim().startsWith('> ')) i++;
      continue;
    }
    return t;
  }
  return null;
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
    doc = parseYaml(raw);
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
  const entries = enumerateLibraryTeams(teamsDir(libraryRoot));
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
  const entries = enumerateLibraryTeams(teamsDir(libraryRoot));
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

// ---------------------------------------------------------------------------
// Selector grammar
// ---------------------------------------------------------------------------
export interface ParsedSelector {
  kind: string;
  name: string;
}

/**
 * Parse a `kind:name` library selector. Returns null on malformed input.
 * Permissive on kind so future kinds (`agent:` / `skill:`) can be added.
 */
export function parseSelector(selector: unknown): ParsedSelector | null {
  if (typeof selector !== 'string') return null;
  const idx = selector.indexOf(':');
  if (idx <= 0 || idx === selector.length - 1) return null;
  const kind = selector.slice(0, idx);
  const name = selector.slice(idx + 1);
  if (!kind || !name) return null;
  return { kind, name };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
export interface InstallTeamRequest {
  template: string;
  dest: string;
  force?: boolean;
}

export interface InstallTeamSuccess {
  ok: true;
  kind: 'team';
  template: string;
  dest: string;
  destPath: string;
  overwritten: boolean;
  declaredTeamBefore: string | null;
  declaredTeamAfter: string;
}

export interface InstallError {
  ok: false;
  status: number;
  error: string;
  [k: string]: unknown;
}

export type InstallTeamResult = InstallTeamSuccess | InstallError;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function todayYYYYMMDD(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
function stripExistingProvenance(text: string): string {
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) {
    return text.startsWith(PROVENANCE_PREFIX) ? '' : text;
  }
  const firstLine = text.slice(0, firstNewline);
  if (firstLine.startsWith(PROVENANCE_PREFIX)) {
    return text.slice(firstNewline + 1);
  }
  return text;
}
function buildProvenanceHeader(template: string, now: Date): string {
  return `# Installed from configs/teams/${template}/team.yaml on ${todayYYYYMMDD(now)}\n`;
}

/**
 * Install a team template `<libRoot>/teams/<template>/team.yaml` as
 * `<libRoot>/<dest>.yaml`, rewriting the top-level `team:` field to `dest`.
 * Refuses (400) when the template lacks a top-level `team:` unless dest===template.
 */
export function installLibraryTeam(
  libraryRoot: string | null,
  req: InstallTeamRequest,
  now: Date = new Date(),
): InstallTeamResult {
  const { template, dest, force = false } = req;

  if (!libraryRoot) {
    return { ok: false, status: 400, error: 'no_library_root' };
  }
  if (!ENTRY_NAME_RE.test(template)) {
    return { ok: false, status: 400, error: 'bad_template_name', name: template };
  }
  if (!ENTRY_NAME_RE.test(dest)) {
    return { ok: false, status: 400, error: 'bad_dest_name', name: dest };
  }

  const entries = enumerateLibraryTeams(teamsDir(libraryRoot));
  const entry = entries.find(e => e.name === template);
  if (!entry) {
    return { ok: false, status: 404, error: 'not_found', resource: 'library-team', name: template };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(entry.teamYamlFile, 'utf-8');
  } catch (e) {
    return { ok: false, status: 500, error: 'read_failed', message: (e as Error).message };
  }

  const sourceForParse = stripExistingProvenance(raw);

  let doc: Document.Parsed;
  try {
    doc = parseDocument(sourceForParse);
  } catch (e) {
    return { ok: false, status: 400, error: 'parse_failed', message: (e as Error).message };
  }
  if (doc.errors.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'parse_failed',
      message: doc.errors.map(e => e.message).join('; '),
    };
  }

  const beforeNode = doc.get('team');
  const declaredTeamBefore = typeof beforeNode === 'string' ? beforeNode : null;
  if (declaredTeamBefore === null && dest !== template) {
    return {
      ok: false,
      status: 400,
      error: 'missing_team_field',
      template,
      message:
        `Template team.yaml has no top-level \`team:\` field; refusing to ` +
        `install to a different name. Either add \`team: ${template}\` at ` +
        `the top of the template or install with to=team:${template}.`,
    };
  }

  doc.set('team', dest);

  const afterNode = doc.get('team');
  if (typeof afterNode !== 'string' || afterNode !== dest) {
    return {
      ok: false,
      status: 500,
      error: 'rewrite_failed',
      message: 'YAML AST set did not produce the expected top-level team value.',
    };
  }

  const rewrittenBody = doc.toString();
  const header = buildProvenanceHeader(template, now);
  const finalContent = header + rewrittenBody;

  const destPath = path.join(libraryRoot, `${dest}.yaml`);
  const sourceAbs = path.resolve(entry.teamYamlFile);
  const destAbs = path.resolve(destPath);
  if (sourceAbs === destAbs) {
    return {
      ok: false,
      status: 400,
      error: 'dest_is_source',
      message: 'Refusing to overwrite the source template.',
    };
  }

  const exists = isFile(destPath);
  if (exists && !force) {
    return {
      ok: false,
      status: 409,
      error: 'dest_exists',
      destPath,
      message:
        `${destPath} already exists. Re-run with force:true to overwrite ` +
        `(force will not overwrite the source template).`,
    };
  }

  const dir = path.dirname(destPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(destPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(tmpPath, finalContent, 'utf-8');
    fs.renameSync(tmpPath, destPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, status: 500, error: 'write_failed', message: (e as Error).message };
  }

  return {
    ok: true,
    kind: 'team',
    template,
    dest,
    destPath,
    overwritten: exists,
    declaredTeamBefore,
    declaredTeamAfter: dest,
  };
}

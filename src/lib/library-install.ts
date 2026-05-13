// SPDX-License-Identifier: MIT
/**
 * Library install — slice 1 (team kind).
 *
 * Implements `POST /library/install` with selector grammar
 *   `from: "team:<template>"` → `to: "team:<dest>"`
 *
 * Hard requirements (from the cto-approved API surface in
 * `output/team-library-backend-slice-1-proposal.md`):
 *   - Top-level `team:` rewrite is done at YAML-Document-AST level via
 *     the `yaml` package. Regex / string scanners are forbidden so
 *     nested `team:` keys inside maps, tags, or strings remain intact.
 *   - Refuse with HTTP 400 when the template lacks a top-level `team:`
 *     field, *unless* `dest === template` (self-install can't create
 *     a divergent identity).
 *   - `force:true` may overwrite only `<libRoot>/<dest>.yaml`, never
 *     the source template under `<libRoot>/teams/<template>/`.
 *   - Prepend a provenance header
 *       `# Installed from configs/teams/<template>/team.yaml on YYYY-MM-DD`
 *     to the written file. Replace an existing leading header rather
 *     than stacking it.
 */

import fs from 'fs';
import path from 'path';
import { Document, parseDocument } from 'yaml';

import {
  enumerateLibraryTeams,
  getLibraryPaths,
} from './agent-library.js';

const ENTRY_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PROVENANCE_PREFIX = '# Installed from configs/teams/';

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

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function todayYYYYMMDD(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function stripExistingProvenance(text: string): string {
  // First-line-only: never touch anything past the first newline.
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

export interface ParsedSelector {
  kind: string;
  name: string;
}

/**
 * Parse a `kind:name` library selector. Returns null on malformed input.
 * Permissive on kind so future slices can introduce `agent:` / `skill:`.
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

  const { teams } = getLibraryPaths(libraryRoot);
  const entries = enumerateLibraryTeams(teams);
  const entry = entries.find(e => e.name === template);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      resource: 'library-team',
      name: template,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(entry.teamYamlFile, 'utf-8');
  } catch (e) {
    return { ok: false, status: 500, error: 'read_failed', message: (e as Error).message };
  }

  // Strip a stray leading provenance header on the source if present,
  // so it never leaks into the destination body. First-line-only.
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

  // Approval guard. doc.get('team') returns the top-level scalar; nested
  // `team:` inside maps/tags/strings is never reachable here because we
  // only consult the document root.
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

  // Top-level AST rewrite. Only the document root's `team` entry is
  // touched; everything else (comments, anchors, key order, nested
  // `team:` values inside maps/tags/strings) is preserved by the
  // Document CST.
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

// SPDX-License-Identifier: MIT
/**
 * Runtime validation at the manager <-> client boundary.
 *
 * The manager is a separate process; its JSON is `unknown` until proven
 * otherwise. These parsers NARROW untrusted payloads into the DTO shapes in
 * `./types.ts`:
 *   - every REQUIRED wire field is checked for presence and type;
 *   - every OPTIONAL field is type-checked when present (including array element
 *     types and `x | null` unions);
 *   - a structurally malformed response throws a typed `ManagerError` — never an
 *     unchecked field access, and never a blind `as DTO` on an unvalidated row.
 *
 * Compatibility rule: every payload the previous implementation accepted is
 * still accepted. A missing/nullish collection is treated as empty (valid, not
 * malformed); only a present-but-wrong-typed collection, a row missing a
 * required field, or a wrong-typed field is rejected.
 */

import { ManagerError } from './errors.js';
import type {
  Agent,
  InstallLibraryTeamSuccess,
  LibraryAgentDetailResponse,
  LibraryAgentListResponse,
  LibraryAgentRow,
  LibrarySkillDetailResponse,
  LibrarySkillListResponse,
  LibrarySkillRow,
  LibraryTeamDetailResponse,
  LibraryTeamListResponse,
  LibraryTeamRow,
  NewsItem,
  RemoteEnvelope,
  Schedule,
  Task,
  Team,
} from './types.js';

/* ---------------- primitive guards ---------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

type Guard = (v: unknown) => boolean;

const gString: Guard = isString;
const gNumber: Guard = isNumber;
const gBoolean: Guard = isBoolean;
const gRecord: Guard = isRecord;
const gStringOrNull: Guard = (v) => v === null || isString(v);
const gNumberOrNull: Guard = (v) => v === null || isNumber(v);
const gStringArray: Guard = (v) => Array.isArray(v) && v.every(isString);
const gOneOf =
  (...options: string[]): Guard =>
  (v) =>
    isString(v) && options.includes(v);

/** Narrow `value` to an array, or `[]` when it is not an array. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Read `key` off a record-ish value without throwing on non-objects. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function malformed(context: string, reason: string): never {
  throw new ManagerError(`malformed ${context}: ${reason}`);
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) malformed(context, 'expected a JSON object');
  return value;
}

type FieldSpec = Record<string, [Guard, string]>;

/**
 * Validate an object against required + optional field specs, then return it.
 * Required fields must be present and pass their guard; optional fields are
 * checked only when present (undefined is allowed, but a present wrong-typed
 * value is malformed). The returned value is the same object — every DECLARED
 * field has now been guarded, so the caller's `as DTO` is honest.
 */
function validateShape(
  value: unknown,
  context: string,
  required: FieldSpec,
  optional: FieldSpec = {},
): Record<string, unknown> {
  const row = expectRecord(value, context);
  for (const key of Object.keys(required)) {
    const [guard, expected] = required[key]!;
    if (row[key] === undefined) malformed(context, `missing required "${key}" (${expected})`);
    if (!guard(row[key])) malformed(context, `"${key}" must be ${expected}`);
  }
  for (const key of Object.keys(optional)) {
    const v = row[key];
    if (v === undefined) continue;
    const [guard, expected] = optional[key]!;
    if (!guard(v)) malformed(context, `"${key}" must be ${expected}`);
  }
  return row;
}

/* ---------------- core DTO row parsers ---------------- */

export function parseTeam(value: unknown, context = 'team'): Team {
  return validateShape(
    value,
    context,
    { name: [gString, 'a string'] },
    { id: [gString, 'a string'], agentCount: [gNumber, 'a number'], createdAt: [gString, 'a string'] },
  ) as unknown as Team;
}

export function parseAgent(value: unknown, context = 'agent'): Agent {
  return validateShape(
    value,
    context,
    { id: [gString, 'a string'], name: [gString, 'a string'] },
    {
      alias: [gString, 'a string'],
      port: [gNumberOrNull, 'a number or null'],
      status: [gString, 'a string'],
      health: [gString, 'a string'],
      model: [gString, 'a string'],
      type: [gString, 'a string'],
      url: [gStringOrNull, 'a string or null'],
      workingDirectory: [gStringOrNull, 'a string or null'],
      createdAt: [gNumber, 'a number'],
      lastHealthCheck: [gNumber, 'a number'],
      metadata: [gRecord, 'an object'],
      teamName: [gString, 'a string'],
      deploymentShape: [gOneOf('local-process', 'remote-endpoint'), 'local-process|remote-endpoint'],
      pid: [gNumberOrNull, 'a number or null'],
      customer_domain: [gStringOrNull, 'a string or null'],
      public_endpoint_url: [gStringOrNull, 'a string or null'],
      ows_wallet: [gStringOrNull, 'a string or null'],
      idchain_domain: [gStringOrNull, 'a string or null'],
      ssh_target: [gStringOrNull, 'a string or null'],
      last_seen: [gNumberOrNull, 'a number or null'],
      last_probed_at: [gNumberOrNull, 'a number or null'],
      last_error: [gStringOrNull, 'a string or null'],
      consecutive_failures: [gNumber, 'a number'],
    },
  ) as unknown as Agent;
}

export function parseTask(value: unknown, context = 'task'): Task {
  return validateShape(
    value,
    context,
    {
      name: [gString, 'a string'],
      title: [gString, 'a string'],
      status: [gString, 'a string'],
      createdAt: [gNumber, 'a number'],
    },
    {
      uuid: [gString, 'a string'],
      shortId: [gString, 'a string'],
      description: [gStringOrNull, 'a string or null'],
      ownerName: [gStringOrNull, 'a string or null'],
      teamName: [gString, 'a string'],
      linkedEvents: [gStringArray, 'an array of strings'],
      updatedAt: [gNumber, 'a number'],
      completedAt: [gNumberOrNull, 'a number or null'],
    },
  ) as unknown as Task;
}

export function parseNewsItem(value: unknown, context = 'news item'): NewsItem {
  return validateShape(
    value,
    context,
    { type: [gString, 'a string'], timestamp: [gNumber, 'a number'] },
    { message: [gString, 'a string'] },
  ) as unknown as NewsItem;
}

export function parseSchedule(value: unknown, context = 'schedule'): Schedule {
  return validateShape(
    value,
    context,
    {
      id: [gString, 'a string'],
      title: [gString, 'a string'],
      kind: [gString, 'a string'],
      active: [gBoolean, 'a boolean'],
      targets: [gStringArray, 'an array of strings'],
      intervalSeconds: [gNumberOrNull, 'a number or null'],
      timezone: [gStringOrNull, 'a string or null'],
      localTimeSeconds: [gNumberOrNull, 'a number or null'],
      localDate: [gStringOrNull, 'a string or null'],
      daysOfWeek: [gStringOrNull, 'a string or null'],
      createdAt: [gNumber, 'a number'],
    },
    {
      deliveryMode: [gString, 'a string'],
      sourceType: [gString, 'a string'],
      teamName: [gString, 'a string'],
    },
  ) as unknown as Schedule;
}

/* ---------------- collection parsers ---------------- */

/**
 * Resolve `container[key]` as an array. Missing / null → `[]` (preserves the
 * historical `?? []` behavior). Present-but-not-an-array → malformed.
 */
function listField(container: unknown, key: string, context: string): unknown[] {
  const v = field(container, key);
  if (v == null) return [];
  if (!Array.isArray(v)) malformed(context, `"${key}" is present but not an array`);
  return v;
}

export function parseTeamsResponse(data: unknown): Team[] {
  return listField(data, 'teams', 'teams response').map((t) => parseTeam(t));
}

export function parseAgentsResponse(data: unknown): Agent[] {
  return listField(data, 'agents', 'agents response').map((a) => parseAgent(a));
}

/** `result.tasks` → `Task[]` (missing → []). */
export function parseTaskResult(result: unknown): Task[] {
  return listField(result, 'tasks', 'tasks result').map((t) => parseTask(t));
}

/** `result.items` → `NewsItem[]` (missing → []). */
export function parseNewsResult(result: unknown): NewsItem[] {
  return listField(result, 'items', 'news result').map((n) => parseNewsItem(n));
}

/** `result.schedules` → `Schedule[]` (missing → []). */
export function parseScheduleResult(result: unknown): Schedule[] {
  return listField(result, 'schedules', 'schedules result').map((s) => parseSchedule(s));
}

/**
 * Narrow a `/remote` proxy response into a typed envelope. `ok` is coerced to a
 * strict boolean so `!ok` branches are predictable; a non-object payload is a
 * malformed envelope.
 */
export function parseRemoteEnvelope<T>(data: unknown): RemoteEnvelope<T> {
  if (!isRecord(data)) {
    return { ok: false, error: 'malformed manager response: expected a JSON object' };
  }
  return {
    ok: data.ok === true,
    result: data.result as T | undefined,
    error: isString(data.error) ? data.error : undefined,
  };
}

/** Stamp a `teamName` onto every schedule row (post-fetch normalization). */
export function withTeamName(schedules: Schedule[], teamName: string): Schedule[] {
  return schedules.map((s) => ({ ...s, teamName }));
}

/* ---------------- library DTO parsers ---------------- */

const LIBRARY_AGENT_ROW: FieldSpec = {
  name: [gString, 'a string'],
  shape: [gOneOf('claude-native', 'agents-md-native'), 'claude-native|agents-md-native'],
  hasReadme: [gBoolean, 'a boolean'],
  hasLicense: [gBoolean, 'a boolean'],
  subfolders: [gStringArray, 'an array of strings'],
  source_path: [gString, 'a string'],
  description: [gStringOrNull, 'a string or null'],
};

const LIBRARY_SKILL_ROW: FieldSpec = {
  name: [gString, 'a string'],
  hasSkillMd: [gBoolean, 'a boolean'],
  source_path: [gString, 'a string'],
  description: [gStringOrNull, 'a string or null'],
};

const LIBRARY_TEAM_ROW: FieldSpec = {
  name: [gString, 'a string'],
  hasReadme: [gBoolean, 'a boolean'],
  hasLicense: [gBoolean, 'a boolean'],
  hasTeamYaml: [gBoolean, 'a boolean'],
  source_path: [gString, 'a string'],
  description: [gStringOrNull, 'a string or null'],
};

function parseLibraryErrors(
  value: unknown,
  context: string,
): Array<{ name: string; code: string; message: string }> {
  return listField(value, 'errors', context).map((e) => {
    validateShape(e, `${context} error`, {
      name: [gString, 'a string'],
      code: [gString, 'a string'],
      message: [gString, 'a string'],
    });
    return e as { name: string; code: string; message: string };
  });
}

function libraryRoot(root: Record<string, unknown>, context: string): string | null {
  const v = root.libraryRoot;
  if (v === undefined || v === null) return null;
  if (!isString(v)) malformed(context, '"libraryRoot" must be a string or null');
  return v;
}

export function parseLibraryAgentList(data: unknown): LibraryAgentListResponse {
  const ctx = 'library agents response';
  const root = expectRecord(data, ctx);
  return {
    libraryRoot: libraryRoot(root, ctx),
    entries: listField(root, 'entries', ctx).map(
      (e) => validateShape(e, 'library agent', LIBRARY_AGENT_ROW) as unknown as LibraryAgentRow,
    ),
    errors: parseLibraryErrors(root, ctx),
  };
}

export function parseLibrarySkillList(data: unknown): LibrarySkillListResponse {
  const ctx = 'library skills response';
  const root = expectRecord(data, ctx);
  return {
    libraryRoot: libraryRoot(root, ctx),
    entries: listField(root, 'entries', ctx).map(
      (e) => validateShape(e, 'library skill', LIBRARY_SKILL_ROW) as unknown as LibrarySkillRow,
    ),
  };
}

export function parseLibraryTeamList(data: unknown): LibraryTeamListResponse {
  const ctx = 'library teams response';
  const root = expectRecord(data, ctx);
  return {
    libraryRoot: libraryRoot(root, ctx),
    entries: listField(root, 'entries', ctx).map(
      (e) => validateShape(e, 'library team', LIBRARY_TEAM_ROW) as unknown as LibraryTeamRow,
    ),
  };
}

export function parseLibraryAgentDetail(data: unknown): LibraryAgentDetailResponse {
  validateShape(data, 'library agent detail', {
    ...LIBRARY_AGENT_ROW,
    memoryFile: [gString, 'a string'],
    readme: [gStringOrNull, 'a string or null'],
    memory: [gString, 'a string'],
    bundledSkills: [gStringArray, 'an array of strings'],
  });
  return data as LibraryAgentDetailResponse;
}

export function parseLibrarySkillDetail(data: unknown): LibrarySkillDetailResponse {
  validateShape(data, 'library skill detail', {
    ...LIBRARY_SKILL_ROW,
    skillFile: [gString, 'a string'],
    skillName: [gStringOrNull, 'a string or null'],
    bodyLength: [gNumber, 'a number'],
  });
  return data as LibrarySkillDetailResponse;
}

export function parseLibraryTeamDetail(data: unknown): LibraryTeamDetailResponse {
  validateShape(data, 'library team detail', {
    ...LIBRARY_TEAM_ROW,
    teamYamlFile: [gString, 'a string'],
    readme: [gStringOrNull, 'a string or null'],
    teamYaml: [gString, 'a string'],
    declaredTeam: [gStringOrNull, 'a string or null'],
    agents: [gStringArray, 'an array of strings'],
  });
  return data as LibraryTeamDetailResponse;
}

/**
 * Validate a `/library/install` SUCCESS body. The failure body is normalized by
 * the client itself; this guards the success discriminant and its fields so a
 * malformed "success" is surfaced as a `ManagerError` rather than cast blindly.
 */
export function parseInstallSuccess(data: unknown): InstallLibraryTeamSuccess {
  const row = validateShape(data, 'install success', {
    kind: [gOneOf('team'), '"team"'],
    template: [gString, 'a string'],
    dest: [gString, 'a string'],
    destPath: [gString, 'a string'],
    overwritten: [gBoolean, 'a boolean'],
    declaredTeamBefore: [gStringOrNull, 'a string or null'],
    declaredTeamAfter: [gString, 'a string'],
  });
  if (row.ok !== true) malformed('install success', '"ok" must be true');
  return row as unknown as InstallLibraryTeamSuccess;
}

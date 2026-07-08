// SPDX-License-Identifier: MIT

export type SpecialistOwnerTeam =
  | 'legal'
  | 'onchain-execution'
  | 'research'
  | 'technology-security';

export interface SpecialistRoutingDecision {
  ownerTeam: SpecialistOwnerTeam;
  reason: string;
  matchedSignals: string[];
}

export interface SpecialistRoutingInput {
  title?: unknown;
  name?: unknown;
  description?: unknown;
  currentTeam?: unknown;
  explicitTeam?: unknown;
}

const GENERIC_LEARN_ORIGINS = new Set(['default', 'ops-team', 'research']);
const SPECIALIST_TEAMS = new Set<string>([
  'legal',
  'onchain-execution',
  'research',
  'technology-security',
]);

const DOMAIN_RULES: Array<{
  team: SpecialistOwnerTeam;
  label: string;
  highConfidence: RegExp[];
  weak: RegExp[];
}> = [
  {
    team: 'legal',
    label: 'legal/compliance',
    highConfidence: [
      /\b(?:legal|counsel|compliance|regulatory|ip[-_\s]?counsel)\b/i,
      /\b(?:license|licensing|terms[-_\s]?of[-_\s]?service|privacy[-_\s]?policy)\b/i,
    ],
    weak: [
      /\b(?:contract terms|copyright|trademark|policy review|terms)\b/i,
    ],
  },
  {
    team: 'onchain-execution',
    label: 'onchain/execution',
    highConfidence: [
      /\b(?:on[-_\s]?chain|evm|ethereum|solidity|smart[-_\s]?contract|erc[-_\s]?\d+|eip[-_\s]?\d+)\b/i,
      /\b(?:ens|safe|multisig|wallet|treasury|token|governance|registry|x402)\b/i,
    ],
    weak: [
      /\b(?:contract[-_\s]?audit|calldata|rpc|staking|liquidity|defi|dao)\b/i,
    ],
  },
  {
    team: 'technology-security',
    label: 'security',
    highConfidence: [
      /\b(?:security|threat[-_\s]?model|vulnerabilit(?:y|ies)|exploit|abuse[-_\s]?path)\b/i,
      /\b(?:supply[-_\s]?chain|secret(?:s)?|auth(?:n|z|entication|orization)?|prompt[-_\s]?injection)\b/i,
    ],
    weak: [
      /\b(?:risk gate|permission|sandbox|untrusted|data exposure|guardrail)\b/i,
    ],
  },
  {
    team: 'research',
    label: 'research/source-grounding',
    highConfidence: [
      /\b(?:research|source[-_\s]?ground(?:ed|ing)|fact[-_\s]?check|evidence review)\b/i,
      /\b(?:paper|literature|benchmark|primary[-_\s]?source|goal[-_\s]?fit verdict)\b/i,
    ],
    weak: [
      /\b(?:claim verification|source fit|memory fit|facts?)\b/i,
    ],
  },
];

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTeam(value: unknown): string {
  return asText(value).trim().toLowerCase();
}

function isLearnOrGoalRoutingMaterial(text: string): boolean {
  return /\b(?:idacc\s+learn|learn(?:ed)?\s+material|learn\s+routing|recursive\s+learn|source\s+learn)\b/i.test(text)
    || /\blearn[-_\s][a-z0-9._-]+[-_\s](?:fit|review|digest|triage|routing)\b/i.test(text)
    || /^learn[-_]/i.test(text)
    || /\bgoal\s+id\s*:\s*goal_/i.test(text)
    || /\[goal:goal_[^\]]+\]/i.test(text);
}

function scoreRule(rule: (typeof DOMAIN_RULES)[number], priorityText: string, fullText: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  for (const pattern of rule.highConfidence) {
    if (pattern.test(priorityText)) {
      score += 4;
      signals.push(`${rule.label}:title`);
    } else if (pattern.test(fullText)) {
      score += 2;
      signals.push(`${rule.label}:body`);
    }
  }
  for (const pattern of rule.weak) {
    if (pattern.test(priorityText)) {
      score += 2;
      signals.push(`${rule.label}:title-weak`);
    } else if (pattern.test(fullText)) {
      score += 1;
      signals.push(`${rule.label}:body-weak`);
    }
  }
  return { score, signals: Array.from(new Set(signals)) };
}

export function inferSpecialistOwnerTeam(input: SpecialistRoutingInput): SpecialistRoutingDecision | null {
  const currentTeam = normalizeTeam(input.currentTeam);
  const explicitTeam = normalizeTeam(input.explicitTeam);
  const originTeam = explicitTeam || currentTeam;

  if (!GENERIC_LEARN_ORIGINS.has(originTeam)) return null;

  const priorityText = [
    asText(input.name),
    asText(input.title),
  ].join('\n');
  const fullText = [
    priorityText,
    asText(input.description),
  ].join('\n');

  if (!isLearnOrGoalRoutingMaterial(fullText)) return null;

  const scored = DOMAIN_RULES
    .map((rule) => ({ rule, ...scoreRule(rule, priorityText, fullText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const [best, second] = scored;
  if (best.score < 4) return null;
  if (second && second.rule.team !== 'research' && second.score >= best.score) return null;
  if (SPECIALIST_TEAMS.has(originTeam) && originTeam === best.rule.team) return null;

  return {
    ownerTeam: best.rule.team,
    reason: `high-confidence ${best.rule.label} Learn/goal routing signal`,
    matchedSignals: best.signals,
  };
}

export function appendSpecialistRoutingNote(
  description: string | null | undefined,
  fromTeam: string,
  decision: SpecialistRoutingDecision,
): string {
  const note = `Manager specialist routing: ${fromTeam || 'default'} to ${decision.ownerTeam} (${decision.reason}; signals: ${decision.matchedSignals.join(', ') || 'domain'}).`;
  return [description?.trim(), note].filter(Boolean).join('\n\n');
}

// SPDX-License-Identifier: MIT

export type InferredEntityEdgeKind = 'mentions' | 'uses' | 'part-of';

export interface KnownEntityForEdgeInference {
  id: string;
  name?: string | null;
  type?: string | null;
  description?: string | null;
  data?: Record<string, unknown> | null;
}

export interface TextUnitForEdgeInference {
  id?: number | string | null;
  title?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TimelineEventForEdgeInference {
  id?: number | string | null;
  source?: string | null;
  type?: string | null;
  subject?: string | null;
  data?: Record<string, unknown> | null;
}

export interface InferredEntityEdge {
  from: string;
  to: string;
  kind: InferredEntityEdgeKind;
}

export interface EntityEdgeInferenceInput {
  entities: KnownEntityForEdgeInference[];
  textUnits?: TextUnitForEdgeInference[];
  timelineEvents?: TimelineEventForEdgeInference[];
  texts?: string[];
}

type EntityMatcher = {
  entity: KnownEntityForEdgeInference;
  aliases: string[];
};

const USES_RE = /\b(uses?|using|depends on|depends upon|requires?|calls?|integrates with|built on|powered by)\b/i;
const PART_OF_RE = /\b(part of|belongs to|within|under|inside)\b/i;
const PARENT_KEYS = new Set(['parent_entity_id', 'parentEntityId', 'parent_id', 'parentId', 'project_id', 'projectId']);

export function inferEntityEdges(input: EntityEdgeInferenceInput): InferredEntityEdge[] {
  const matchers = buildEntityMatchers(input.entities);
  const knownIds = new Set(matchers.map((matcher) => matcher.entity.id));
  const edges = new Map<string, InferredEntityEdge>();
  const addEdge = (from: string, to: string, kind: InferredEntityEdgeKind) => {
    if (!from || !to || from === to || !knownIds.has(from) || !knownIds.has(to)) return;
    const key = `${kind}\0${from}\0${to}`;
    edges.set(key, { from, to, kind });
  };

  for (const matcher of matchers) {
    const entity = matcher.entity;
    const description = compactText(entity.description);
    const dataText = stringifyData(entity.data);
    const entityText = [description, dataText].filter(Boolean).join('\n');
    const mentioned = findMentionedEntities(entityText, matchers).filter((id) => id !== entity.id);
    for (const id of mentioned) addEdge(entity.id, id, 'mentions');
    addExplicitRelationEdges(entity.id, entityText, mentioned, matchers, addEdge);
    addParentEdges(entity, knownIds, addEdge);
  }

  for (const unit of input.textUnits || []) {
    const unitText = [unit.title, unit.content, stringifyData(unit.metadata)].filter(Boolean).join('\n');
    addPairwiseMentionEdges(findMentionedEntities(unitText, matchers), addEdge);
    addTextLevelRelationEdges(unitText, matchers, addEdge);
  }

  for (const event of input.timelineEvents || []) {
    const eventText = [event.source, event.type, event.subject, stringifyData(event.data)].filter(Boolean).join('\n');
    const mentioned = findMentionedEntities(eventText, matchers);
    if (event.subject && knownIds.has(event.subject)) {
      for (const id of mentioned) addEdge(event.subject, id, 'mentions');
      addExplicitRelationEdges(event.subject, eventText, mentioned.filter((id) => id !== event.subject), matchers, addEdge);
    } else {
      addPairwiseMentionEdges(mentioned, addEdge);
      addTextLevelRelationEdges(eventText, matchers, addEdge);
    }
  }

  for (const text of input.texts || []) {
    addPairwiseMentionEdges(findMentionedEntities(text, matchers), addEdge);
    addTextLevelRelationEdges(text, matchers, addEdge);
  }

  return [...edges.values()].sort((a, b) => (
    a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  ));
}

function buildEntityMatchers(entities: KnownEntityForEdgeInference[]): EntityMatcher[] {
  const seen = new Set<string>();
  return entities
    .filter((entity) => entity?.id && !seen.has(entity.id) && (seen.add(entity.id), true))
    .map((entity) => ({
      entity,
      aliases: unique([entity.name || '', entity.id, entity.id.split(':').at(-1) || ''])
        .map((alias) => alias.trim())
        .filter((alias) => alias.length >= 2)
        .sort((a, b) => b.length - a.length || a.localeCompare(b)),
    }));
}

function findMentionedEntities(text: string, matchers: EntityMatcher[]): string[] {
  const haystack = compactText(text);
  if (!haystack) return [];
  return matchers
    .filter((matcher) => matcher.aliases.some((alias) => containsAlias(haystack, alias)))
    .map((matcher) => matcher.entity.id)
    .sort();
}

function addPairwiseMentionEdges(
  mentioned: string[],
  addEdge: (from: string, to: string, kind: InferredEntityEdgeKind) => void,
): void {
  const ids = unique(mentioned).sort();
  if (ids.length < 2) return;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      addEdge(ids[i], ids[j], 'mentions');
    }
  }
}

function addExplicitRelationEdges(
  ownerId: string,
  text: string,
  mentioned: string[],
  matchers: EntityMatcher[],
  addEdge: (from: string, to: string, kind: InferredEntityEdgeKind) => void,
): void {
  const haystack = compactText(text);
  if (!haystack) return;
  for (const id of unique(mentioned).sort()) {
    const matcher = matchers.find((item) => item.entity.id === id);
    if (!matcher) continue;
    const relationWindow = matcher.aliases.some((alias) => relationAppearsBeforeAlias(haystack, alias, USES_RE));
    if (relationWindow) addEdge(ownerId, id, 'uses');
    const partOfWindow = matcher.aliases.some((alias) => relationAppearsBeforeAlias(haystack, alias, PART_OF_RE));
    if (partOfWindow) addEdge(ownerId, id, 'part-of');
  }
}

function addTextLevelRelationEdges(
  text: string,
  matchers: EntityMatcher[],
  addEdge: (from: string, to: string, kind: InferredEntityEdgeKind) => void,
): void {
  const haystack = compactText(text);
  if (!haystack) return;
  for (const from of matchers) {
    for (const to of matchers) {
      if (from.entity.id === to.entity.id) continue;
      if (relationAppearsBetweenAliases(haystack, from.aliases, to.aliases, USES_RE)) {
        addEdge(from.entity.id, to.entity.id, 'uses');
      }
      if (relationAppearsBetweenAliases(haystack, from.aliases, to.aliases, PART_OF_RE)) {
        addEdge(from.entity.id, to.entity.id, 'part-of');
      }
    }
  }
}

function addParentEdges(
  entity: KnownEntityForEdgeInference,
  knownIds: Set<string>,
  addEdge: (from: string, to: string, kind: InferredEntityEdgeKind) => void,
): void {
  if (!entity.data) return;
  for (const [key, value] of Object.entries(entity.data)) {
    if (!PARENT_KEYS.has(key)) continue;
    const parentId = typeof value === 'string' ? value : null;
    if (parentId && knownIds.has(parentId)) addEdge(entity.id, parentId, 'part-of');
  }
}

function relationAppearsBeforeAlias(text: string, alias: string, relation: RegExp): boolean {
  const aliasRe = aliasRegex(alias);
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, match.index - 80), match.index);
    if (relation.test(prefix)) return true;
  }
  return false;
}

function relationAppearsBetweenAliases(text: string, fromAliases: string[], toAliases: string[], relation: RegExp): boolean {
  for (const fromAlias of fromAliases) {
    const fromRe = aliasRegex(fromAlias);
    let fromMatch: RegExpExecArray | null;
    while ((fromMatch = fromRe.exec(text)) !== null) {
      const afterFrom = text.slice(fromMatch.index + fromMatch[0].length, fromMatch.index + fromMatch[0].length + 120);
      if (!relation.test(afterFrom)) continue;
      for (const toAlias of toAliases) {
        if (containsAlias(afterFrom, toAlias)) return true;
      }
    }
  }
  return false;
}

function containsAlias(text: string, alias: string): boolean {
  return aliasRegex(alias).test(text);
}

function aliasRegex(alias: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(alias.toLowerCase())}([^a-z0-9]|$)`, 'gi');
}

function stringifyData(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

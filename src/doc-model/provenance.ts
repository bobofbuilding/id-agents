export type DocModelOrigin =
  | "substrate"
  | "markdown_walk"
  | "federation"
  | "manual"
  | "migration"
  | "dispatch";

export interface ActorRef {
  type: "agent" | "user" | "system" | "service";
  id: string;
}

export interface ProvenanceRevision {
  at: string;
  by: ActorRef;
  note: string | null;
}

export interface EntryProvenance {
  actor_ref: ActorRef | null;
  source: string | null;
  origin: DocModelOrigin | null;
  source_dispatch_phid: string | null;
  derived_from: string[];
  revisions: ProvenanceRevision[];
  contributors: ActorRef[];
}

export interface OpLogRow {
  op_id: number;
  ts: string;
  actor: string;
  op_type: string;
  payload_json?: string | null;
}

export function parseActorRef(raw: string | null | undefined): ActorRef {
  const value = (raw ?? "").trim();
  if (!value) return { type: "system", id: "system" };

  const colon = value.indexOf(":");
  if (colon > 0) {
    const prefix = value.slice(0, colon).toLowerCase();
    const id = value.slice(colon + 1) || value;
    if (prefix === "user") return { type: "user", id };
    if (prefix === "agent") return { type: "agent", id };
    if (prefix === "system") return { type: "system", id };
    if (prefix === "service") return { type: "service", id };
  }

  if (value === "system") return { type: "system", id: "system" };
  if (value === "operator") return { type: "user", id: "operator" };
  return { type: "agent", id: value };
}

function revisionNote(op: OpLogRow): string | null {
  if (op.payload_json) {
    try {
      const parsed = JSON.parse(op.payload_json) as { note?: unknown };
      if (typeof parsed.note === "string" && parsed.note.trim()) return parsed.note.trim();
    } catch {
      // Invalid payload JSON should not prevent projecting provenance.
    }
  }

  return op.op_type;
}

function dedupeContributors(revisions: ProvenanceRevision[]): ActorRef[] {
  const contributors: ActorRef[] = [];
  const seen = new Set<string>();

  for (const revision of revisions) {
    const key = `${revision.by.type}:${revision.by.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      contributors.push(revision.by);
    }
  }

  return contributors;
}

export function buildProvenanceFromOpLog(
  ops: OpLogRow[],
  seed: {
    source?: string | null;
    origin?: DocModelOrigin | null;
    actor_ref?: ActorRef | null;
    source_dispatch_phid?: string | null;
    derived_from?: string[];
  } = {},
): EntryProvenance {
  const revisions = [...ops]
    .sort((a, b) => a.op_id - b.op_id)
    .map((op) => ({
      at: op.ts,
      by: parseActorRef(op.actor),
      note: revisionNote(op),
    }));
  const contributors = dedupeContributors(revisions);

  return {
    actor_ref: seed.actor_ref ?? contributors[0] ?? null,
    source: seed.source ?? null,
    origin: seed.origin ?? null,
    source_dispatch_phid: seed.source_dispatch_phid ?? null,
    derived_from: seed.derived_from ?? [],
    revisions,
    contributors,
  };
}

export function finalizeEntryProvenance(
  base: EntryProvenance,
  actor_ref?: ActorRef | null,
): EntryProvenance {
  return {
    ...base,
    actor_ref: actor_ref ?? base.actor_ref ?? base.contributors[0] ?? null,
  };
}

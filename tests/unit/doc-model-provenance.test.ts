import { describe, expect, it } from "vitest";
import {
  buildProvenanceFromOpLog,
  finalizeEntryProvenance,
  parseActorRef,
} from "../../src/doc-model/provenance.js";

describe("parseActorRef", () => {
  it("maps prefixed, well-known, and bare actor refs", () => {
    expect(parseActorRef("user:chris")).toEqual({ type: "user", id: "chris" });
    expect(parseActorRef("agent:regina")).toEqual({ type: "agent", id: "regina" });
    expect(parseActorRef("service:indexer")).toEqual({ type: "service", id: "indexer" });
    expect(parseActorRef("system")).toEqual({ type: "system", id: "system" });
    expect(parseActorRef("operator")).toEqual({ type: "user", id: "operator" });
    expect(parseActorRef("roger")).toEqual({ type: "agent", id: "roger" });
    expect(parseActorRef("")).toEqual({ type: "system", id: "system" });
  });
});

describe("buildProvenanceFromOpLog", () => {
  it("builds revisions and contributors in op_id order with seed fields", () => {
    const provenance = buildProvenanceFromOpLog(
      [
        { op_id: 2, ts: "t2", actor: "user:liz", op_type: "DESK_DISMISS" },
        { op_id: 1, ts: "t1", actor: "user:chris", op_type: "DESK_ADD" },
        { op_id: 3, ts: "t3", actor: "user:chris", op_type: "DESK_UPDATE" },
      ],
      {
        source: "/Desk.md#item",
        origin: "manual",
        actor_ref: { type: "user", id: "chris" },
        source_dispatch_phid: "dispatch_123",
        derived_from: ["art_abc"],
      },
    );

    expect(provenance.revisions.map((revision) => revision.at)).toEqual(["t1", "t2", "t3"]);
    expect(provenance.source).toBe("/Desk.md#item");
    expect(provenance.origin).toBe("manual");
    expect(provenance.actor_ref).toEqual({ type: "user", id: "chris" });
    expect(provenance.source_dispatch_phid).toBe("dispatch_123");
    expect(provenance.derived_from).toEqual(["art_abc"]);
    expect(provenance.contributors).toEqual([
      { type: "user", id: "chris" },
      { type: "user", id: "liz" },
    ]);
  });

  it("uses payload notes when present and falls back to op_type", () => {
    const provenance = buildProvenanceFromOpLog([
      {
        op_id: 1,
        ts: "t1",
        actor: "agent:qa",
        op_type: "DESK_ADD",
        payload_json: JSON.stringify({ note: "looks good" }),
      },
      {
        op_id: 2,
        ts: "t2",
        actor: "agent:qa",
        op_type: "DESK_UPDATE",
        payload_json: "{",
      },
    ]);

    expect(provenance.revisions.map((revision) => revision.note)).toEqual(["looks good", "DESK_UPDATE"]);
  });
});

describe("finalizeEntryProvenance", () => {
  it("fills actor_ref from contributors when missing", () => {
    const base = buildProvenanceFromOpLog([
      { op_id: 1, ts: "t1", actor: "agent:roger", op_type: "DESK_ADD" },
    ]);

    expect(finalizeEntryProvenance({ ...base, actor_ref: null }).actor_ref).toEqual({
      type: "agent",
      id: "roger",
    });
  });

  it("prefers an explicit actor_ref override", () => {
    const base = buildProvenanceFromOpLog([
      { op_id: 1, ts: "t1", actor: "agent:roger", op_type: "DESK_ADD" },
    ]);

    expect(finalizeEntryProvenance(base, { type: "user", id: "operator" }).actor_ref).toEqual({
      type: "user",
      id: "operator",
    });
  });
});

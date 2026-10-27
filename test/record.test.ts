import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Record, RecordError, type PatternHit } from "../src/Record.ts";
import { Fixtures } from "./helpers.ts";

describe("Record.parse / merge", () => {
  const codebook = Fixtures.codebook();
  const firstId = codebook.entries[0]!.id;

  it("accepts a merged record with exactly 119 hits", () => {
    const status = Fixtures.allAbsent(codebook);
    const record = Record.merge(
      {
        capture: Fixtures.capture(),
        status,
        dims: { hits: [] },
        model: { name: "test", version: "0" },
      },
      codebook,
    );
    assert.equal(record.patterns.length, 119);
    assert.equal(record.model.atlasGeneratedAt, codebook.generatedAt);
  });

  it("rejects a record that is not exactly 119 hits", () => {
    const patterns = Fixtures.allAbsent(codebook).patterns.slice(0, 118) as PatternHit[];
    assert.throws(
      () => Record.parse(Fixtures.record(codebook, patterns), codebook),
      (error: unknown) =>
        error instanceof RecordError && /exactly 119/.test(error.message),
    );
  });

  it("rejects an invented id", () => {
    const patterns = Fixtures.allAbsent(codebook).patterns as PatternHit[];
    patterns[0] = { ...patterns[0]!, id: "not-a-real-atlas-id" };
    assert.throws(
      () => Record.parse(Fixtures.record(codebook, patterns), codebook),
      (error: unknown) =>
        error instanceof RecordError && /Invented id/.test(error.message),
    );
  });

  it("rejects an illegal variant name", () => {
    const status = Fixtures.allAbsent(codebook);
    status.patterns = status.patterns.map((hit) =>
      hit.id === firstId
        ? {
            id: firstId,
            status: "present" as const,
            confidence: 0.8,
            evidence: [{ kind: "text" as const, quote: "visible heading" }],
          }
        : hit,
    );
    const dims = Fixtures.presentDims(codebook, firstId);
    dims.dims[0] = { key: dims.dims[0]!.key, values: ["not-a-real-variant"] };
    assert.throws(
      () =>
        Record.merge(
          {
            capture: Fixtures.capture(),
            status,
            dims: { hits: [dims] },
            model: { name: "test", version: "0" },
          },
          codebook,
        ),
      (error: unknown) =>
        error instanceof RecordError && /Illegal variant/.test(error.message),
    );
  });

  it("rejects present without evidence", () => {
    const patterns = Fixtures.allAbsent(codebook).patterns as PatternHit[];
    const dims = Fixtures.presentDims(codebook, firstId);
    patterns[0] = {
      id: firstId,
      status: "present",
      confidence: 0.7,
      evidence: [],
      dims: dims.dims,
    };
    assert.throws(
      () => Record.parse(Fixtures.record(codebook, patterns), codebook),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return /evidence|Present without evidence/i.test(message);
      },
    );
  });

  it("rejects uncertain without rationale", () => {
    const patterns = Fixtures.allAbsent(codebook).patterns as PatternHit[];
    patterns[0] = {
      id: firstId,
      status: "uncertain",
      confidence: 0.4,
      rationale: "",
    };
    assert.throws(
      () => Record.parse(Fixtures.record(codebook, patterns), codebook),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return /Uncertain without rationale|rationale/i.test(message);
      },
    );
  });

  it("merges dims onto a present hit", () => {
    const status = Fixtures.allAbsent(codebook);
    status.patterns = status.patterns.map((hit) =>
      hit.id === firstId
        ? {
            id: firstId,
            status: "present" as const,
            confidence: 0.8,
            evidence: [{ kind: "text" as const, quote: "chart" }],
          }
        : hit,
    );
    const dims = Fixtures.presentDims(codebook, firstId);
    const record = Record.merge(
      {
        capture: Fixtures.capture(),
        status,
        dims: { hits: [dims] },
        model: { name: "test", version: "0" },
      },
      codebook,
    );
    const hit = record.patterns.find((pattern) => pattern.id === firstId);
    assert.equal(hit?.status, "present");
    if (hit?.status === "present") {
      assert.equal(hit.dims.length, dims.dims.length);
    }
  });
});

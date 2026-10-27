import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("rejects an invented component atlas id on parse and on merge", () => {
    const patterns = Fixtures.allAbsent(codebook).patterns as PatternHit[];
    const saved = Fixtures.record(codebook, patterns);
    saved.components = [{ role: "header", atlasIds: ["not-a-real-atlas-id"] }];
    assert.throws(
      () => Record.parse(saved, codebook),
      (error: unknown) => error instanceof RecordError && /Invented id: not-a-real-atlas-id/.test(error.message),
    );

    const status = Fixtures.allAbsent(codebook);
    status.components = [{ role: "header", atlasIds: ["not-a-real-atlas-id"] }];
    assert.throws(
      () =>
        Record.merge(
          {
            capture: Fixtures.capture(),
            status,
            dims: { hits: [] },
            model: { name: "test", version: "0" },
          },
          codebook,
        ),
      (error: unknown) => error instanceof RecordError && /Invented id: not-a-real-atlas-id/.test(error.message),
    );
  });

  it("restores omitted absents and still rejects an invented id", () => {
    const record = Record.merge(
      {
        capture: Fixtures.capture(),
        status: Fixtures.allAbsent(codebook),
        dims: { hits: [] },
        model: { name: "test", version: "0" },
      },
      codebook,
    );
    const dir = mkdtempSync(join(tmpdir(), "atlas-read-"));
    const path = join(dir, "page.json");
    try {
      Record.write(record, path, { omitAbsent: true });
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        patterns: unknown[];
        components: { role: string; atlasIds: string[] }[];
      };
      assert.equal(stored.patterns.length, 0);
      assert.throws(
        () => Record.readSaved(path, codebook),
        (error: unknown) => error instanceof RecordError && /exactly 119/.test(error.message),
      );
      const loaded = Record.readSaved(path, codebook, { fillAbsent: true });
      assert.equal(loaded.patterns.length, 119);
      assert.ok(
        loaded.patterns.every((hit) => hit.status === "absent" && hit.confidence === 0),
      );

      stored.components = [{ role: "widget", atlasIds: ["not-a-real-atlas-id"] }];
      writeFileSync(path, JSON.stringify(stored));
      assert.throws(
        () => Record.readSaved(path, codebook, { fillAbsent: true }),
        (error: unknown) =>
          error instanceof RecordError && /Invented id: not-a-real-atlas-id/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Pipeline } from "../src/Pipeline.ts";
import { Record } from "../src/Record.ts";
import { Fixtures } from "./helpers.ts";

describe("Pipeline.agreement", () => {
  it("scores status and dim-value agreement", () => {
    const codebook = Fixtures.codebook();
    const id = codebook.entries[0]!.id;
    const status = Fixtures.allAbsent(codebook);
    status.patterns = status.patterns.map((hit) =>
      hit.id === id
        ? {
            id,
            status: "present" as const,
            confidence: 1,
            evidence: [{ kind: "text" as const, quote: "x" }],
          }
        : hit,
    );
    const dims = Fixtures.presentDims(codebook, id);
    const a = Record.merge(
      {
        capture: Fixtures.capture(),
        status,
        dims: { hits: [dims] },
        model: { name: "a", version: "0" },
      },
      codebook,
    );
    const b = Record.merge(
      {
        capture: Fixtures.capture(),
        status,
        dims: { hits: [dims] },
        model: { name: "b", version: "0" },
      },
      codebook,
    );
    const agreement = Pipeline.agreement(a, b);
    assert.equal(agreement.statusN, 119);
    assert.equal(agreement.statusAgree, 119);
    assert.equal(agreement.statusRate, 1);
    assert.equal(agreement.bothPresent, 1);
    assert.equal(agreement.dimRate, 1);

    const summary = Pipeline.summarize({
      captures: [],
      records: [
        { seed: { url: a.url, domain: "docs-education", stratum: "docs" }, slug: "a", record: a, path: "a.json" },
        { seed: { url: b.url, domain: "docs-education", stratum: "docs" }, slug: "b", record: b, path: "b.json" },
      ],
      doubles: [{ slug: "a", a, b, path: "a.b.json", agreement }],
      failures: [{ url: "https://example.com/fail", stage: "label", error: "boom" }],
    });
    assert.equal(summary.records, 2);
    assert.equal(summary.model, "grok-4.7");
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.agreement.statusRate, 1);
    assert.equal(summary.agreement.dimRate, 1);
    assert.match(
      Pipeline.formatSummary(summary),
      /2 records, 1 failures, double 1, status agreement 1.000, dim agreement 1.000, model grok-4.7/,
    );

    const dir = mkdtempSync(join(tmpdir(), "atlas-summary-"));
    const written = JSON.parse(readFileSync(Pipeline.writeSummary(summary, dir), "utf8")) as {
      failures: { error: string }[];
    };
    assert.equal(written.failures[0]?.error, "boom");
  });

  it("primary json omits absent; .b.json and the in-memory record keep all 119", () => {
    const codebook = Fixtures.codebook();
    const presentId = codebook.entries[0]!.id;
    const uncertainId = codebook.entries[1]!.id;
    const status = Fixtures.allAbsent(codebook);
    status.patterns = status.patterns.map((hit) => {
      if (hit.id === presentId) {
        return {
          id: presentId,
          status: "present" as const,
          confidence: 1,
          evidence: [{ kind: "text" as const, quote: "visible" }],
        };
      }
      if (hit.id === uncertainId) {
        return {
          id: uncertainId,
          status: "uncertain" as const,
          confidence: 0.4,
          rationale: "clipped",
        };
      }
      return hit;
    });
    const record = Record.merge(
      {
        capture: Fixtures.capture(),
        status,
        dims: { hits: [Fixtures.presentDims(codebook, presentId)] },
        model: { name: "a", version: "0" },
      },
      codebook,
    );
    assert.equal(record.patterns.length, 119);

    const dir = mkdtempSync(join(tmpdir(), "atlas-write-"));
    try {
      const primaryPath = join(dir, "site.json");
      const doublePath = join(dir, "site.b.json");
      Pipeline.writeRecord(record, primaryPath, "");
      Pipeline.writeRecord(record, doublePath, ".b");

      assert.equal(record.patterns.length, 119);

      const primary = JSON.parse(readFileSync(primaryPath, "utf8")) as {
        patterns: { id: string; status: string }[];
      };
      const second = JSON.parse(readFileSync(doublePath, "utf8")) as {
        patterns: { id: string; status: string }[];
      };
      assert.deepEqual(
        primary.patterns.map((hit) => hit.status).sort(),
        ["present", "uncertain"],
      );
      assert.deepEqual(
        primary.patterns.map((hit) => hit.id).sort(),
        [presentId, uncertainId].sort(),
      );
      assert.equal(
        primary.patterns.some((hit) => hit.status === "absent"),
        false,
      );
      assert.equal(second.patterns.length, 119);
      assert.equal(second.patterns.filter((hit) => hit.status === "absent").length, 117);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

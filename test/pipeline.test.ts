import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Capture, type CaptureResult } from "../src/Capture.ts";
import { Pipeline } from "../src/Pipeline.ts";
import { Record } from "../src/Record.ts";
import { Fixtures } from "./helpers.ts";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

describe("Pipeline output paths", () => {
  it("gives distinct query URLs distinct slugs and rejects a colliding path", () => {
    const a = Pipeline.slug("https://shop.example/catalog?variant=A");
    const b = Pipeline.slug("https://shop.example/catalog?variant=B");
    assert.notEqual(a, b);
    assert.match(a, /variant-A/);
    assert.match(b, /variant-B/);
    const seen = new Map<string, string>();
    Pipeline.claimSlug(seen, "same", "https://shop.example/a");
    Pipeline.claimSlug(seen, "same", "https://shop.example/a");
    assert.throws(
      () => Pipeline.claimSlug(seen, "same", "https://shop.example/b"),
      /Output path collision: same already used by https:\/\/shop\.example\/a/,
    );
  });

  it("writes both query variants without replacing the first capture", { timeout: 60_000 }, async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/robots.txt")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const variant = new URL(url, "http://127.0.0.1").searchParams.get("variant");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Variant ${variant}</title><p>${variant}</p>`);
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("test server did not bind"));
        else resolve(address.port);
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "atlas-slug-"));
    const urlA = `http://127.0.0.1:${port}/catalog?variant=A`;
    const urlB = `http://127.0.0.1:${port}/catalog?variant=B`;
    try {
      const result = await Pipeline.run({
        seeds: [
          { url: urlA, domain: "e-commerce", stratum: "browse" },
          { url: urlB, domain: "e-commerce", stratum: "browse" },
        ],
        outDir: dir,
        captureOnly: true,
        delayMs: 0,
      });
      assert.equal(result.failures.length, 0);
      assert.equal(result.captures.length, 2);
      assert.notEqual(result.captures[0]!.slug, result.captures[1]!.slug);
      const sideA = JSON.parse(readFileSync(join(dir, `${result.captures[0]!.slug}.capture.json`), "utf8")) as {
        url: string;
        title: string;
      };
      const sideB = JSON.parse(readFileSync(join(dir, `${result.captures[1]!.slug}.capture.json`), "utf8")) as {
        url: string;
        title: string;
      };
      assert.equal(sideA.url, urlA);
      assert.equal(sideA.title, "Variant A");
      assert.equal(sideB.url, urlB);
      assert.equal(sideB.title, "Variant B");
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Pipeline.fromCapture", () => {
  it("labels the saved sidecar and does not fetch the URL again", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(503);
      res.end("unavailable");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("test server did not bind"));
        else resolve(address.port);
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "atlas-reuse-"));
    const url = `http://127.0.0.1:${port}/page-a`;
    const slug = Pipeline.slug(url);
    const screenshotPath = join(dir, `${slug}.png`);
    writeFileSync(screenshotPath, TINY_PNG);
    const saved: CaptureResult = {
      url,
      capturedAt: "2026-10-27T00:00:00.000Z",
      finalUrl: url,
      status: 200,
      title: "Page A",
      viewport: { width: 1440, height: 900 },
      screenshotPx: { width: 1, height: 1 },
      userAgent: "saved-ua",
      screenshotPath,
      screenshotRef: `${slug}.png`,
      ariaSnapshot: "- main: saved page",
      clipCssPx: 100,
    };
    Capture.writeSidecar(saved, join(dir, `${slug}.capture.json`));
    const codebook = Fixtures.codebook();
    const statusPath = join(dir, "status.json");
    writeFileSync(statusPath, JSON.stringify(Fixtures.allAbsent(codebook)));
    const bin = join(dir, "fake-agent.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
process.stdout.write(JSON.stringify({ type: "result", result: readFileSync(${JSON.stringify(statusPath)}, "utf8"), model: "grok-4.7" }));
`,
    );
    chmodSync(bin, 0o755);
    try {
      const result = await Pipeline.run({
        seeds: [{ url, domain: "docs-education", stratum: "docs" }],
        outDir: dir,
        codebook,
        fromCapture: true,
        delayMs: 0,
        labelerBin: bin,
        agentTimeoutMs: 15_000,
        model: "grok-4.7",
      });
      assert.equal(hits, 0);
      assert.equal(result.failures.length, 0);
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0]!.record.url, url);
      assert.equal(result.records[0]!.record.capture.title, "Page A");
      assert.equal(result.records[0]!.record.patterns.length, 119);
      const sidecar = JSON.parse(readFileSync(join(dir, `${slug}.capture.json`), "utf8")) as { title: string };
      assert.equal(sidecar.title, "Page A");
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a screenshot saved beside the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-sidecar-"));
    try {
      const png = join(dir, "shot.png");
      writeFileSync(png, TINY_PNG);
      const sidecar = join(dir, "page.capture.json");
      Capture.writeSidecar(
        {
          url: "https://example.com/saved",
          capturedAt: "2026-10-27T00:00:00.000Z",
          finalUrl: "https://example.com/saved",
          status: 200,
          title: "Saved",
          viewport: { width: 1440, height: 900 },
          screenshotPx: { width: 1, height: 1 },
          userAgent: "saved-ua",
          screenshotPath: "/missing/old.png",
          screenshotRef: "shot.png",
          ariaSnapshot: "- main: saved",
          clipCssPx: 100,
        },
        sidecar,
      );
      const loaded = Capture.readSidecar(sidecar);
      assert.equal(loaded.screenshotPath, png);
      assert.equal(loaded.title, "Saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import { LabelError, Labeler } from "../src/Labeler.ts";
import { Record } from "../src/Record.ts";
import { Fixtures } from "./helpers.ts";

describe("Labeler.exec timeout", () => {
  it("kills a hung child and throws LabelError", async () => {
    const started = Date.now();
    let waits = 0;
    await assert.rejects(
      () =>
        Labeler.exec({
          bin: "sleep",
          args: ["30"],
          timeoutMs: 400,
          waitEveryMs: 100,
          onWait: () => {
            waits += 1;
          },
        }),
      (error: unknown) =>
        error instanceof LabelError && /timed out after 400ms/.test(error.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `timeout took ${elapsed}ms`);
    assert.ok(waits >= 1, "expected a wait pulse before the timeout");
  });

  it("returns stdout when the child exits in time", async () => {
    const out = await Labeler.exec({
      bin: process.execPath,
      args: ["-e", "process.stdout.write('{\"ok\":true}')"],
      timeoutMs: 5000,
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "{\"ok\":true}");
  });
});

describe("Labeler model pin", () => {
  it("puts --model on every spawn, including both passes and a second double-label run", async () => {
    const codebook = Fixtures.codebook();
    const presentId = codebook.entries[0]!.id;
    const status = Fixtures.allAbsent(codebook);
    status.patterns = status.patterns.map((hit) =>
      hit.id === presentId
        ? {
            id: presentId,
            status: "present" as const,
            confidence: 0.9,
            evidence: [{ kind: "text" as const, quote: "chart" }],
          }
        : hit,
    );
    const dir = mkdtempSync(join(tmpdir(), "atlas-model-"));
    const statusPath = join(dir, "status.json");
    const dimsPath = join(dir, "dims.json");
    const argvPath = join(dir, "argv.log");
    const bin = join(dir, "fake-agent.mjs");
    writeFileSync(statusPath, JSON.stringify(status));
    writeFileSync(dimsPath, JSON.stringify({ hits: [Fixtures.presentDims(codebook, presentId)] }));
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
const prompt = args.at(-1) ?? "";
const file = prompt.includes("code every sub-dimension") ? process.env.DIMS_JSON : process.env.STATUS_JSON;
process.stdout.write(JSON.stringify({ type: "result", result: readFileSync(file, "utf8"), model: process.env.REPORT_MODEL }));
`,
    );
    chmodSync(bin, 0o755);
    const previous = {
      ARGV_LOG: process.env.ARGV_LOG,
      STATUS_JSON: process.env.STATUS_JSON,
      DIMS_JSON: process.env.DIMS_JSON,
      REPORT_MODEL: process.env.REPORT_MODEL,
    };
    process.env.ARGV_LOG = argvPath;
    process.env.STATUS_JSON = statusPath;
    process.env.DIMS_JSON = dimsPath;
    process.env.REPORT_MODEL = "Grok 4.7";
    try {
      for (const pass of ["primary", "double"]) {
        const labeled = await Labeler.label({
          codebook,
          screenshotPath: join(dir, "shot.png"),
          ariaSnapshot: "- main: page",
          url: "https://example.com/",
          bin,
          model: "grok-4.7",
          timeoutMs: 15000,
          log: () => {},
        });
        assert.equal(labeled.model.name, "grok-4.7", pass);
        assert.equal(labeled.model.version, "Grok 4.7", pass);
      }
      const lines = readFileSync(argvPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert.equal(lines.length, 4);
      const prompts = lines.map((args) => args.at(-1) ?? "");
      assert.equal(prompts.filter((prompt) => prompt.includes("Emit a status")).length, 2);
      assert.equal(prompts.filter((prompt) => prompt.includes("code every sub-dimension")).length, 2);
      for (const args of lines) {
        const modelFlag = args.indexOf("--model");
        assert.ok(modelFlag >= 0);
        assert.equal(args[modelFlag + 1], "grok-4.7");
        assert.ok(args.includes("-p"));
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns a model mismatch and a CLI rejection into LabelError", async () => {
    assert.throws(
      () => Labeler.resolveModel({ result: "{}", model: "auto" }, "grok-4.7"),
      (error: unknown) =>
        error instanceof LabelError &&
        /model mismatch/.test(error.message) &&
        error.message.includes("auto") &&
        error.message.includes("grok-4.7"),
    );
    assert.deepEqual(Labeler.resolveModel({ result: "{}", model: "Grok 4.7" }, "grok-4.7"), {
      name: "grok-4.7",
      version: "Grok 4.7",
    });

    const dir = mkdtempSync(join(tmpdir(), "atlas-reject-"));
    const bin = join(dir, "reject-agent.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stderr.write("Error: unknown model 'grok-4.7'\\n");
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);
    try {
      await assert.rejects(
        () =>
          Labeler.label({
            codebook: Fixtures.codebook(),
            screenshotPath: join(dir, "shot.png"),
            ariaSnapshot: "- main: page",
            url: "https://example.com/",
            bin,
            model: "grok-4.7",
            timeoutMs: 15000,
            log: () => {},
          }),
        (error: unknown) =>
          error instanceof LabelError && /rejected model grok-4.7/.test(error.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Labeler codebook retry", () => {
  it("retries a short status list and an illegal dimension before merge", async () => {
    const codebook = Fixtures.codebook();
    const presentId = codebook.entries[0]!.id;
    const shortStatus = Fixtures.allAbsent(codebook);
    shortStatus.patterns = shortStatus.patterns.slice(0, 118);
    const goodStatus = Fixtures.allAbsent(codebook);
    goodStatus.patterns = goodStatus.patterns.map((hit) =>
      hit.id === presentId
        ? {
            id: presentId,
            status: "present" as const,
            confidence: 0.9,
            evidence: [{ kind: "text" as const, quote: "chart" }],
          }
        : hit,
    );
    const badDims = {
      hits: [Fixtures.presentDims(codebook, presentId)],
    };
    badDims.hits[0]!.dims[0] = {
      key: badDims.hits[0]!.dims[0]!.key,
      values: ["not-a-real-variant"],
    };
    const goodDims = { hits: [Fixtures.presentDims(codebook, presentId)] };

    const dir = mkdtempSync(join(tmpdir(), "atlas-retry-"));
    const statusCount = join(dir, "status.count");
    const dimsCount = join(dir, "dims.count");
    const statusBad = join(dir, "status-bad.json");
    const statusGood = join(dir, "status-good.json");
    const dimsBad = join(dir, "dims-bad.json");
    const dimsGood = join(dir, "dims-good.json");
    const bin = join(dir, "fake-agent.mjs");
    writeFileSync(statusCount, "0");
    writeFileSync(dimsCount, "0");
    writeFileSync(statusBad, JSON.stringify(shortStatus));
    writeFileSync(statusGood, JSON.stringify(goodStatus));
    writeFileSync(dimsBad, JSON.stringify(badDims));
    writeFileSync(dimsGood, JSON.stringify(goodDims));
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const prompt = process.argv.at(-1) ?? "";
const dims = prompt.includes("code every sub-dimension");
const counter = dims ? ${JSON.stringify(dimsCount)} : ${JSON.stringify(statusCount)};
const n = Number(readFileSync(counter, "utf8") || "0") + 1;
writeFileSync(counter, String(n));
const file = dims
  ? (n === 1 ? ${JSON.stringify(dimsBad)} : ${JSON.stringify(dimsGood)})
  : (n === 1 ? ${JSON.stringify(statusBad)} : ${JSON.stringify(statusGood)});
process.stdout.write(JSON.stringify({ type: "result", result: readFileSync(file, "utf8"), model: "grok-4.7" }));
`,
    );
    chmodSync(bin, 0o755);
    try {
      const labeled = await Labeler.label({
        codebook,
        screenshotPath: join(dir, "shot.png"),
        ariaSnapshot: "- main: page",
        url: "https://example.com/",
        bin,
        model: "grok-4.7",
        timeoutMs: 15000,
        log: () => {},
      });
      assert.equal(readFileSync(statusCount, "utf8"), "2");
      assert.equal(readFileSync(dimsCount, "utf8"), "2");
      assert.equal(labeled.status.patterns.length, 119);
      assert.equal(labeled.dims.hits.length, 1);
      assert.equal(labeled.dims.hits[0]?.dims[0]?.values[0], goodDims.hits[0]?.dims[0]?.values[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a status reply that omits aesthetics.typography and sends the zod paths back", async () => {
    const codebook = Fixtures.codebook();
    const bad = structuredClone(Fixtures.allAbsent(codebook));
    delete (bad.aesthetics as { typography?: string }).typography;
    delete (bad.aesthetics as { palette?: string[] }).palette;
    const good = Fixtures.allAbsent(codebook);
    const dir = mkdtempSync(join(tmpdir(), "atlas-aesthetics-"));
    const badPath = join(dir, "bad.json");
    const goodPath = join(dir, "good.json");
    const countPath = join(dir, "count");
    const promptPath = join(dir, "prompts.log");
    const bin = join(dir, "fake-agent.mjs");
    writeFileSync(badPath, JSON.stringify(bad));
    writeFileSync(goodPath, JSON.stringify(good));
    writeFileSync(countPath, "0");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const prompt = process.argv.at(-1) ?? "";
appendFileSync(${JSON.stringify(promptPath)}, prompt + "\\n---PROMPT---\\n");
const n = Number(readFileSync(${JSON.stringify(countPath)}, "utf8") || "0") + 1;
writeFileSync(${JSON.stringify(countPath)}, String(n));
const file = n === 1 ? ${JSON.stringify(badPath)} : ${JSON.stringify(goodPath)};
process.stdout.write(JSON.stringify({ type: "result", result: readFileSync(file, "utf8"), model: "grok-4.7" }));
`,
    );
    chmodSync(bin, 0o755);
    const logged: string[] = [];
    try {
      const labeled = await Labeler.label({
        codebook,
        screenshotPath: join(dir, "shot.png"),
        ariaSnapshot: "- main: page",
        url: "https://example.com/",
        bin,
        model: "grok-4.7",
        timeoutMs: 15000,
        log: (line) => logged.push(line),
      });
      assert.equal(readFileSync(countPath, "utf8"), "2");
      assert.equal(labeled.status.patterns.length, 119);
      assert.equal(labeled.status.aesthetics.typography, "system");
      const prompts = readFileSync(promptPath, "utf8").split("\n---PROMPT---\n");
      assert.equal(prompts[0]?.includes('"typography":"string"'), false);
      assert.match(prompts[0] ?? "", /serif headlines with sans-serif body text/);
      assert.match(prompts[0] ?? "", /aesthetics\.typography is required/);
      assert.equal(prompts[0]?.includes('"subs"'), false);
      const retry = prompts[1] ?? "";
      assert.match(retry, /aesthetics\.typography: Required \(expected string, received undefined\)/);
      assert.match(retry, /aesthetics\.palette: Required \(expected array, received undefined\)/);
      const retryLog = logged.filter((line) => line.includes("retry")).join("\n");
      assert.match(retryLog, /aesthetics\.typography: Required \(expected string, received undefined\)/);
      assert.match(retryLog, /aesthetics\.palette: Required \(expected array, received undefined\)/);
      assert.equal(retryLog.includes('"code": "invalid_type"'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Labeler status prompt", () => {
  it("caps a large aria snapshot and keeps typography required", () => {
    const codebook = Fixtures.codebook();
    const aria = "y".repeat(20_000);
    const prompt = Labeler.statusPrompt(codebook, "/tmp/shot.png", aria, "https://example.com/page");
    assert.ok(prompt.includes("[aria snapshot truncated from 20000 to 16000 characters]"));
    assert.equal(prompt.includes("y".repeat(16_001)), false);
    assert.match(prompt, /serif headlines with sans-serif body text/);
    assert.equal(prompt.includes('"typography":"string"'), false);
    assert.equal(prompt.includes('"subs"'), false);
    const bad = structuredClone(Fixtures.allAbsent(codebook));
    delete (bad.aesthetics as { typography?: string }).typography;
    let caught: unknown;
    try {
      Record.StatusDraft.parse(bad);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ZodError);
    const lines = Labeler.issueLines(caught);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("aesthetics.typography")),
      ["aesthetics.typography: Required (expected string, received undefined)"],
    );
  });
});

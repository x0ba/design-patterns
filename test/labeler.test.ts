import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LabelError, Labeler } from "../src/Labeler.ts";

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

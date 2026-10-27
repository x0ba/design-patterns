import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Atlas } from "../src/Atlas.ts";

describe("Atlas", () => {
  const codebook = Atlas.load();

  it("loads 119 unique kebab-case ids from the committed codebook", () => {
    assert.equal(codebook.entries.length, 119);
    assert.equal(new Set(Atlas.ids(codebook)).size, 119);
    assert.match(codebook.generatedAt, /2026-09-22T16:21:41\.602Z/);
    assert.equal(codebook.source, "atlas-json");
    for (const id of Atlas.ids(codebook)) {
      assert.match(id, /^[a-z0-9-]+$/);
    }
  });

  it("slim drops dims; dimsFor returns only requested entries", () => {
    const slim = Atlas.slim(codebook);
    assert.equal(slim.length, 119);
    assert.equal("dims" in slim[0]!, false);
    const sample = codebook.entries[0]!.id;
    const subset = Atlas.dimsFor(codebook, [sample]);
    assert.equal(subset.length, 1);
    assert.equal(subset[0]?.id, sample);
    assert.ok(subset[0]!.dims.length >= 0);
  });

  it("extractFromHtml reads #atlas-json and drops unused fields", () => {
    const html = `<html><script type="application/json" id="atlas-json">${JSON.stringify({
      generatedAt: "2026-09-22T16:21:41.602Z",
      entries: [
        {
          id: "analyze",
          name: "Analyze",
          level: "archetype",
          archetype: "analyze",
          aliases: ["viz"],
          def: "Find structure",
          coding: { tier: "drop-me" },
          scores: {},
          dims: [
            {
              name: "Encoding",
              family: "encoding",
              q: "How?",
              subs: [
                {
                  key: "encoding",
                  name: "Mark",
                  sel: "many",
                  vars: [["Position", "xy", "scatter"]],
                },
              ],
            },
          ],
        },
      ],
    })}</script></html>`;
    const extracted = Atlas.extractFromHtml(html);
    assert.equal(extracted.entries[0]?.id, "analyze");
    assert.deepEqual(extracted.entries[0]?.dims[0]?.subs[0]?.vars, [
      { name: "Position", def: "xy" },
    ]);
    assert.equal("coding" in extracted.entries[0]!, false);
    assert.throws(() => Atlas.write(extracted, "/tmp/should-not-write.json"));
  });
});

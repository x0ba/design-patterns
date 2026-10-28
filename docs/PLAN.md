# UI → Design-Pattern Label Pipeline (v1 plan)

**Goal.** Invert the prior workflow: instead of using the Design Pattern Atlas to *generate* UIs, visit real public UIs and *label* them with the Atlas as a thematic-analysis codebook. Each visit writes one JSON record covering **all 119 Atlas ids** (present / absent / uncertain) plus dimension values on present hits. Success = a **diverse, high-quality** seed dataset, not a crawler. Informed by the 26 Oct 2026 Design Patterns meeting, the 12 Oct 2026 Brian/Daniel session, and Daniel’s answers to the open questions.

**Stack.** TypeScript + Node + Playwright. Labeling via **Cursor CLI** (`cursor-agent` / `agent`) on Daniel’s subscription. No Next.js, no Vercel AI SDK, no separately paid API key.

**Decisions (locked).** Closed coding on Atlas ids only. Record present / absent / uncertain for every id. Code dimensions on present hits. All 119 ids in scope (agent-coded included). No scrape/license blockers; robots.txt + rate limits are hygiene. Nov 9 deliverable = pipeline-labeled examples, not a rubric. Labeler = `cursor-agent` + zod.

## 1. Reuse first — do not build

| Piece | Use | Do not build |
|---|---|---|
| Browse + wait + screenshot | Playwright `chromium`, `page.goto`, `page.screenshot({ fullPage: true })` | Headless wrapper, screenshot SaaS |
| Structure for the model | Playwright `locator('body').ariaSnapshot()` on the **same clipped page** + title / final URL | Custom DOM parser |
| Labeling | `cursor-agent -p --output-format json` (Daniel’s Cursor sub). Prompt asks for one JSON object; **zod validates** the `result` text | Vercel AI SDK, provider API keys, constrained-decoding servers |
| Codebook | Slim JSON extracted from `#atlas-json` | Atlas CMS, vector DB, RAG over essays |
| Orchestration | `tsx` CLI, JSON on disk | Queue, worker farm, Next.js reviewer |

**Smallest pipeline.** `seeds.json` → `Capture.fromUrl` → `Labeler.label` (two `cursor-agent` calls) → `Record.parse` / `Record.write`. One shared scope: viewport **width** 1440, full-page screenshot + aria tree clipped together at **8000 CSS px**. No login, no crawl graph, no interaction beyond first paint + network idle. Honor robots.txt and pause between navigations (hygiene, not a research constraint). Fail a URL rather than invent a bypass.

**`cursor-agent` limits (plain).** `--output-format json` is a **CLI envelope** (`{ result: "<assistant text>" }`), not schema-constrained decoding. Images **are** supported: put the PNG path in the prompt; the agent reads it via tools (`--force` / `--trust` in headless). Plan: prompt “return only one JSON object”, parse `result` (strip fences), zod-validate, **retry once** on failure. If a chosen model cannot read images, fail that URL — do not silently drop vision. Closest option that still uses the Cursor sub; do not add an API-key SDK.

## 2. Atlas ingestion

Source is Daniel’s Marble HTML export. The codebook is `#atlas-json` (`generatedAt: 2026-09-22T16:21:41.602Z`). **Do not commit the HTML.** Parse the script tag locally → `atlas/codebook.json`. No card scrape, no image pipeline (plates are SVGs; entries have no rasters).

**Dump.** 119 unique kebab-case `id`s (`[a-z0-9-]+`, used as `data-id` and in `relations.*` — stable **in this snapshot**; version = `generatedAt`). **16 archetypes** (activity / categories), **60 patterns**, **43 components**. The 12 *families* are customization dimensions, not categories. Each entry has a design space: 609 dims → 680 subs (`key`, `sel`: `one` | `many`) → 3166 variants as `[name, def, example]` triples. Only `overview-detail` is human-`coded`; the other 118 are `agent-coded` and **still in scope**. Drop `coding`, `scores`, techniques, relations, wild, usage, platforms, domains from the codebook — they do not help presence or dimension coding.

**v1 extract (smallest that can still code dims).** Keep id / name / level / archetype / aliases / def, plus each dim’s name, family, `q`, and each sub’s `key` / name / `sel` / vars as `{ name, def }` (**drop examples**). Disk size **~308 KB** (was ~32 KB without dims; ~170 KB if vars were names only — defs are needed to pick a variant). The labeler never ships the whole 308 KB in one prompt (see §5).

```ts
const AtlasVar = z.object({ name: z.string(), def: z.string() });
const AtlasSub = z.object({
  key: z.string(),                  // unique per entry, e.g. "attributePlacement"
  name: z.string(),
  sel: z.enum(["one", "many"]),
  vars: z.array(AtlasVar),
});
const AtlasDim = z.object({
  name: z.string(),
  family: z.string(),               // content | composition | layout | …
  q: z.string(),
  subs: z.array(AtlasSub),
});
const AtlasEntry = z.object({
  id: z.string(),
  name: z.string(),
  level: z.enum(["archetype", "pattern", "component"]),
  archetype: z.string(),
  aliases: z.array(z.string()),
  def: z.string(),
  dims: z.array(AtlasDim),
});
const AtlasCodebook = z.object({
  source: z.literal("atlas-json"),
  generatedAt: z.string().datetime(),
  entries: z.array(AtlasEntry),     // 119
});
```

Closed coding: the labeler may only emit those 119 `id`s and each sub’s listed `vars[].name`. Nothing that does not map becomes a new id — **`notes` is free text only**.

## 3. JSON label schema

One object per URL. **Exactly 119** hits, one per Atlas id (zod: id set equals the codebook). **Uncertain is a third status** because v1 does not click/hover (modals, menus, auth chrome unseen), the 8000 px clip can hide below-the-fold UI, and most Atlas defs are agent-coded — forcing binary present/absent would invent certainty and wreck agreement.

- **present** — evidence required (text quote or visual bbox). Dimension values required for **every sub** of that entry. `sel: "one"` → exactly one var name; `sel: "many"` → zero or more from that sub’s list.
- **absent** — no evidence; optional short `rationale`.
- **uncertain** — no evidence; **required** short `rationale`.

`Record.parse` hydrates `name` / `level` / `archetype` from the codebook so the model only emits ids.

```ts
const Box = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
});
const Evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), quote: z.string() }),
  z.object({ kind: z.literal("visual"), description: z.string(), region: Box }),
]);
const DimValue = z.object({
  key: z.string(),                  // Atlas sub key
  values: z.array(z.string()),      // var names from that sub
});
const PatternHit = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    status: z.literal("present"),
    confidence: z.number().min(0).max(1),
    evidence: z.array(Evidence).min(1).max(3),
    dims: z.array(DimValue),
  }),
  z.object({
    id: z.string(),
    status: z.literal("absent"),
    confidence: z.number().min(0).max(1),
    rationale: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    status: z.literal("uncertain"),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
]);
const Component = z.object({
  role: z.string(),
  name: z.string().optional(),
  atlasIds: z.array(z.string()),
});
const UiRecord = z.object({
  url: z.string().url(),
  capturedAt: z.string().datetime(),
  capture: z.object({
    finalUrl: z.string().url(),
    status: z.number(),
    title: z.string(),
    viewport: z.object({ width: z.number(), height: z.number() }),
    screenshotPx: z.object({ width: z.number(), height: z.number() }),
    userAgent: z.string(),
  }),
  screenshotRef: z.string(),
  domain: z.string(),
  components: z.array(Component),
  patterns: z.array(PatternHit),    // length 119, ids = codebook
  structure: z.object({
    layout: z.string(),
    regions: z.array(z.string()),
    density: z.enum(["sparse", "medium", "dense"]),
  }),
  aesthetics: z.object({
    palette: z.array(z.string()).max(8),
    typography: z.string(),
    mood: z.array(z.string()).max(5),
  }),
  model: z.object({ name: z.string(), version: z.string(), atlasGeneratedAt: z.string() }),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),     // unmapped observations; never a new id
});
```

## 4. Site selection (public pages only)

Manually curate a **stratified seed**, not a spider. v1 = pages that render useful UI without auth. Skip paywalls, app-store gates, and credential walls. Check robots.txt and space requests; that is engineering hygiene, not a license gate.

Strata (4 URLs each): data viz, games, productivity, news/media, docs/education, e-commerce browse, maps, social/community, finance (marketing), gov/civic, design portfolios, creative tools, travel/booking, music/audio, developer tools, health, food, museums/culture. Record `domain` on every record.

## 5. Pilot — labeled examples for 9 Nov

Deliver **72 model-labeled `UiRecord`s** (plus PNGs), not a rubric. Labels come from the pipeline. `--limit 20` still runs the original pilot.

**Two `cursor-agent` passes per URL** (keeps prompts small):

1. **Status.** Slim codebook (id / name / level / archetype / aliases / def, ~32 KB) + screenshot path + aria tree → 119 statuses.
2. **Dimensions.** Only present ids, with those entries’ dims (~a few tens of KB) → `DimValue`s.

`Record.parse` merges, hydrates, and rejects invented ids / illegal var names.

**Gold-ish set + consistency.** The 72 records *are* the example set. Independently **double-label 5** URLs (second `cursor-agent` run, same prompt). Report agreement on status (all 119) and, where both say present, on dim `values`. Light human skim of 3–4 records for invented ids or evidence off the PNG. No review app.

**Cost / time (Cursor sub, not API $).** 72 × 2 passes + 5 double-labels ≈ **149 headless runs**. Capture is seconds per URL; each agent pass is the long pole (vision + long JSON). Wall-clock for an unattended batch: on the order of **one long session**, not a research week. Human skim: **under an hour**.

## 6. Module structure (small diff)

Classes with static methods. Compile `atlas/codebook.json` from `#atlas-json` (HTML local, untracked).

```
src/Atlas.ts      Atlas.load / Atlas.ids / Atlas.slim / Atlas.dimsFor
src/Capture.ts    Capture.fromUrl
src/Labeler.ts    Labeler.label          // shells cursor-agent twice
src/Record.ts     Record.parse / Record.write
src/Pipeline.ts   Pipeline.run
src/cli.ts
```

`Pipeline.run` is the only composition root. Packages: `playwright`, `zod`, `tsx`. No `ai` SDK, no Next.js.

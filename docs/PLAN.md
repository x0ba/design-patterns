# UI → Design-Pattern Label Pipeline (v1 plan)

**Goal.** Invert the prior workflow: instead of using the Design Pattern Atlas to *generate* UIs, visit real public UIs and *label* them with the Atlas as a thematic-analysis codebook. Each visit writes one JSON record (components, patterns, structure, aesthetics). Success = a **diverse, high-quality** seed dataset, not a crawler. Informed by the 26 Oct 2026 Design Patterns meeting and the 12 Oct 2026 Brian/Daniel working session.

**Stack.** TypeScript + Node + Playwright. No Next.js/React review UI in v1.

## 1. Reuse first — do not build

| Piece | Use | Do not build |
|---|---|---|
| Browse + wait + screenshot | Playwright `chromium`, `page.goto`, `page.screenshot({ fullPage: true })` | Headless wrapper, screenshot SaaS |
| Structure for the model | Playwright `locator('body').ariaSnapshot()` on the **same clipped page** + `page.title()` / final URL | Custom DOM parser, vision-only labeling |
| Structured LLM output | Vercel AI SDK `generateObject` **or** the provider JSON-schema API, validated with **zod** | Hand-rolled prompt parsers |
| Codebook | One typed JSON/TS file loaded at start | Atlas CMS, vector DB, RAG over pattern essays |
| Orchestration | `tsx` CLI, JSONL/JSON on disk | Queue, worker farm, Next.js reviewer |

**Smallest pipeline.** `seeds.json` → `Capture.fromUrl` → `Labeler.label(capture, atlas)` → `Record.write`. One shared scope: viewport **width** 1440, full-page screenshot + aria tree clipped together at **8000 CSS px** (taller pages truncate). No login, no crawl graph, no interaction beyond first paint + network idle. Fail a URL rather than invent a bypass.

## 2. Atlas ingestion

Daniel’s export is a Marble HTML inspector (`Pattern Atlas.mrbl` is the live file). The codebook is **not** the cards: it is `#atlas-json` (`generatedAt: 2026-09-22T16:21:41.602Z`). **Do not commit the HTML** (~4.5 MB). One local extract: parse that script tag and write `atlas/codebook.json`. No DOM scrape, no image pipeline (plates are inline SVGs; entries have no rasters).

**What is in the dump.** 119 unique kebab-case `id`s (no collisions; `[a-z0-9-]+`; used as `data-id` and in `relations.*` — treat as stable **in this snapshot**, version = `generatedAt`). Three levels: **16 archetypes** (activity), **60 patterns** (screen/flow), **43 components** (widget). Categories **are the archetypes**, not the 12 *families* (those are customization dimensions: content, composition, layout, …). Each entry has `id`, `name`, `level`, `archetype`, `aliases`, `def`, plus a large design space (`dims` / 609 dimensions, 3166 vars), `relations`, scores, and evidence. Only `overview-detail` is human-`coded` (CHI/UIST ’25); the other 118 are `agent-coded`.

**v1 set = all 119, presence only.** The meeting asked to label components *and* patterns. A slim list (id / name / level / archetype / aliases / def) is ~32 KB and fits one prompt. Dropping components would force free-form widget names; dropping archetypes loses the Atlas’s own categories. Do **not** send dims/vars/techniques/coding — that is a later design-space study, not page labeling. Prompt: emit only **present** hits (a page should have a handful, not 119). Closed coding; unknowns go in `unmappedNotes`.

```ts
const AtlasEntry = z.object({
  id: z.string(),                 // e.g. "overview-detail"
  name: z.string(),
  level: z.enum(["archetype", "pattern", "component"]),
  archetype: z.string(),          // one of 16
  aliases: z.array(z.string()),
  def: z.string(),
});
const AtlasCodebook = z.object({
  source: z.literal("atlas-json"),
  generatedAt: z.string().datetime(),
  entries: z.array(AtlasEntry),   // 119
});
```

`Atlas.load` reads the slim file. The labeler may only emit `id` values from it (`z.enum` of the 119).

## 3. Draft JSON label schema

One object per URL. Evidence is required for every present pattern. Use a **text** quote when the control has visible text or an accessible name; use **visual** (description + screenshot bbox) for text-free games, maps, and layouts.

```ts
const Box = z.object({                  // screenshot pixels
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
});

const Evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), quote: z.string() }),
  z.object({ kind: z.literal("visual"), description: z.string(), region: Box }),
]);

const PatternHit = z.object({
  id: z.string(),                       // Atlas entry id
  name: z.string(),
  level: z.enum(["archetype", "pattern", "component"]),
  archetype: z.string(),
  present: z.literal(true),
  confidence: z.number().min(0).max(1),
  evidence: z.array(Evidence).min(1).max(3),
});

const Component = z.object({
  role: z.string(),                     // a11y role from the capture
  name: z.string().optional(),
  atlasIds: z.array(z.string()),        // Atlas ids this node realizes
});

const UiRecord = z.object({
  url: z.string().url(),
  capturedAt: z.string().datetime(),
  capture: z.object({
    finalUrl: z.string().url(),
    status: z.number(),
    title: z.string(),
    viewport: z.object({ width: z.number(), height: z.number() }),
    screenshotPx: z.object({ width: z.number(), height: z.number() }), // full-page PNG; visual region coords
    userAgent: z.string(),
  }),
  screenshotRef: z.string(),            // data/captures/<id>.png
  domain: z.string(),                   // seed stratum
  components: z.array(Component),
  patterns: z.array(PatternHit),
  structure: z.object({
    layout: z.string(),                 // e.g. app-shell-sidebar
    regions: z.array(z.string()),
    density: z.enum(["sparse","medium","dense"]),
  }),
  aesthetics: z.object({
    palette: z.array(z.string()).max(8),
    typography: z.string(),
    mood: z.array(z.string()).max(5),
  }),
  model: z.object({ name: z.string(), version: z.string(), atlasGeneratedAt: z.string() }),
  confidence: z.number().min(0).max(1), // record-level
  unmappedNotes: z.string().optional(),
});
```

## 4. Site selection (public pages only)

Manually curate a **stratified seed**, not a spider. v1 = pages that render useful UI **without auth**, bots, or ToS-hostile scraping. Skip paywalls, app-store gates, and anything that needs credentials.

Strata (1–2 URLs each for the pilot; meeting examples in italics): *data viz*, *games*, *productivity*, plus news/media, docs/education, e-commerce browse, maps, social/community, finance (marketing), gov/civic, design portfolios. Prefer distinct products and layouts over “another SaaS landing page.” Record `domain` on every record so we can measure coverage.

## 5. Pilot (~20 sites)

Run the pipeline once over ~20 seed URLs. One shared scope each: `page.screenshot({ fullPage: true })` plus `locator('body').ariaSnapshot()`, both clipped at **8000 CSS px** so labels cannot outrun the PNG. Viewport window is 1440×900; the screenshot may be taller. **Quality > count** before the 9 Nov meeting.

**Spot-check rubric** (human, full-page screenshot + JSON, 5–8 records):

1. Every `id` exists in the codebook (`atlasGeneratedAt` on the record).
2. Evidence is on that screenshot: a text `quote` is readable there, or a visual `region` lies inside the PNG (nothing from below the height cap).
3. Structure/layout matches what a person would name.
4. Aesthetics are specific, not generic (“blue SaaS”).
5. Page was public; `finalUrl` is still the intended UI.
6. Seed `domain` is correct; the 20 are not one stratum.

**Pass bar.** ≥4/6 on each checked record; no invented ids. If the model invents ids or misses obvious chrome (nav, app shell), tighten the codebook prompt before scaling.

**Cost / time (compute, not calendar).** Capture is seconds per URL. One vision call per full-page PNG: roughly \$0.05–\$0.40 depending on model/image size → **about \$1–\$8** for 20. Wall-clock for an unattended run: **~10–20 minutes**. Human spot-check: **~1–2 hours**. No review app: open PNG + JSON in the editor.

## 6. Module structure (small diff)

Prefer **classes with static methods**; no pile of `utils.ts` helpers. Compile `atlas/codebook.json` from `#atlas-json` (HTML stays local, untracked). Defer `seeds/pilot.json` until the extract exists.

```
src/Atlas.ts      Atlas.load / Atlas.ids
src/Capture.ts    Capture.fromUrl
src/Labeler.ts    Labeler.label
src/Record.ts     Record.parse / Record.write
src/Pipeline.ts   Pipeline.run
src/cli.ts
```

`Pipeline.run` is the only composition root. Keep Playwright and the LLM client inside `Capture` and `Labeler`. Do not add Next.js, tests-as-product, or extra packages beyond `playwright`, `zod`, `ai` (or the provider SDK), and `tsx`.

## 7. Open questions for Brian

1. Closed coding only, or may the model propose candidates for Jeremy’s atlas work?
2. Label **present** hits only (this plan) or also explicit absences?
3. Confirm v1 is presence-only on all 119 ids, and we ignore per-entry dims/vars.
4. Are the 118 `agent-coded` entries in-scope, given only `overview-detail` is human-coded?
5. Any sites we must include / must not scrape? License posture for stored screenshots (and for redistributing the codebook)?
6. Gold-label a handful with you for inter-rater check, or rubric-only for the 9 Nov checkpoint?
7. Preferred model (and who pays the API key)?

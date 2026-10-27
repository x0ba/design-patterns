# Design Pattern Atlas labeling pipeline

Visit real public UIs and label them with the Design Pattern Atlas as a closed codebook. Each visit writes one JSON record covering all **119 Atlas ids** (`present` / `absent` / `uncertain`) plus dimension values on present hits.

Informed by the [26 Oct 2026 Design Patterns meeting](https://notes.granola.ai/d/68c17485-29be-4d31-9eac-d96912efc4cb) (invert generate→label; Nov 9 = labeled examples) and the [12 Oct 2026 Brian/Daniel session](https://notes.granola.ai/d/ffd7abea-b48c-456e-a85f-70ec5cba6c0a). Schema and Atlas-dump decisions are in the approved plan on `cursor/ui-label-pipeline-plan-fda8`.

## Stack

TypeScript + Node + Playwright. Labeling is two `cursor-agent -p --output-format json` passes (status, then dims). Packages: `playwright`, `zod`, `tsx`. No Next.js, no Vercel AI SDK, no provider API keys.

## Setup

```bash
npm install
npx playwright install chromium
```

The committed codebook is `atlas/codebook.json` (extracted from Daniel’s Marble HTML `#atlas-json`, `generatedAt: 2026-09-22T16:21:41.602Z`). To regenerate from a local HTML export (HTML is gitignored):

```bash
tsx src/cli.ts extract /path/to/design-pattern-atlas.html
```

## Commands

```bash
# Capture only (screenshot + aria sidecar). Hygiene: robots.txt + delay between URLs.
tsx src/cli.ts capture --out output --limit 3

# Full pipeline: capture → two cursor-agent passes → UiRecord JSON.
tsx src/cli.ts run --out output --double 5
```

Daniel’s local command for the 20-record pilot plus 5 double-labels:

```bash
tsx src/cli.ts run --out output --double 5
```

`cursor-agent` must be installed and authenticated as Daniel (`cursor-agent login`) **or** `CURSOR_API_KEY` must be set. This environment does not substitute another model if that CLI is missing.

## Output

One PNG + one JSON `UiRecord` per seed URL under `--out` (default `output/`). Capture sidecars (`*.capture.json`) are written so a later `run` can be retried after a capture-only pass.

**Git policy:** pilot outputs are **not** committed. JSON is small enough to commit later if wanted; PNGs are full-page and stay out of git. `output/` and `*.png` are in `.gitignore`. The Atlas HTML export is also gitignored (`atlas/*.html`); only `atlas/codebook.json` is committed.

## Seeds

`seeds.json` is a stratified set of 20 public pages (1–2 per stratum: data viz, games, productivity, news/media, docs/education, e-commerce browse, maps, social/community, finance marketing, gov/civic, design portfolios). `domain` on each record is the stratum key.

## Layout

```
src/Atlas.ts      Atlas.load / ids / slim / dimsFor / extractFromHtml
src/Capture.ts    Capture.fromUrl
src/Labeler.ts    Labeler.label          // two cursor-agent calls
src/Record.ts     Record.parse / merge / hydrate / write
src/Pipeline.ts   Pipeline.run           // only composition root
src/cli.ts
```

## Plan

The approved plan is [docs/PLAN.md](docs/PLAN.md): visit public UIs with Playwright, label each page against all 119 Design Pattern Atlas ids (present / absent / uncertain, plus dimensions on present hits), and write one JSON record per UI. Labeling runs through Cursor CLI (`cursor-agent`) on a Cursor subscription, then zod-validates the JSON.

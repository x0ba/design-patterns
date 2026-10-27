# Design Pattern Atlas labeling pipeline

Visit real public UIs and label them with the Design Pattern Atlas as a closed codebook. The labeler still scores all **119 Atlas ids** (`present` / `absent` / `uncertain`) plus dimension values on present hits. The primary `<slug>.json` file lists only `present` and `uncertain` hits; any codebook id missing from that file is **absent**.

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
# --model defaults to grok-4.7 and is passed on every cursor-agent spawn,
# including retries and the .b double-label runs.
tsx src/cli.ts run --out output --double 5
tsx src/cli.ts run --out output --double 5 --model grok-4.7
```

Daniel’s local command for the 20-record pilot plus 5 double-labels:

```bash
# once: curl https://cursor.com/install -fsS | bash
# once: agent login          # Daniel's Cursor account
#   or: export CURSOR_API_KEY=...
export PATH="$HOME/.local/bin:$PATH"
npx playwright install chromium
# confirm the Grok 4.7 id this account can use:
agent models
tsx src/cli.ts run --out output --double 5
```

Every spawn is `cursor-agent -p --output-format json --force --trust --model <id>`. The default id is `grok-4.7`. It was **not** verified against an authenticated `agent models` list: CLI `2026.10.22-27dcf5f` returns `Authentication required` for both `agent models` and `cursor-agent --list-models`, and that build does not embed a model catalog. `grok-4.7` is the cloud-agent id. After `agent login`, Daniel can confirm with `agent models` (or `cursor-agent --list-models`) and override with `--model` if the CLI id differs.

If the CLI rejects the id, or its JSON envelope reports a different model, that URL is a label failure (`LabelError`). It does not fall back to Auto. `model.name` on each record is the requested id. When the envelope reports an equivalent spelling (for example `Grok 4.7`), that string is kept in `model.version`. `summary.json` and the final stderr summary line include the model id.

This cloud environment installed `cursor-agent` but is **not logged in** and has no `CURSOR_API_KEY`. Labels are not faked with another provider.

## Output

One PNG + one JSON record per seed URL under `--out` (default `output/`). The primary `<slug>.json` is the in-memory `UiRecord` with `absent` patterns omitted at write time (`Record.serializable` / `Record.write(..., { omitAbsent: true })`). Validation still requires all 119 ids before that filter. A codebook id that is not in `patterns` is absent. Double-label files (`<slug>.b.json`) keep the full 119, including absents. Capture sidecars (`*.capture.json`) are unchanged. `summary.json` records failures, double-label agreement, and the model id. Agreement compares the full in-memory records, not the filtered files.

Progress goes to stderr (`[3/20] capture … ok`, `label status…`, `label dims…`, `FAIL …`, a final summary line) so a long batch is not silent. Each `cursor-agent` call has a timeout (default 10 minutes, `--timeout` in ms). On timeout the child is killed and that URL is a label failure.

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

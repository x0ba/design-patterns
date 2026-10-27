# design-patterns

Pipeline (planned): visit public UIs with Playwright, label each page against all 119 Design Pattern Atlas ids (present / absent / uncertain, plus dimensions on present hits), write one JSON record per UI.

Labeling runs through Cursor CLI (`cursor-agent`) on a Cursor subscription, then zod-validates the JSON. See [docs/PLAN.md](docs/PLAN.md). No implementation yet.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { Atlas, type AtlasCodebook, type AtlasEntry, type AtlasSub } from "./Atlas.ts";

const Box = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const Evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), quote: z.string() }),
  z.object({ kind: z.literal("visual"), description: z.string(), region: Box }),
]);
const DimValue = z.object({
  key: z.string(),
  values: z.array(z.string()),
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
  patterns: z.array(PatternHit),
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
  model: z.object({
    name: z.string(),
    version: z.string(),
    atlasGeneratedAt: z.string(),
  }),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

const StatusHit = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    status: z.literal("present"),
    confidence: z.number().min(0).max(1),
    evidence: z.array(Evidence).min(1).max(3),
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

const StatusDraft = z.object({
  patterns: z.array(StatusHit),
  components: z.array(Component),
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
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});

const DimsDraft = z.object({
  hits: z.array(
    z.object({
      id: z.string(),
      dims: z.array(DimValue),
    }),
  ),
});

const CaptureMeta = z.object({
  url: z.string().url(),
  capturedAt: z.string().datetime(),
  finalUrl: z.string().url(),
  status: z.number(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  screenshotPx: z.object({ width: z.number(), height: z.number() }),
  userAgent: z.string(),
  screenshotRef: z.string(),
  domain: z.string(),
});

export type Box = z.infer<typeof Box>;
export type Evidence = z.infer<typeof Evidence>;
export type DimValue = z.infer<typeof DimValue>;
export type PatternHit = z.infer<typeof PatternHit>;
export type Component = z.infer<typeof Component>;
export type UiRecord = z.infer<typeof UiRecord>;
export type StatusDraft = z.infer<typeof StatusDraft>;
export type DimsDraft = z.infer<typeof DimsDraft>;
export type CaptureMeta = z.infer<typeof CaptureMeta>;

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

export class Record {
  static readonly Box = Box;
  static readonly Evidence = Evidence;
  static readonly DimValue = DimValue;
  static readonly PatternHit = PatternHit;
  static readonly Component = Component;
  static readonly UiRecord = UiRecord;
  static readonly StatusDraft = StatusDraft;
  static readonly DimsDraft = DimsDraft;
  static readonly CaptureMeta = CaptureMeta;

  static parse(input: unknown, codebook: AtlasCodebook): UiRecord {
    const parsed = UiRecord.parse(input);
    Record.assertClosed(parsed, codebook);
    return parsed;
  }

  static hydrate(id: string, codebook: AtlasCodebook): AtlasEntry {
    const entry = Atlas.byId(codebook).get(id);
    if (!entry) {
      throw new RecordError(`Invented id: ${id}`);
    }
    return entry;
  }

  static assertStatus(draft: StatusDraft, codebook: AtlasCodebook): void {
    const expected = Atlas.ids(codebook);
    if (draft.patterns.length !== expected.length) {
      throw new RecordError(
        `Expected exactly ${expected.length} hits, got ${draft.patterns.length}`,
      );
    }
    const seen = new Set<string>();
    const allowed = new Set(expected);
    for (const hit of draft.patterns) {
      if (!allowed.has(hit.id)) {
        throw new RecordError(`Invented id: ${hit.id}`);
      }
      if (seen.has(hit.id)) {
        throw new RecordError(`Duplicate id: ${hit.id}`);
      }
      seen.add(hit.id);
      if (hit.status === "present" && !hit.evidence.length) {
        throw new RecordError(`Present without evidence: ${hit.id}`);
      }
      if (hit.status === "uncertain" && !hit.rationale.trim()) {
        throw new RecordError(`Uncertain without rationale: ${hit.id}`);
      }
    }
    if (seen.size !== expected.length) {
      const missing = expected.filter((id) => !seen.has(id));
      throw new RecordError(`Missing ids: ${missing.join(", ")}`);
    }
    Record.assertComponentIds(draft.components, allowed);
  }

  static assertDimsDraft(draft: DimsDraft, codebook: AtlasCodebook, presentIds: string[]): void {
    const expected = new Set(presentIds);
    const seen = new Set<string>();
    for (const hit of draft.hits) {
      if (!expected.has(hit.id)) {
        throw new RecordError(`Dimension values for non-present id: ${hit.id}`);
      }
      if (seen.has(hit.id)) {
        throw new RecordError(`Duplicate dim hit: ${hit.id}`);
      }
      seen.add(hit.id);
      Record.assertDims(Record.hydrate(hit.id, codebook), hit.dims);
    }
    for (const id of presentIds) {
      if (!seen.has(id)) {
        throw new RecordError(`Present id missing dimension values: ${id}`);
      }
    }
  }

  static merge(
    args: {
      capture: CaptureMeta;
      status: StatusDraft;
      dims: DimsDraft;
      model: { name: string; version: string };
    },
    codebook: AtlasCodebook,
  ): UiRecord {
    const dimsById = new Map(args.dims.hits.map((hit) => [hit.id, hit.dims]));
    const patterns: PatternHit[] = args.status.patterns.map((hit) => {
      if (hit.status !== "present") return hit;
      const entry = Record.hydrate(hit.id, codebook);
      const dims = dimsById.get(hit.id);
      if (!dims) {
        throw new RecordError(`Present id missing dimension values: ${hit.id}`);
      }
      Record.assertDims(entry, dims);
      return { ...hit, dims };
    });

    for (const id of dimsById.keys()) {
      const hit = args.status.patterns.find((pattern) => pattern.id === id);
      if (!hit) {
        throw new RecordError(`Dimension values for unknown status id: ${id}`);
      }
      if (hit.status !== "present") {
        throw new RecordError(`Dimension values for non-present id: ${id}`);
      }
    }

    const record: UiRecord = {
      url: args.capture.url,
      capturedAt: args.capture.capturedAt,
      capture: {
        finalUrl: args.capture.finalUrl,
        status: args.capture.status,
        title: args.capture.title,
        viewport: args.capture.viewport,
        screenshotPx: args.capture.screenshotPx,
        userAgent: args.capture.userAgent,
      },
      screenshotRef: args.capture.screenshotRef,
      domain: args.capture.domain,
      components: args.status.components,
      patterns,
      structure: args.status.structure,
      aesthetics: args.status.aesthetics,
      model: {
        name: args.model.name,
        version: args.model.version,
        atlasGeneratedAt: codebook.generatedAt,
      },
      confidence: args.status.confidence,
      notes: args.status.notes,
    };

    return Record.parse(record, codebook);
  }

  static serializable(record: UiRecord, opts?: { omitAbsent?: boolean }): UiRecord {
    if (!opts?.omitAbsent) return record;
    return {
      ...record,
      patterns: record.patterns.filter(
        (hit) => hit.status === "present" || hit.status === "uncertain",
      ),
    };
  }

  static write(record: UiRecord, path: string, opts?: { omitAbsent?: boolean }): void {
    const body = Record.serializable(record, opts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  }

  private static assertClosed(record: UiRecord, codebook: AtlasCodebook): void {
    const expected = Atlas.ids(codebook);
    if (record.patterns.length !== expected.length) {
      throw new RecordError(
        `Expected exactly ${expected.length} hits, got ${record.patterns.length}`,
      );
    }
    const seen = new Set<string>();
    const allowed = new Set(expected);
    for (const hit of record.patterns) {
      if (!allowed.has(hit.id)) {
        throw new RecordError(`Invented id: ${hit.id}`);
      }
      if (seen.has(hit.id)) {
        throw new RecordError(`Duplicate id: ${hit.id}`);
      }
      seen.add(hit.id);
      if (hit.status === "present") {
        if (!hit.evidence.length) {
          throw new RecordError(`Present without evidence: ${hit.id}`);
        }
        Record.assertDims(Record.hydrate(hit.id, codebook), hit.dims);
      }
      if (hit.status === "uncertain" && !hit.rationale.trim()) {
        throw new RecordError(`Uncertain without rationale: ${hit.id}`);
      }
    }
    if (seen.size !== expected.length) {
      const missing = expected.filter((id) => !seen.has(id));
      throw new RecordError(`Missing ids: ${missing.join(", ")}`);
    }
    Record.assertComponentIds(record.components, allowed);
  }

  private static assertComponentIds(
    components: { atlasIds: string[] }[],
    allowed: Set<string>,
  ): void {
    for (const component of components) {
      for (const id of component.atlasIds) {
        if (!allowed.has(id)) {
          throw new RecordError(`Invented id: ${id}`);
        }
      }
    }
  }

  private static assertDims(entry: AtlasEntry, dims: DimValue[]): void {
    const byKey = new Map(dims.map((dim) => [dim.key, dim]));
    if (byKey.size !== dims.length) {
      throw new RecordError(`Duplicate dim key on ${entry.id}`);
    }
    const expectedKeys = entry.dims.flatMap((dim) => dim.subs.map((sub) => sub.key));
    for (const key of expectedKeys) {
      if (!byKey.has(key)) {
        throw new RecordError(`Missing dim key ${key} on present id ${entry.id}`);
      }
    }
    for (const dim of dims) {
      if (!expectedKeys.includes(dim.key)) {
        throw new RecordError(`Unknown dim key ${dim.key} on ${entry.id}`);
      }
    }
    const subs = new Map<string, AtlasSub>();
    for (const dim of entry.dims) {
      for (const sub of dim.subs) subs.set(sub.key, sub);
    }
    for (const value of dims) {
      const sub = subs.get(value.key);
      if (!sub) continue;
      const legal = new Set(sub.vars.map((item) => item.name));
      for (const name of value.values) {
        if (!legal.has(name)) {
          throw new RecordError(
            `Illegal variant "${name}" for ${entry.id}.${value.key}`,
          );
        }
      }
      if (sub.sel === "one" && value.values.length !== 1) {
        throw new RecordError(
          `${entry.id}.${value.key} is sel=one; expected exactly one variant`,
        );
      }
    }
  }
}

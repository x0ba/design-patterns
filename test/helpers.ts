import { Atlas, type AtlasCodebook } from "../src/Atlas.ts";
import type {
  CaptureMeta,
  DimsDraft,
  PatternHit,
  StatusDraft,
  UiRecord,
} from "../src/Record.ts";

export class Fixtures {
  static codebook(): AtlasCodebook {
    return Atlas.load();
  }

  static capture(overrides: Partial<CaptureMeta> = {}): CaptureMeta {
    return {
      url: "https://example.com/",
      capturedAt: "2026-10-27T00:00:00.000Z",
      finalUrl: "https://example.com/",
      status: 200,
      title: "Example",
      viewport: { width: 1440, height: 900 },
      screenshotPx: { width: 1440, height: 900 },
      userAgent: "test-ua",
      screenshotRef: "example.com.png",
      domain: "docs-education",
      ...overrides,
    };
  }

  static allAbsent(codebook: AtlasCodebook): StatusDraft {
    return {
      patterns: codebook.entries.map((entry) => ({
        id: entry.id,
        status: "absent" as const,
        confidence: 0.9,
      })),
      components: [],
      structure: { layout: "single column", regions: ["main"], density: "sparse" },
      aesthetics: { palette: ["#fff"], typography: "system", mood: ["neutral"] },
      confidence: 0.8,
    };
  }

  static presentDims(codebook: AtlasCodebook, id: string): DimsDraft["hits"][number] {
    const entry = Atlas.byId(codebook).get(id);
    if (!entry) throw new Error(`missing ${id}`);
    return {
      id,
      dims: entry.dims.flatMap((dim) =>
        dim.subs.map((sub) => ({
          key: sub.key,
          values: sub.sel === "one" && sub.vars[0] ? [sub.vars[0].name] : [],
        })),
      ),
    };
  }

  static record(codebook: AtlasCodebook, patterns: PatternHit[]): UiRecord {
    const capture = Fixtures.capture();
    return {
      url: capture.url,
      capturedAt: capture.capturedAt,
      capture: {
        finalUrl: capture.finalUrl,
        status: capture.status,
        title: capture.title,
        viewport: capture.viewport,
        screenshotPx: capture.screenshotPx,
        userAgent: capture.userAgent,
      },
      screenshotRef: capture.screenshotRef,
      domain: capture.domain,
      components: [],
      patterns,
      structure: { layout: "single column", regions: ["main"], density: "sparse" },
      aesthetics: { palette: ["#fff"], typography: "system", mood: ["neutral"] },
      model: {
        name: "test",
        version: "0",
        atlasGeneratedAt: codebook.generatedAt,
      },
      confidence: 0.5,
    };
  }
}

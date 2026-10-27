import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Atlas, type AtlasCodebook } from "./Atlas.ts";
import { Capture, DEFAULT_NAV_DELAY_MS, type CaptureResult } from "./Capture.ts";
import { Labeler, type LabelResult } from "./Labeler.ts";
import { Record, type CaptureMeta, type UiRecord } from "./Record.ts";

export type Seed = {
  url: string;
  domain: string;
  stratum: string;
};

export type PipelineOptions = {
  seeds: Seed[];
  outDir: string;
  codebook?: AtlasCodebook;
  limit?: number;
  only?: string[];
  delayMs?: number;
  captureOnly?: boolean;
  doubleLabel?: number;
  labelerBin?: string;
  agentTimeoutMs?: number;
};

export type PipelineRunResult = {
  captures: { seed: Seed; slug: string; capture: CaptureResult }[];
  records: { seed: Seed; slug: string; record: UiRecord; path: string }[];
  doubles: { slug: string; a: UiRecord; b: UiRecord; path: string; agreement: Agreement }[];
  failures: { url: string; stage: "capture" | "label" | "double"; error: string }[];
};

export type RunSummary = {
  records: number;
  captures: number;
  failures: PipelineRunResult["failures"];
  doubles: { slug: string; url: string; path: string; agreement: Agreement }[];
  agreement: {
    statusN: number;
    statusAgree: number;
    statusRate: number | null;
    dimKeysCompared: number;
    dimKeysAgree: number;
    dimRate: number | null;
  };
};

export type Agreement = {
  statusN: number;
  statusAgree: number;
  statusRate: number;
  bothPresent: number;
  dimKeysCompared: number;
  dimKeysAgree: number;
  dimRate: number | null;
};

export class Pipeline {
  static loadSeeds(path = "seeds.json"): Seed[] {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Seed[];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("seeds.json must be a non-empty array");
    }
    return raw;
  }

  static slug(url: string): string {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "").replace(/^\//, "").replace(/[/]+/g, "_");
    return (path ? `${host}_${path}` : host).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
  }

  static async run(opts: PipelineOptions): Promise<PipelineRunResult> {
    const codebook = opts.codebook ?? Atlas.load();
    const delayMs = opts.delayMs ?? DEFAULT_NAV_DELAY_MS;
    const timeoutMs =
      opts.agentTimeoutMs && opts.agentTimeoutMs > 0
        ? opts.agentTimeoutMs
        : Labeler.DEFAULT_TIMEOUT_MS;
    mkdirSync(opts.outDir, { recursive: true });

    let seeds = opts.seeds;
    if (opts.only?.length) {
      const wanted = new Set(opts.only);
      seeds = seeds.filter((seed) => wanted.has(seed.url) || wanted.has(Pipeline.slug(seed.url)));
    }
    if (opts.limit && opts.limit > 0) seeds = seeds.slice(0, opts.limit);

    const result: PipelineRunResult = { captures: [], records: [], doubles: [], failures: [] };
    Pipeline.log(
      `pipeline: ${seeds.length} url(s)${opts.captureOnly ? " (capture only)" : ""}, agent timeout ${Math.round(timeoutMs / 1000)}s, out ${opts.outDir}`,
    );

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      if (i > 0 && delayMs > 0) {
        await Pipeline.sleep(delayMs);
      }
      const tag = `[${i + 1}/${seeds.length}]`;
      const slug = Pipeline.slug(seed.url);
      const screenshotPath = join(opts.outDir, `${slug}.png`);
      let captured = false;
      try {
        const capture = await Pipeline.captureOne(tag, seed.url, screenshotPath);
        captured = true;
        Capture.writeSidecar(capture, join(opts.outDir, `${slug}.capture.json`));
        result.captures.push({ seed, slug, capture });
        if (opts.captureOnly) continue;
        const labeled = await Pipeline.labelOne(
          codebook,
          seed,
          slug,
          capture,
          opts,
          timeoutMs,
          (line) => Pipeline.log(`${tag} ${line}`),
        );
        result.records.push(labeled);
        Pipeline.log(`${tag} wrote ${labeled.path}`);
      } catch (error) {
        const stage = captured ? "label" : "capture";
        Pipeline.log(`FAIL ${tag} ${stage}: ${Pipeline.brief(error)}`);
        result.failures.push({
          url: seed.url,
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const doubleN = opts.doubleLabel ?? 0;
    if (!opts.captureOnly && doubleN > 0) {
      const targets = result.records.slice(0, doubleN);
      for (let d = 0; d < targets.length; d++) {
        const first = targets[d]!;
        const tag = `double [${d + 1}/${targets.length}]`;
        try {
          const capture = result.captures.find((item) => item.slug === first.slug)!.capture;
          const second = await Pipeline.labelOne(
            codebook,
            first.seed,
            first.slug,
            capture,
            opts,
            timeoutMs,
            (line) => Pipeline.log(`${tag} ${line}`),
            ".b",
          );
          const agreement = Pipeline.agreement(first.record, second.record);
          result.doubles.push({
            slug: first.slug,
            a: first.record,
            b: second.record,
            path: second.path,
            agreement,
          });
          const dims =
            agreement.dimRate == null ? "n/a" : agreement.dimRate.toFixed(3);
          Pipeline.log(
            `${tag} agreement status ${agreement.statusRate.toFixed(3)} dims ${dims}`,
          );
        } catch (error) {
          Pipeline.log(`FAIL ${tag}: ${Pipeline.brief(error)}`);
          result.failures.push({
            url: first.seed.url,
            stage: "double",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const summary = Pipeline.summarize(result);
    const summaryPath = Pipeline.writeSummary(summary, opts.outDir);
    Pipeline.log(Pipeline.formatSummary(summary));
    Pipeline.log(`wrote ${summaryPath}`);
    return result;
  }

  static summarize(result: Pick<PipelineRunResult, "captures" | "records" | "doubles" | "failures">): RunSummary {
    let statusN = 0;
    let statusAgree = 0;
    let dimKeysCompared = 0;
    let dimKeysAgree = 0;
    for (const item of result.doubles) {
      statusN += item.agreement.statusN;
      statusAgree += item.agreement.statusAgree;
      dimKeysCompared += item.agreement.dimKeysCompared;
      dimKeysAgree += item.agreement.dimKeysAgree;
    }
    return {
      records: result.records.length,
      captures: result.captures.length,
      failures: result.failures,
      doubles: result.doubles.map((item) => ({
        slug: item.slug,
        url: item.a.url,
        path: item.path,
        agreement: item.agreement,
      })),
      agreement: {
        statusN,
        statusAgree,
        statusRate: statusN ? statusAgree / statusN : null,
        dimKeysCompared,
        dimKeysAgree,
        dimRate: dimKeysCompared ? dimKeysAgree / dimKeysCompared : null,
      },
    };
  }

  static writeSummary(summary: RunSummary, outDir: string): string {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "summary.json");
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
  }

  static formatSummary(summary: RunSummary): string {
    const status =
      summary.agreement.statusRate == null ? "n/a" : summary.agreement.statusRate.toFixed(3);
    const dims = summary.agreement.dimRate == null ? "n/a" : summary.agreement.dimRate.toFixed(3);
    return `summary: ${summary.records} records, ${summary.failures.length} failures, double ${summary.doubles.length}, status agreement ${status}, dim agreement ${dims}`;
  }

  static formatElapsed(ms: number): string {
    return Labeler.formatElapsed(ms);
  }

  static log(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  static agreement(a: UiRecord, b: UiRecord): Agreement {
    const bById = new Map(b.patterns.map((hit) => [hit.id, hit]));
    let statusAgree = 0;
    let bothPresent = 0;
    let dimKeysCompared = 0;
    let dimKeysAgree = 0;
    for (const hit of a.patterns) {
      const other = bById.get(hit.id);
      if (!other) continue;
      if (hit.status === other.status) statusAgree += 1;
      if (hit.status === "present" && other.status === "present") {
        bothPresent += 1;
        const otherDims = new Map(other.dims.map((dim) => [dim.key, new Set(dim.values)]));
        for (const dim of hit.dims) {
          dimKeysCompared += 1;
          const values = otherDims.get(dim.key);
          if (values && Pipeline.sameSet(values, dim.values)) dimKeysAgree += 1;
        }
      }
    }
    return {
      statusN: a.patterns.length,
      statusAgree,
      statusRate: a.patterns.length ? statusAgree / a.patterns.length : 0,
      bothPresent,
      dimKeysCompared,
      dimKeysAgree,
      dimRate: dimKeysCompared ? dimKeysAgree / dimKeysCompared : null,
    };
  }

  private static async captureOne(tag: string, url: string, screenshotPath: string): Promise<CaptureResult> {
    const started = Date.now();
    Pipeline.log(`${tag} capture ${url}`);
    const stop = Pipeline.pulse(Labeler.WAIT_EVERY_MS, () => {
      Pipeline.log(
        `${tag} capture ${url} still running (${Pipeline.formatElapsed(Date.now() - started)})`,
      );
    });
    try {
      const capture = await Capture.fromUrl(url, { screenshotPath });
      Pipeline.log(`${tag} capture ${url} ok (${Pipeline.formatElapsed(Date.now() - started)})`);
      return capture;
    } finally {
      stop();
    }
  }

  private static async labelOne(
    codebook: AtlasCodebook,
    seed: Seed,
    slug: string,
    capture: CaptureResult,
    opts: PipelineOptions,
    timeoutMs: number,
    log: (line: string) => void,
    suffix = "",
  ): Promise<{ seed: Seed; slug: string; record: UiRecord; path: string }> {
    const labeled: LabelResult = await Labeler.label({
      codebook,
      screenshotPath: capture.screenshotPath,
      ariaSnapshot: capture.ariaSnapshot,
      url: seed.url,
      bin: opts.labelerBin,
      timeoutMs,
      log,
    });
    const meta: CaptureMeta = {
      url: seed.url,
      capturedAt: capture.capturedAt,
      finalUrl: capture.finalUrl,
      status: capture.status,
      title: capture.title,
      viewport: capture.viewport,
      screenshotPx: capture.screenshotPx,
      userAgent: capture.userAgent,
      screenshotRef: `${slug}.png`,
      domain: seed.domain,
    };
    const record = Record.merge(
      { capture: meta, status: labeled.status, dims: labeled.dims, model: labeled.model },
      codebook,
    );
    const path = join(opts.outDir, `${slug}${suffix}.json`);
    Pipeline.writeRecord(record, path, suffix);
    return { seed, slug, record, path };
  }

  static writeRecord(record: UiRecord, path: string, suffix = ""): void {
    if (suffix === "") {
      Record.write(record, path, { omitAbsent: true });
      return;
    }
    Record.write(record, path);
  }

  private static sameSet(values: Set<string>, other: string[]): boolean {
    if (values.size !== other.length) return false;
    return other.every((item) => values.has(item));
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static pulse(everyMs: number, fn: () => void): () => void {
    const timer = setInterval(fn, everyMs);
    return () => clearInterval(timer);
  }

  private static brief(error: unknown, max = 300): string {
    const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
}

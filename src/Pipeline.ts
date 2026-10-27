import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Atlas, type AtlasCodebook } from "./Atlas.ts";
import { Capture, CaptureError, DEFAULT_NAV_DELAY_MS, type CaptureResult } from "./Capture.ts";
import { Labeler, type LabelResult } from "./Labeler.ts";
import { Output } from "./Output.ts";
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
  fromCapture?: boolean;
  doubleLabel?: number;
  resume?: boolean;
  labelerBin?: string;
  log?: (line: string) => void;
  agentTimeoutMs?: number;
  model?: string;
  concurrency?: number;
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
  model: string;
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
  static readonly DEFAULT_CONCURRENCY = 4;

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
    const query = parsed.search.replace(/^\?/, "").replace(/[&?=]+/g, "-");
    const stem = [host, path, query]
      .filter(Boolean)
      .join("_")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 100);
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
    return `${stem}-${hash}`;
  }

  static claimSlug(seen: Map<string, string>, slug: string, url: string): void {
    const prior = seen.get(slug);
    if (prior && prior !== url) {
      throw new Error(`Output path collision: ${slug} already used by ${prior}`);
    }
    seen.set(slug, url);
  }

  static concurrencyOf(value: number | undefined): number {
    if (value == null) return Pipeline.DEFAULT_CONCURRENCY;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("--concurrency requires a positive integer");
    }
    return value;
  }

  static async runPool<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.min(Pipeline.concurrencyOf(concurrency), items.length);
    let cursor = 0;
    const runners = Array.from({ length: limit }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    });
    await Promise.all(runners);
  }

  static hostGate(): { enter(host: string, delayMs: number): Promise<() => void> } {
    const tail = new Map<string, Promise<void>>();
    const lastFinished = new Map<string, number>();
    return {
      enter(host: string, delayMs: number) {
        const previous = tail.get(host) ?? Promise.resolve();
        let releaseCurrent: () => void = () => {};
        const current = new Promise<void>((resolve) => {
          releaseCurrent = resolve;
        });
        const ready = previous.then(async () => {
          const finishedAt = lastFinished.get(host);
          if (finishedAt != null && delayMs > 0) {
            const wait = delayMs - (Date.now() - finishedAt);
            if (wait > 0) await Pipeline.sleep(wait);
          }
        });
        tail.set(
          host,
          ready.then(() => current),
        );
        return ready.then(() => () => {
          lastFinished.set(host, Date.now());
          releaseCurrent();
        });
      },
    };
  }

  static async run(opts: PipelineOptions): Promise<PipelineRunResult> {
    const codebook = opts.codebook ?? Atlas.load();
    const delayMs = opts.delayMs ?? DEFAULT_NAV_DELAY_MS;
    const timeoutMs =
      opts.agentTimeoutMs && opts.agentTimeoutMs > 0
        ? opts.agentTimeoutMs
        : Labeler.DEFAULT_TIMEOUT_MS;
    const model = opts.model?.trim() || Labeler.DEFAULT_MODEL;
    const fromCapture = Boolean(opts.fromCapture) && !opts.captureOnly;
    const resume = Boolean(opts.resume);
    const concurrency = Pipeline.concurrencyOf(opts.concurrency);
    const log = (line: string) => Pipeline.emit(opts.log, line);
    mkdirSync(opts.outDir, { recursive: true });

    let seeds = opts.seeds;
    if (opts.only?.length) {
      const wanted = new Set(opts.only);
      seeds = seeds.filter((seed) => wanted.has(seed.url) || wanted.has(Pipeline.slug(seed.url)));
    }
    if (opts.limit && opts.limit > 0) seeds = seeds.slice(0, opts.limit);

    const result: PipelineRunResult = { captures: [], records: [], doubles: [], failures: [] };
    const mode = [
      opts.captureOnly ? "capture only" : "",
      fromCapture ? "from capture" : "",
      resume ? "resume" : "",
    ].filter(Boolean);
    const modeText = mode.length ? ` (${mode.join(", ")})` : "";
    log(
      `pipeline: ${seeds.length} url(s)${modeText}, model ${model}, agent timeout ${Math.round(timeoutMs / 1000)}s, concurrency ${concurrency}, out ${opts.outDir}`,
    );

    const seenSlugs = new Map<string, string>();
    const gate = Pipeline.hostGate();
    await Pipeline.runPool(seeds, concurrency, async (seed, i) => {
      const tag = `[${i + 1}/${seeds.length}]`;
      let captured = false;
      try {
        const slug = Pipeline.slug(seed.url);
        Pipeline.claimSlug(seenSlugs, slug, seed.url);
        const recordPath = join(opts.outDir, `${slug}.json`);
        const sidecarPath = join(opts.outDir, `${slug}.capture.json`);
        const screenshotPath = join(opts.outDir, `${slug}.png`);
        if (resume) {
          const saved = Pipeline.loadDone(recordPath, codebook, seed.url, true);
          if (saved) {
            log(`${tag} skip (done) ${seed.url}`);
            result.records.push({ seed, slug, record: saved, path: recordPath });
            const existing = Pipeline.tryReuse(sidecarPath, seed.url);
            if (existing) result.captures.push({ seed, slug, capture: existing });
            return;
          }
        }
        const capture = await Pipeline.acquireCapture(
          tag,
          seed.url,
          sidecarPath,
          screenshotPath,
          fromCapture,
          resume,
          gate,
          delayMs,
          log,
        );
        captured = true;
        result.captures.push({ seed, slug, capture });
        if (opts.captureOnly) return;
        const labeled = await Pipeline.labelOne(
          codebook,
          seed,
          slug,
          capture,
          opts,
          timeoutMs,
          model,
          (line) => log(`${tag} ${line}`),
        );
        result.records.push(labeled);
        log(`${tag} wrote ${labeled.path}`);
      } catch (error) {
        const stage = captured ? "label" : "capture";
        for (const line of Labeler.issueLines(error)) {
          log(`FAIL ${tag} ${stage}: ${line}`);
        }
        result.failures.push({
          url: seed.url,
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const doubleN = opts.doubleLabel ?? 0;
    if (!opts.captureOnly && doubleN > 0) {
      const recordsByUrl = new Map(result.records.map((item) => [item.seed.url, item]));
      const targets = seeds
        .map((seed) => recordsByUrl.get(seed.url))
        .filter((item): item is PipelineRunResult["records"][number] => item != null)
        .slice(0, doubleN);
      await Pipeline.runPool(targets, concurrency, async (first, d) => {
        const tag = `double [${d + 1}/${targets.length}]`;
        try {
          const bPath = join(opts.outDir, `${first.slug}.b.json`);
          if (resume) {
            const savedB = Pipeline.loadDone(bPath, codebook, first.seed.url, false);
            if (savedB) {
              const agreement = Pipeline.agreement(first.record, savedB);
              result.doubles.push({
                slug: first.slug,
                a: first.record,
                b: savedB,
                path: bPath,
                agreement,
              });
              log(`${tag} skip (done) ${first.seed.url}`);
              return;
            }
          }
          const found = result.captures.find((item) => item.slug === first.slug);
          if (!found) {
            throw new CaptureError(`No saved capture for ${first.seed.url}`);
          }
          const second = await Pipeline.labelOne(
            codebook,
            first.seed,
            first.slug,
            found.capture,
            opts,
            timeoutMs,
            model,
            (line) => log(`${tag} ${line}`),
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
          const dims = agreement.dimRate == null ? "n/a" : agreement.dimRate.toFixed(3);
          log(`${tag} agreement status ${agreement.statusRate.toFixed(3)} dims ${dims}`);
        } catch (error) {
          for (const line of Labeler.issueLines(error)) {
            log(`FAIL ${tag}: ${line}`);
          }
          result.failures.push({
            url: first.seed.url,
            stage: "double",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    const summary = Pipeline.summarizeDisk(opts.outDir, codebook, result.failures, model);
    const summaryPath = Pipeline.writeSummary(summary, opts.outDir);
    log(Pipeline.formatSummary(summary));
    log(`wrote ${summaryPath}`);
    return result;
  }

  static summarize(
    result: Pick<PipelineRunResult, "captures" | "records" | "doubles" | "failures">,
    model = Labeler.DEFAULT_MODEL,
  ): RunSummary {
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
      model,
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

  static summarizeDisk(
    outDir: string,
    codebook: AtlasCodebook,
    failures: PipelineRunResult["failures"],
    model = Labeler.DEFAULT_MODEL,
  ): RunSummary {
    const names = readdirSync(outDir);
    const captures: PipelineRunResult["captures"] = [];
    const records: PipelineRunResult["records"] = [];
    const bySlug = new Map<string, PipelineRunResult["records"][number]>();
    for (const name of names) {
      if (Pipeline.ignoredOutput(name) || name === "summary.json") continue;
      const path = join(outDir, name);
      if (name.endsWith(".capture.json")) {
        try {
          const capture = Capture.readSidecar(path);
          captures.push({
            seed: { url: capture.url, domain: "", stratum: "" },
            slug: name.slice(0, -".capture.json".length),
            capture,
          });
        } catch {
          // A partial sidecar is not counted.
        }
        continue;
      }
      if (name.endsWith(".b.json") || !name.endsWith(".json")) continue;
      try {
        const record = Record.readSaved(path, codebook, { fillAbsent: true });
        const slug = name.slice(0, -".json".length);
        const item = {
          seed: { url: record.url, domain: record.domain, stratum: record.domain },
          slug,
          record,
          path,
        };
        records.push(item);
        bySlug.set(slug, item);
      } catch {
        // An invalid primary is left for this run to redo; it is not a summary record.
      }
    }
    const doubles: PipelineRunResult["doubles"] = [];
    for (const name of names) {
      if (Pipeline.ignoredOutput(name) || !name.endsWith(".b.json")) continue;
      const slug = name.slice(0, -".b.json".length);
      const primary = bySlug.get(slug);
      if (!primary) continue;
      const path = join(outDir, name);
      try {
        const second = Record.readSaved(path, codebook, { fillAbsent: false });
        if (second.url !== primary.record.url) continue;
        doubles.push({
          slug,
          a: primary.record,
          b: second,
          path,
          agreement: Pipeline.agreement(primary.record, second),
        });
      } catch {
        // An invalid double-label file is omitted.
      }
    }
    records.sort((a, b) => a.slug.localeCompare(b.slug));
    doubles.sort((a, b) => a.slug.localeCompare(b.slug));
    return Pipeline.summarize({ captures, records, doubles, failures }, model);
  }

  static writeSummary(summary: RunSummary, outDir: string): string {
    const path = join(outDir, "summary.json");
    Output.write(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
  }

  static formatSummary(summary: RunSummary): string {
    const status =
      summary.agreement.statusRate == null ? "n/a" : summary.agreement.statusRate.toFixed(3);
    const dims = summary.agreement.dimRate == null ? "n/a" : summary.agreement.dimRate.toFixed(3);
    return `summary: ${summary.records} records, ${summary.failures.length} failures, double ${summary.doubles.length}, status agreement ${status}, dim agreement ${dims}, model ${summary.model}`;
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

  private static loadDone(
    path: string,
    codebook: AtlasCodebook,
    url: string,
    fillAbsent: boolean,
  ): UiRecord | undefined {
    if (!existsSync(path)) return undefined;
    try {
      const record = Record.readSaved(path, codebook, { fillAbsent });
      return record.url === url ? record : undefined;
    } catch {
      return undefined;
    }
  }

  private static tryReuse(sidecarPath: string, url: string): CaptureResult | undefined {
    try {
      const capture = Capture.readSidecar(sidecarPath);
      return capture.url === url ? capture : undefined;
    } catch {
      return undefined;
    }
  }

  private static async acquireCapture(
    tag: string,
    url: string,
    sidecarPath: string,
    screenshotPath: string,
    fromCapture: boolean,
    resume: boolean,
    gate: { enter(host: string, delayMs: number): Promise<() => void> },
    delayMs: number,
    log: (line: string) => void,
  ): Promise<CaptureResult> {
    if (resume || fromCapture) {
      const existing = Pipeline.tryReuse(sidecarPath, url);
      if (existing) {
        log(`${tag} reuse ${url}`);
        log(`${tag} reuse ${url} ok`);
        return existing;
      }
      if (fromCapture) return Pipeline.reuseOne(tag, url, sidecarPath, log);
    }
    const capture = await Pipeline.captureOne(tag, url, screenshotPath, gate, delayMs, log);
    Capture.writeSidecar(capture, sidecarPath);
    return capture;
  }

  private static reuseOne(
    tag: string,
    url: string,
    sidecarPath: string,
    log: (line: string) => void,
  ): CaptureResult {
    log(`${tag} reuse ${url}`);
    const capture = Capture.readSidecar(sidecarPath);
    if (capture.url !== url) {
      throw new CaptureError(`Saved capture URL ${capture.url} does not match seed ${url}`);
    }
    log(`${tag} reuse ${url} ok`);
    return capture;
  }

  private static async captureOne(
    tag: string,
    url: string,
    screenshotPath: string,
    gate: { enter(host: string, delayMs: number): Promise<() => void> },
    delayMs: number,
    log: (line: string) => void,
  ): Promise<CaptureResult> {
    const host = new URL(url).host;
    const release = await gate.enter(host, delayMs);
    const started = Date.now();
    log(`${tag} capture ${url}`);
    const stop = Pipeline.pulse(Labeler.WAIT_EVERY_MS, () => {
      log(`${tag} capture ${url} still running (${Pipeline.formatElapsed(Date.now() - started)})`);
    });
    try {
      const capture = await Capture.fromUrl(url, { screenshotPath });
      log(`${tag} capture ${url} ok (${Pipeline.formatElapsed(Date.now() - started)})`);
      return capture;
    } finally {
      stop();
      release();
    }
  }

  private static async labelOne(
    codebook: AtlasCodebook,
    seed: Seed,
    slug: string,
    capture: CaptureResult,
    opts: PipelineOptions,
    timeoutMs: number,
    model: string,
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
      model,
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

  private static ignoredOutput(name: string): boolean {
    return name.startsWith(".") || name.endsWith(".tmp");
  }

  private static emit(log: ((line: string) => void) | undefined, line: string): void {
    if (log) log(line);
    else Pipeline.log(line);
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

}

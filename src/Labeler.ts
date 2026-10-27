import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { Atlas, type AtlasCodebook } from "./Atlas.ts";
import { Record, type DimsDraft, type StatusDraft } from "./Record.ts";

export type LabelResult = {
  status: StatusDraft;
  dims: DimsDraft;
  model: { name: string; version: string };
};

export class LabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabelError";
  }
}

type AgentEnvelope = {
  result?: unknown;
  model?: unknown;
  type?: unknown;
};

export type LabelLog = (line: string) => void;

export class Labeler {
  static readonly DEFAULT_BIN = "cursor-agent";
  static readonly DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
  static readonly WAIT_EVERY_MS = 30_000;
  static readonly AUTH_HINT =
    "Labeler shells `cursor-agent -p --output-format json --force --trust`. " +
    "Authenticate as Daniel: `agent login` (Cursor account) or set CURSOR_API_KEY. " +
    "Install: `curl https://cursor.com/install -fsS | bash` then put ~/.local/bin on PATH.";

  static async label(args: {
    codebook: AtlasCodebook;
    screenshotPath: string;
    ariaSnapshot: string;
    url: string;
    bin?: string;
    timeoutMs?: number;
    log?: LabelLog;
  }): Promise<LabelResult> {
    const screenshot = resolve(args.screenshotPath);
    const timeoutMs = Labeler.timeoutMs(args.timeoutMs);
    const log = args.log ?? (() => {});
    const bin = args.bin;

    log("label status…");
    const statusStarted = Date.now();
    const status = await Labeler.runStatus(
      args.codebook,
      screenshot,
      args.ariaSnapshot,
      args.url,
      bin,
      timeoutMs,
      (elapsedMs) => log(`label status… still running (${Labeler.formatElapsed(elapsedMs)})`),
      (error) => log(`label status… retry (${Labeler.brief(error)})`),
    );
    const presentIds = status.draft.patterns
      .filter((hit) => hit.status === "present")
      .map((hit) => hit.id);
    log(
      `label status… ok (${Labeler.formatElapsed(Date.now() - statusStarted)}, ${presentIds.length} present)`,
    );

    const dims =
      presentIds.length === 0
        ? { hits: [] }
        : await Labeler.timedDims(args.codebook, screenshot, presentIds, args.url, bin, timeoutMs, log);
    if (presentIds.length === 0) log("label dims… skip (0 present)");

    return {
      status: status.draft,
      dims,
      model: status.model,
    };
  }

  static async exec(opts: {
    bin: string;
    args: string[];
    timeoutMs: number;
    onWait?: (elapsedMs: number) => void;
    waitEveryMs?: number;
  }): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeoutMs = Labeler.timeoutMs(opts.timeoutMs);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(opts.bin, opts.args, {
        detached: true,
        env: {
          ...process.env,
          PATH: `${process.env.HOME ?? ""}/.local/bin:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const started = Date.now();
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(pulse);
        fn();
      };
      const timer = setTimeout(() => {
        Labeler.kill(child);
        finish(() => reject(new LabelError(`cursor-agent timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      const pulse = setInterval(() => {
        opts.onWait?.(Date.now() - started);
      }, opts.waitEveryMs ?? Labeler.WAIT_EVERY_MS);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        Labeler.kill(child);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          finish(() => reject(new LabelError(`cursor-agent not installed. ${Labeler.AUTH_HINT}`)));
          return;
        }
        finish(() => reject(error));
      });
      child.on("close", (code) => {
        finish(() => resolvePromise({ code, stdout, stderr }));
      });
    });
  }

  private static async timedDims(
    codebook: AtlasCodebook,
    screenshot: string,
    presentIds: string[],
    url: string,
    bin: string | undefined,
    timeoutMs: number,
    log: LabelLog,
  ): Promise<DimsDraft> {
    log("label dims…");
    const started = Date.now();
    const dims = await Labeler.runDims(
      codebook,
      screenshot,
      presentIds,
      url,
      bin,
      timeoutMs,
      (elapsedMs) => log(`label dims… still running (${Labeler.formatElapsed(elapsedMs)})`),
      (error) => log(`label dims… retry (${Labeler.brief(error)})`),
    );
    log(`label dims… ok (${Labeler.formatElapsed(Date.now() - started)})`);
    return dims;
  }

  private static async runStatus(
    codebook: AtlasCodebook,
    screenshot: string,
    ariaSnapshot: string,
    url: string,
    bin: string | undefined,
    timeoutMs: number,
    onWait: (elapsedMs: number) => void,
    onRetry: (error: unknown) => void,
  ): Promise<{ draft: StatusDraft; model: { name: string; version: string } }> {
    const prompt = Labeler.statusPrompt(codebook, screenshot, ariaSnapshot, url);
    const parsed = await Labeler.callAgent(
      prompt,
      (text) => Record.StatusDraft.parse(Labeler.parseJson(text)),
      { bin, timeoutMs, onWait, onRetry },
    );
    return { draft: parsed.value, model: parsed.model };
  }

  private static async runDims(
    codebook: AtlasCodebook,
    screenshot: string,
    presentIds: string[],
    url: string,
    bin: string | undefined,
    timeoutMs: number,
    onWait: (elapsedMs: number) => void,
    onRetry: (error: unknown) => void,
  ): Promise<DimsDraft> {
    const prompt = Labeler.dimsPrompt(codebook, screenshot, presentIds, url);
    const parsed = await Labeler.callAgent(
      prompt,
      (text) => Record.DimsDraft.parse(Labeler.parseJson(text)),
      { bin, timeoutMs, onWait, onRetry },
    );
    return parsed.value;
  }

  private static async callAgent<T>(
    prompt: string,
    parse: (resultText: string) => T,
    opts: {
      bin?: string;
      timeoutMs: number;
      onWait?: (elapsedMs: number) => void;
      onRetry?: (error: unknown) => void;
    },
  ): Promise<{ value: T; model: { name: string; version: string } }> {
    const bin = opts.bin ?? Labeler.DEFAULT_BIN;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const retryNote =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply failed validation:\n${Labeler.errorText(lastError)}\nReturn only one valid JSON object.`;
      try {
        const envelope = await Labeler.spawn(bin, retryNote, opts.timeoutMs, opts.onWait);
        const resultText = Labeler.resultText(envelope);
        if (Labeler.looksLikeNoVision(resultText)) {
          throw new LabelError("Chosen model could not read the screenshot; not dropping vision");
        }
        return {
          value: parse(resultText),
          model: Labeler.modelFrom(envelope),
        };
      } catch (error) {
        lastError = error;
        if (Labeler.isFatal(error)) throw error;
        if (attempt === 0) opts.onRetry?.(error);
      }
    }
    throw new LabelError(`cursor-agent failed after retry: ${Labeler.errorText(lastError)}`);
  }

  private static async spawn(
    bin: string,
    prompt: string,
    timeoutMs: number,
    onWait?: (elapsedMs: number) => void,
  ): Promise<AgentEnvelope> {
    const out = await Labeler.exec({
      bin,
      args: ["-p", "--output-format", "json", "--force", "--trust", prompt],
      timeoutMs,
      onWait,
    });
    const combined = `${out.stderr}\n${out.stdout}`;
    const authish = /authentication required|not logged in|CURSOR_API_KEY|agent login/i.test(combined);
    if (authish) {
      throw new LabelError(
        `cursor-agent auth failed (exit ${out.code}). ${Labeler.AUTH_HINT}\n${combined.trim()}`,
      );
    }
    if (out.code !== 0) {
      throw new LabelError(`cursor-agent exited ${out.code}: ${combined.trim()}`);
    }
    try {
      return JSON.parse(out.stdout.trim()) as AgentEnvelope;
    } catch {
      throw new LabelError(`cursor-agent stdout was not JSON: ${out.stdout.slice(0, 400)}`);
    }
  }

  private static kill(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    const followup = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 1000);
    followup.unref();
    child.unref();
  }

  private static timeoutMs(value: number | undefined): number {
    return value && value > 0 ? value : Labeler.DEFAULT_TIMEOUT_MS;
  }

  private static isFatal(error: unknown): boolean {
    return (
      error instanceof LabelError &&
      (error.message.includes("could not read the screenshot") || error.message.includes("timed out"))
    );
  }

  static formatElapsed(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
  }

  private static brief(error: unknown, max = 180): string {
    const text = Labeler.errorText(error).replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  private static resultText(envelope: AgentEnvelope): string {
    if (typeof envelope.result !== "string") {
      throw new LabelError("cursor-agent envelope missing string result");
    }
    return envelope.result;
  }

  private static parseJson(text: string): unknown {
    const stripped = Labeler.stripFences(text).trim();
    if (stripped === '{"error":"no-vision"}' || stripped.includes('"error":"no-vision"')) {
      throw new LabelError("Chosen model could not read the screenshot; not dropping vision");
    }
    try {
      return JSON.parse(stripped);
    } catch {
      const start = stripped.indexOf("{");
      const end = stripped.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(stripped.slice(start, end + 1));
      }
      throw new LabelError("Could not parse JSON object from cursor-agent result");
    }
  }

  private static stripFences(text: string): string {
    return text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  private static looksLikeNoVision(text: string): boolean {
    return /cannot (read|see|open|access) (the )?(image|screenshot|png)/i.test(text);
  }

  private static modelFrom(envelope: AgentEnvelope): { name: string; version: string } {
    if (typeof envelope.model === "string" && envelope.model.trim()) {
      return { name: envelope.model, version: "cursor-agent" };
    }
    return { name: "cursor-agent", version: "unknown" };
  }

  private static errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static statusPrompt(
    codebook: AtlasCodebook,
    screenshot: string,
    ariaSnapshot: string,
    url: string,
  ): string {
    return [
      "You are labeling a real public UI against the Design Pattern Atlas codebook.",
      "Return ONLY one JSON object. No markdown fences, no prose.",
      `Page URL: ${url}`,
      `Screenshot PNG path (read this image with your file tools; --force/--trust are on): ${screenshot}`,
      "If you cannot read the image, return {\"error\":\"no-vision\"} and nothing else. Do not guess from the aria tree alone.",
      "",
      "Accessibility tree of the SAME clipped page (viewport width 1440, clipped at 8000 CSS px):",
      ariaSnapshot,
      "",
      "Slim codebook (closed coding — only these 119 ids exist):",
      JSON.stringify(Atlas.slim(codebook)),
      "",
      "Emit a status for EVERY id. Schema:",
      JSON.stringify({
        patterns: [
          {
            id: "<atlas id>",
            status: "present|absent|uncertain",
            confidence: 0,
            evidence: [{ kind: "text", quote: "..." }],
            rationale: "required when uncertain",
          },
        ],
        components: [{ role: "header", name: "optional", atlasIds: ["id"] }],
        structure: { layout: "string", regions: ["..."], density: "sparse|medium|dense" },
        aesthetics: { palette: ["max 8"], typography: "string", mood: ["max 5"] },
        confidence: 0,
        notes: "optional free text; never invent an id",
      }),
      "",
      "Rules:",
      "- exactly 119 pattern objects, one per codebook id",
      "- present requires 1–3 evidence items that are actually on the screenshot (text quote or visual bbox in CSS px)",
      "- uncertain requires a short rationale (unseen modal/menu/auth chrome, or clipped below 8000 px, or agent-coded def you cannot verify)",
      "- absent may include an optional short rationale",
      "- do not emit dimension values in this pass",
      "- notes is free text only; never a new id",
    ].join("\n");
  }

  private static dimsPrompt(
    codebook: AtlasCodebook,
    screenshot: string,
    presentIds: string[],
    url: string,
  ): string {
    const entries = Atlas.dimsFor(codebook, presentIds);
    return [
      "You already marked some Atlas ids present on this UI. Now code every sub-dimension for those ids.",
      "Return ONLY one JSON object. No markdown fences, no prose.",
      `Page URL: ${url}`,
      `Screenshot PNG path (read this image with your file tools): ${screenshot}`,
      "If you cannot read the image, return {\"error\":\"no-vision\"}.",
      "",
      "Present entries with their design-space dimensions:",
      JSON.stringify(entries),
      "",
      "Schema:",
      JSON.stringify({
        hits: [{ id: "<present id>", dims: [{ key: "<sub key>", values: ["<exact var name>"] }] }],
      }),
      "",
      "Rules:",
      "- one hit per present id",
      "- every sub of that entry must appear as a dim key",
      "- sel=one: exactly one var name from that sub's list",
      "- sel=many: zero or more var names from that sub's list",
      "- use exact vars[].name strings; do not invent variants",
    ].join("\n");
  }
}

import { spawn } from "node:child_process";
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

export class Labeler {
  static readonly DEFAULT_BIN = "cursor-agent";
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
  }): Promise<LabelResult> {
    const screenshot = resolve(args.screenshotPath);
    const status = await Labeler.runStatus(args.codebook, screenshot, args.ariaSnapshot, args.url, args.bin);
    const presentIds = status.draft.patterns
      .filter((hit) => hit.status === "present")
      .map((hit) => hit.id);
    const dims =
      presentIds.length === 0
        ? { hits: [] }
        : await Labeler.runDims(args.codebook, screenshot, presentIds, args.url, args.bin);

    return {
      status: status.draft,
      dims,
      model: status.model,
    };
  }

  private static async runStatus(
    codebook: AtlasCodebook,
    screenshot: string,
    ariaSnapshot: string,
    url: string,
    bin?: string,
  ): Promise<{ draft: StatusDraft; model: { name: string; version: string } }> {
    const prompt = Labeler.statusPrompt(codebook, screenshot, ariaSnapshot, url);
    const parsed = await Labeler.callAgent(prompt, (text) => Record.StatusDraft.parse(Labeler.parseJson(text)), bin);
    return { draft: parsed.value, model: parsed.model };
  }

  private static async runDims(
    codebook: AtlasCodebook,
    screenshot: string,
    presentIds: string[],
    url: string,
    bin?: string,
  ): Promise<DimsDraft> {
    const prompt = Labeler.dimsPrompt(codebook, screenshot, presentIds, url);
    const parsed = await Labeler.callAgent(prompt, (text) => Record.DimsDraft.parse(Labeler.parseJson(text)), bin);
    return parsed.value;
  }

  private static async callAgent<T>(
    prompt: string,
    parse: (resultText: string) => T,
    bin = Labeler.DEFAULT_BIN,
  ): Promise<{ value: T; model: { name: string; version: string } }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const retryNote =
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous reply failed validation:\n${Labeler.errorText(lastError)}\nReturn only one valid JSON object.`;
      try {
        const envelope = await Labeler.spawn(bin, retryNote);
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
        if (error instanceof LabelError && error.message.includes("could not read the screenshot")) {
          throw error;
        }
      }
    }
    throw new LabelError(`cursor-agent failed after retry: ${Labeler.errorText(lastError)}`);
  }

  private static spawn(bin: string, prompt: string): Promise<AgentEnvelope> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        bin,
        ["-p", "--output-format", "json", "--force", "--trust", prompt],
        {
          env: {
            ...process.env,
            PATH: `${process.env.HOME ?? ""}/.local/bin:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new LabelError(`cursor-agent not installed. ${Labeler.AUTH_HINT}`));
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        const combined = `${stderr}\n${stdout}`;
        const authish = /authentication required|not logged in|CURSOR_API_KEY|agent login/i.test(
          combined,
        );
        if (authish) {
          reject(
            new LabelError(
              `cursor-agent auth failed (exit ${code}). ${Labeler.AUTH_HINT}\n${combined.trim()}`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(new LabelError(`cursor-agent exited ${code}: ${combined.trim()}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout.trim()) as AgentEnvelope);
        } catch {
          reject(new LabelError(`cursor-agent stdout was not JSON: ${stdout.slice(0, 400)}`));
        }
      });
    });
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

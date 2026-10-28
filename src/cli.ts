import { resolve } from "node:path";
import { Atlas } from "./Atlas.ts";
import { Labeler } from "./Labeler.ts";
import { Pipeline } from "./Pipeline.ts";

class Cli {
  static async main(argv: string[]): Promise<void> {
    const [cmd = "help", ...rest] = argv;
    switch (cmd) {
      case "extract":
        Cli.extract(rest);
        return;
      case "capture":
        await Cli.pipeline(rest, true);
        return;
      case "run":
        await Cli.pipeline(rest, false);
        return;
      case "help":
      case "--help":
      case "-h":
        Cli.help();
        return;
      default:
        console.error(`Unknown command: ${cmd}`);
        Cli.help();
        process.exitCode = 1;
    }
  }

  private static extract(args: string[]): void {
    const html = args[0];
    if (!html) {
      throw new Error("usage: tsx src/cli.ts extract <atlas.html> [out.json]");
    }
    const out = args[1] ?? Atlas.defaultPath();
    const codebook = Atlas.extractFile(html, out);
    console.log(
      `Wrote ${out} (${codebook.entries.length} entries, generatedAt ${codebook.generatedAt})`,
    );
  }

  private static async pipeline(args: string[], captureOnly: boolean): Promise<void> {
    const flags = Cli.flags(args);
    const outDir = resolve(String(flags.out ?? "output"));
    const result = await Pipeline.run({
      seeds: Pipeline.loadSeeds(String(flags.seeds ?? "seeds.json")),
      outDir,
      limit: flags.limit ? Number(flags.limit) : undefined,
      only: flags.url ? [String(flags.url)] : undefined,
      delayMs: flags.delay ? Number(flags.delay) : undefined,
      captureOnly,
      fromCapture: captureOnly ? false : flags["from-capture"] === true,
      doubleLabel: captureOnly ? 0 : flags.double ? Number(flags.double) : 0,
      agentTimeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
      model: Cli.modelFlag(flags.model),
      concurrency: Cli.concurrencyFlag(flags.concurrency),
      resume: flags.resume === true,
    });

    console.log(
      JSON.stringify(
        {
          outDir,
          captureOnly,
          captured: result.captures.map((item) => ({
            url: item.seed.url,
            slug: item.slug,
            title: item.capture.title,
            status: item.capture.status,
            screenshotPx: item.capture.screenshotPx,
          })),
          labeled: result.records.map((item) => item.path),
          doubles: result.doubles.map((item) => ({
            slug: item.slug,
            agreement: item.agreement,
          })),
          failures: result.failures,
        },
        null,
        2,
      ),
    );

    if (result.failures.length) process.exitCode = 1;
  }

  private static concurrencyFlag(value: string | boolean | undefined): number {
    if (value == null) return Pipeline.DEFAULT_CONCURRENCY;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new Error("--concurrency requires a positive integer, for example 4");
    }
    return Number(value);
  }

  private static modelFlag(value: string | boolean | undefined): string {
    if (value == null) return Labeler.DEFAULT_MODEL;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("--model requires a cursor-agent model id, for example grok-4.7");
    }
    return value.trim();
  }

  private static flags(args: string[]): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
      const token = args[i]!;
      if (!token.startsWith("--")) continue;
      const key = token.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
    return out;
  }

  private static help(): void {
    console.log(`UI → Design Pattern Atlas labeling pipeline

Usage:
  tsx src/cli.ts extract <atlas.html> [atlas/codebook.json]
  tsx src/cli.ts capture [--out output] [--limit N] [--url URL] [--delay MS] [--resume]
  tsx src/cli.ts run     [--out output] [--limit N] [--url URL] [--delay MS] [--double N] [--timeout MS] [--model ID] [--concurrency N] [--from-capture] [--resume]

Progress is written to stderr as each step finishes. --timeout is the per
cursor-agent call limit in milliseconds (default 600000 = 10 min); the child
is killed and the URL is recorded as a label failure. --model is passed to
every cursor-agent spawn (default grok-4.7). --concurrency is how many URLs
are captured and labeled at once (default 4). The delay applies per host, not
between different hosts. summary.json is rebuilt from every valid record and
double-label file in the output directory, plus failures from this run, and
includes the model id. --resume skips a <slug>.json or <slug>.b.json that
still validates (log: skip (done)) and reuses a valid <slug>.capture.json plus
PNG when the label is missing. Invalid files are redone. --from-capture labels
the saved capture and does not fetch the page again. Output names include the
query string and a hash of the full URL. A retry logs the full validation
error, including every zod path. Output files are written to a temp file in
the same directory, then renamed.

Daniel's local command for the full 72-seed set (+ 5 double-labels):
  tsx src/cli.ts run --out output --double 5

Auth: cursor-agent must be installed and logged in as Daniel, or CURSOR_API_KEY must be set.
`);
  }
}

Cli.main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

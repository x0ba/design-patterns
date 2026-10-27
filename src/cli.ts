import { resolve } from "node:path";
import { Atlas } from "./Atlas.ts";
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
      doubleLabel: captureOnly ? 0 : flags.double ? Number(flags.double) : 0,
      agentTimeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
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
  tsx src/cli.ts capture [--out output] [--limit N] [--url URL] [--delay MS]
  tsx src/cli.ts run     [--out output] [--limit N] [--url URL] [--delay MS] [--double N] [--timeout MS]

Progress is written to stderr as each step finishes. --timeout is the per
cursor-agent call limit in milliseconds (default 600000 = 10 min); the child
is killed and the URL is recorded as a label failure. summary.json is written
to the output directory.

Daniel's local command for the 20-record pilot (+ 5 double-labels):
  tsx src/cli.ts run --out output --double 5

Auth: cursor-agent must be installed and logged in as Daniel, or CURSOR_API_KEY must be set.
`);
  }
}

Cli.main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const AtlasVar = z.object({ name: z.string(), def: z.string() });
const AtlasSub = z.object({
  key: z.string(),
  name: z.string(),
  sel: z.enum(["one", "many"]),
  vars: z.array(AtlasVar),
});
const AtlasDim = z.object({
  name: z.string(),
  family: z.string(),
  q: z.string(),
  subs: z.array(AtlasSub),
});
const AtlasEntry = z.object({
  id: z.string(),
  name: z.string(),
  level: z.enum(["archetype", "pattern", "component"]),
  archetype: z.string(),
  aliases: z.array(z.string()),
  def: z.string(),
  dims: z.array(AtlasDim),
});
const AtlasCodebook = z.object({
  source: z.literal("atlas-json"),
  generatedAt: z.string().datetime(),
  entries: z.array(AtlasEntry),
});

export type AtlasVar = z.infer<typeof AtlasVar>;
export type AtlasSub = z.infer<typeof AtlasSub>;
export type AtlasDim = z.infer<typeof AtlasDim>;
export type AtlasEntry = z.infer<typeof AtlasEntry>;
export type AtlasCodebook = z.infer<typeof AtlasCodebook>;
export type SlimEntry = Pick<
  AtlasEntry,
  "id" | "name" | "level" | "archetype" | "aliases" | "def"
>;

const EXPECTED_COUNT = 119;
const ID_RE = /^[a-z0-9-]+$/;

export class Atlas {
  static readonly Var = AtlasVar;
  static readonly Sub = AtlasSub;
  static readonly Dim = AtlasDim;
  static readonly Entry = AtlasEntry;
  static readonly Codebook = AtlasCodebook;
  static readonly EXPECTED_COUNT = EXPECTED_COUNT;

  static defaultPath(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "atlas", "codebook.json");
  }

  static load(path = Atlas.defaultPath()): AtlasCodebook {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const codebook = Atlas.Codebook.parse(raw);
    Atlas.assertComplete(codebook);
    return codebook;
  }

  static ids(codebook: AtlasCodebook): string[] {
    return codebook.entries.map((entry) => entry.id);
  }

  static slim(codebook: AtlasCodebook): SlimEntry[] {
    return codebook.entries.map(({ id, name, level, archetype, aliases, def }) => ({
      id,
      name,
      level,
      archetype,
      aliases,
      def,
    }));
  }

  static dimsFor(codebook: AtlasCodebook, ids: string[]): AtlasEntry[] {
    const wanted = new Set(ids);
    return codebook.entries.filter((entry) => wanted.has(entry.id));
  }

  static byId(codebook: AtlasCodebook): Map<string, AtlasEntry> {
    return new Map(codebook.entries.map((entry) => [entry.id, entry]));
  }

  static extractFromHtml(html: string): AtlasCodebook {
    const match = html.match(
      /<script[^>]*id="atlas-json"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match?.[1]) {
      throw new Error("No #atlas-json script tag in HTML");
    }
    const dump = JSON.parse(match[1]) as {
      generatedAt?: unknown;
      entries?: unknown;
    };
    if (!Array.isArray(dump.entries)) {
      throw new Error("#atlas-json is missing entries[]");
    }
    const codebook: AtlasCodebook = {
      source: "atlas-json",
      generatedAt: String(dump.generatedAt),
      entries: dump.entries.map((raw) => Atlas.slimEntry(raw)),
    };
    return Atlas.Codebook.parse(codebook);
  }

  static write(codebook: AtlasCodebook, path = Atlas.defaultPath()): void {
    Atlas.assertComplete(codebook);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(codebook)}\n`);
  }

  static extractFile(htmlPath: string, outPath = Atlas.defaultPath()): AtlasCodebook {
    const resolved = isAbsolute(htmlPath) ? htmlPath : join(process.cwd(), htmlPath);
    const codebook = Atlas.extractFromHtml(readFileSync(resolved, "utf8"));
    Atlas.assertComplete(codebook);
    Atlas.write(codebook, outPath);
    return codebook;
  }

  private static slimEntry(raw: unknown): AtlasEntry {
    const entry = raw as Record<string, unknown>;
    return {
      id: String(entry.id),
      name: String(entry.name),
      level: entry.level as AtlasEntry["level"],
      archetype: String(entry.archetype),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
      def: String(entry.def ?? ""),
      dims: Array.isArray(entry.dims) ? entry.dims.map((dim) => Atlas.slimDim(dim)) : [],
    };
  }

  private static slimDim(raw: unknown): AtlasDim {
    const dim = raw as Record<string, unknown>;
    return {
      name: String(dim.name ?? ""),
      family: String(dim.family ?? ""),
      q: String(dim.q ?? ""),
      subs: Array.isArray(dim.subs) ? dim.subs.map((sub) => Atlas.slimSub(sub)) : [],
    };
  }

  private static slimSub(raw: unknown): AtlasSub {
    const sub = raw as Record<string, unknown>;
    return {
      key: String(sub.key ?? ""),
      name: String(sub.name ?? ""),
      sel: sub.sel === "many" ? "many" : "one",
      vars: Array.isArray(sub.vars) ? sub.vars.map((triple) => Atlas.slimVar(triple)) : [],
    };
  }

  private static slimVar(raw: unknown): AtlasVar {
    if (Array.isArray(raw)) {
      return { name: String(raw[0] ?? ""), def: String(raw[1] ?? "") };
    }
    const obj = raw as Record<string, unknown>;
    return { name: String(obj.name ?? ""), def: String(obj.def ?? "") };
  }

  private static assertComplete(codebook: AtlasCodebook): void {
    if (codebook.entries.length !== EXPECTED_COUNT) {
      throw new Error(
        `Codebook must have ${EXPECTED_COUNT} entries, got ${codebook.entries.length}`,
      );
    }
    const ids = codebook.entries.map((entry) => entry.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw new Error("Codebook ids are not unique");
    }
    const bad = ids.filter((id) => !ID_RE.test(id));
    if (bad.length) {
      throw new Error(`Illegal codebook ids: ${bad.join(", ")}`);
    }
  }
}

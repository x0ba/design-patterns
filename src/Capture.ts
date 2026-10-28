import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { chromium, type Page } from "playwright";
import { Output } from "./Output.ts";

const VIEWPORT_WIDTH = 1440;
const CLIP_CSS_PX = 8000;
export const DEFAULT_NAV_DELAY_MS = 2000;

export type CaptureResult = {
  url: string;
  capturedAt: string;
  finalUrl: string;
  status: number;
  title: string;
  viewport: { width: number; height: number };
  screenshotPx: { width: number; height: number };
  userAgent: string;
  screenshotPath: string;
  screenshotRef: string;
  ariaSnapshot: string;
  clipCssPx: number;
};

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export class Capture {
  static async fromUrl(
    url: string,
    opts: {
      screenshotPath: string;
      clipCssPx?: number;
      timeoutMs?: number;
    },
  ): Promise<CaptureResult> {
    await Capture.assertRobotsAllowed(url);
    mkdirSync(dirname(opts.screenshotPath), { recursive: true });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const clipCssPx = opts.clipCssPx ?? CLIP_CSS_PX;
    const timeout = opts.timeoutMs ?? 45_000;

    try {
      let status = 0;
      page.on("response", (response) => {
        if (response.url() === url || response.url() === page.url()) {
          status = response.status();
        }
      });

      try {
        const response = await page.goto(url, { waitUntil: "networkidle", timeout });
        if (response) status = response.status();
      } catch (error) {
        throw new CaptureError(
          `Navigation failed for ${url}: ${error instanceof Error ? error.message : error}`,
        );
      }

      if (status >= 400) {
        throw new CaptureError(`HTTP ${status} for ${url}`);
      }

      await page.evaluate("document.fonts.ready");
      const clipHeight = await Capture.clipPage(page, clipCssPx);
      const ariaSnapshot = await page.locator("body").ariaSnapshot();
      const buffer = await page.screenshot({
        fullPage: true,
        animations: "disabled",
      });
      Output.write(opts.screenshotPath, buffer);

      const png = Capture.pngSize(buffer);
      const userAgent = String(await page.evaluate("navigator.userAgent"));
      const capturedAt = new Date().toISOString();
      const screenshotRef = opts.screenshotPath;

      return {
        url,
        capturedAt,
        finalUrl: page.url(),
        status: status || 200,
        title: await page.title(),
        viewport: { width: VIEWPORT_WIDTH, height: 900 },
        screenshotPx: png,
        userAgent,
        screenshotPath: opts.screenshotPath,
        screenshotRef,
        ariaSnapshot,
        clipCssPx: clipHeight,
      };
    } finally {
      await context.close();
      await browser.close();
    }
  }

  static async assertRobotsAllowed(url: string): Promise<void> {
    const target = new URL(url);
    const robotsUrl = `${target.origin}/robots.txt`;
    let text = "";
    try {
      const response = await fetch(robotsUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "DesignPatternAtlasBot/0.1" },
      });
      if (response.status === 404) return;
      if (!response.ok) return;
      text = await response.text();
    } catch {
      return;
    }
    if (!Capture.robotsAllows(text, target.pathname + target.search)) {
      throw new CaptureError(`robots.txt disallows ${url}`);
    }
  }

  static robotsAllows(
    robotsTxt: string,
    path: string,
    agent = "designpatternatlasbot",
  ): boolean {
    const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
    let current: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | null =
      null;
    let seenBlank = true;

    for (const rawLine of robotsTxt.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) {
        seenBlank = true;
        continue;
      }
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (field === "user-agent") {
        if (seenBlank || !current || current.rules.length > 0) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        seenBlank = false;
      } else if ((field === "disallow" || field === "allow") && current) {
        current.rules.push({ allow: field === "allow", pattern: value });
        seenBlank = false;
      }
    }

    const product = agent.toLowerCase();
    const specific = groups.filter((group) => group.agents.includes(product));
    const applicable = specific.length
      ? specific
      : groups.filter((group) => group.agents.includes("*"));
    if (!applicable.length) return true;

    let best: { allow: boolean; length: number } | null = null;
    for (const group of applicable) {
      for (const rule of group.rules) {
        if (rule.pattern === "") continue;
        if (!Capture.pathMatches(rule.pattern, path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) {
          best = { allow: rule.allow, length };
        }
      }
    }
    return best ? best.allow : true;
  }

  static readSidecar(path: string): CaptureResult {
    let raw: Partial<CaptureResult>;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CaptureResult>;
    } catch (error) {
      throw new CaptureError(
        `Capture sidecar is unreadable: ${path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!raw.url || !raw.capturedAt || !raw.finalUrl || !raw.title || raw.ariaSnapshot == null) {
      throw new CaptureError(`Capture sidecar is missing required fields: ${path}`);
    }
    const screenshotPath = Capture.resolveScreenshot(path, raw);
    return {
      url: raw.url,
      capturedAt: raw.capturedAt,
      finalUrl: raw.finalUrl,
      status: raw.status ?? 0,
      title: raw.title,
      viewport: raw.viewport ?? { width: VIEWPORT_WIDTH, height: 900 },
      screenshotPx: raw.screenshotPx ?? { width: 0, height: 0 },
      userAgent: raw.userAgent ?? "",
      screenshotPath,
      screenshotRef: raw.screenshotRef ?? basename(screenshotPath),
      ariaSnapshot: raw.ariaSnapshot,
      clipCssPx: raw.clipCssPx ?? CLIP_CSS_PX,
    };
  }

  private static resolveScreenshot(sidecarPath: string, raw: Partial<CaptureResult>): string {
    if (raw.screenshotPath && existsSync(raw.screenshotPath)) return raw.screenshotPath;
    const ref = raw.screenshotRef ? basename(raw.screenshotRef) : "";
    const beside = ref ? join(dirname(sidecarPath), ref) : "";
    if (beside && existsSync(beside)) return beside;
    throw new CaptureError(`Capture screenshot missing for ${sidecarPath}`);
  }

  private static pathMatches(pattern: string, path: string): boolean {
    let body = pattern;
    let anchored = false;
    if (body.endsWith("$")) {
      anchored = true;
      body = body.slice(0, -1);
    }
    const escaped = body
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
  }

  static writeSidecar(result: CaptureResult, path: string): void {
    Output.write(
      path,
      `${JSON.stringify(
        {
          url: result.url,
          capturedAt: result.capturedAt,
          finalUrl: result.finalUrl,
          status: result.status,
          title: result.title,
          viewport: result.viewport,
          screenshotPx: result.screenshotPx,
          userAgent: result.userAgent,
          screenshotRef: result.screenshotRef,
          screenshotPath: result.screenshotPath,
          ariaSnapshot: result.ariaSnapshot,
          clipCssPx: result.clipCssPx,
        },
        null,
        2,
      )}\n`,
    );
  }

  private static async clipPage(page: Page, maxCssPx: number): Promise<number> {
    // String scripts: tsx/esbuild injects __name into function expressions, which
    // Playwright then serializes into the page and blows up.
    const measured = Number(
      await page.evaluate(
        `(() => Math.max(document.documentElement.scrollHeight, document.body && document.body.scrollHeight || 0, 1))()`,
      ),
    );
    const clipHeight = Math.max(1, Math.min(measured, maxCssPx));
    await page.evaluate(
      `(height) => {
        const hide = (root) => {
          for (const child of [...root.children]) {
            const top = child.getBoundingClientRect().top + window.scrollY;
            if (top >= height) child.style.display = "none";
            else hide(child);
          }
        };
        hide(document.body);
        document.documentElement.style.maxHeight = height + "px";
        document.documentElement.style.overflow = "hidden";
      }`,
      clipHeight,
    );
    return clipHeight;
  }

  private static pngSize(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
      throw new CaptureError("Screenshot was not a PNG");
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
}

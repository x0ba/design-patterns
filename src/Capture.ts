import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Page } from "playwright";

export const VIEWPORT_WIDTH = 1440;
export const CLIP_CSS_PX = 8000;
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

type ClipNode = {
  children: Iterable<ClipNode>;
  getBoundingClientRect: () => { top: number };
  style: { display: string };
};

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export class Capture {
  static readonly VIEWPORT_WIDTH = VIEWPORT_WIDTH;
  static readonly CLIP_CSS_PX = CLIP_CSS_PX;
  static readonly DEFAULT_NAV_DELAY_MS = DEFAULT_NAV_DELAY_MS;

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
        if (page.url() === "about:blank") {
          throw new CaptureError(
            `Navigation failed for ${url}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      if (status >= 400) {
        throw new CaptureError(`HTTP ${status} for ${url}`);
      }

      const clipHeight = await Capture.clipPage(page, clipCssPx);
      const ariaSnapshot = await page.locator("body").ariaSnapshot();
      const buffer = await page.screenshot({
        path: opts.screenshotPath,
        fullPage: true,
        animations: "disabled",
      });

      const png = Capture.pngSize(buffer);
      const userAgent = await page.evaluate(() => navigator.userAgent);
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

  static robotsAllows(robotsTxt: string, path: string): boolean {
    const groups: { agents: string[]; rules: { allow: boolean; prefix: string }[] }[] = [];
    let current: { agents: string[]; rules: { allow: boolean; prefix: string }[] } | null =
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
        if (seenBlank || !current) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        seenBlank = false;
      } else if ((field === "disallow" || field === "allow") && current) {
        current.rules.push({ allow: field === "allow", prefix: value });
        seenBlank = false;
      }
    }

    const applicable = groups.filter((group) =>
      group.agents.some((agent) => agent === "*" || agent === "designpatternatlasbot"),
    );
    if (!applicable.length) return true;

    let best: { allow: boolean; length: number } | null = null;
    for (const group of applicable) {
      for (const rule of group.rules) {
        if (rule.prefix === "") continue;
        if (!path.startsWith(rule.prefix) && rule.prefix !== "/") continue;
        const length = rule.prefix.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) {
          best = { allow: rule.allow, length };
        }
      }
    }
    return best ? best.allow : true;
  }

  static writeSidecar(result: CaptureResult, path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
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
    const measured = await page.evaluate(() => {
      const g = globalThis as unknown as {
        document: {
          documentElement: { scrollHeight: number };
          body?: { scrollHeight: number };
        };
      };
      const doc = g.document.documentElement;
      return Math.max(doc.scrollHeight, g.document.body?.scrollHeight ?? 0, 1);
    });
    const clipHeight = Math.max(1, Math.min(measured, maxCssPx));
    await page.evaluate((height) => {
      const g = globalThis as unknown as {
        document: {
          documentElement: { style: { maxHeight: string; overflow: string } };
          body: ClipNode;
        };
        window: { scrollY: number };
      };
      const hide = (root: ClipNode) => {
        for (const child of [...root.children]) {
          const top = child.getBoundingClientRect().top + g.window.scrollY;
          if (top >= height) child.style.display = "none";
          else hide(child);
        }
      };
      hide(g.document.body);
      g.document.documentElement.style.maxHeight = `${height}px`;
      g.document.documentElement.style.overflow = "hidden";
    }, clipHeight);
    return clipHeight;
  }

  private static pngSize(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
      throw new CaptureError("Screenshot was not a PNG");
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
}

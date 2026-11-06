import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Capture, CaptureError } from "../src/Capture.ts";

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ close: () => void; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind"));
        return;
      }
      resolve({
        port: address.port,
        hits,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

describe("Capture.robotsAllows", () => {
  const robots = `User-agent: *
Disallow: /secret
Allow: /secret/public
`;

  it("honors the longest matching Allow/Disallow", () => {
    assert.equal(Capture.robotsAllows(robots, "/secret"), false);
    assert.equal(Capture.robotsAllows(robots, "/secret/public"), true);
    assert.equal(Capture.robotsAllows(robots, "/ok"), true);
  });

  it("allows when no matching group exists", () => {
    assert.equal(Capture.robotsAllows("User-agent: googlebot\nDisallow: /\n", "/"), true);
  });

  it("treats * and $ as wildcards", () => {
    const wildcard = "User-agent: *\nDisallow: /private/*\n";
    assert.equal(Capture.robotsAllows(wildcard, "/private/report"), false);
    assert.equal(Capture.robotsAllows(wildcard, "/ok"), true);
    assert.equal(Capture.robotsAllows("User-agent: *\nDisallow: /page$\n", "/page"), false);
    assert.equal(Capture.robotsAllows("User-agent: *\nDisallow: /page$\n", "/page/more"), true);
  });

  it("starts a new group when the next user-agent has no blank line", () => {
    const merged = "User-agent: *\nDisallow: /\nUser-agent: googlebot\nAllow: /\n";
    assert.equal(Capture.robotsAllows(merged, "/"), false);
    assert.equal(Capture.robotsAllows(merged, "/private/report"), false);
  });

  it("uses a specific product group instead of merging it with *", () => {
    const specific = "User-agent: *\nDisallow: /secret\nUser-agent: designpatternatlasbot\nAllow: /\n";
    assert.equal(Capture.robotsAllows(specific, "/secret"), true);
  });

  it("treats each star as its own wildcard", () => {
    const robots = "User-agent: *\nDisallow: /a*b*c\n";
    assert.equal(Capture.robotsAllows(robots, "/aXbYc"), false);
    assert.equal(Capture.robotsAllows(robots, "/aXbYc/extra"), false);
    assert.equal(Capture.robotsAllows(robots, "/aXc"), true);
    assert.equal(Capture.robotsAllows("User-agent: *\nDisallow: /a*b$\n", "/aXb"), false);
    assert.equal(Capture.robotsAllows("User-agent: *\nDisallow: /a*b$\n", "/aXbY"), true);
  });

  it("finishes nested star rules without backtracking", () => {
    const nested = `/${"*a".repeat(24)}!`;
    const robots = `User-agent: *\nDisallow: ${nested}\n`;
    const started = Date.now();
    assert.equal(Capture.robotsAllows(robots, `/${"a".repeat(80)}`), true);
    assert.equal(Capture.robotsAllows(robots, `/${"a".repeat(24)}!`), false);
    assert.ok(Date.now() - started < 200, `wildcard match took ${Date.now() - started}ms`);
  });

  it("does not let an oversized Allow grant access to a blocked path", async () => {
    const allow = `/public${"a".repeat(3000)}`;
    const path = `/private?${"b".repeat(3000)}`;
    const robots = `User-agent: *\nDisallow: /\nAllow: ${allow}\n`;
    assert.equal(Capture.robotsAllows(robots, path), false);

    const prefixedAllow = `/*${"a".repeat(3000)}`;
    const prefixedPath = `/${"b".repeat(3000)}`;
    assert.equal(
      Capture.robotsAllows(`User-agent: *\nDisallow: /\nAllow: ${prefixedAllow}\n`, prefixedPath),
      false,
    );
    assert.equal(
      Capture.robotsAllows(`User-agent: *\nDisallow: ${prefixedAllow}\n`, prefixedPath),
      false,
    );
    const matchedAllow = `/private${"a".repeat(3000)}`;
    assert.equal(
      Capture.robotsAllows(
        `User-agent: *\nDisallow: /\nAllow: ${matchedAllow}\n`,
        `${matchedAllow}/x`,
      ),
      true,
    );
    assert.equal(
      Capture.robotsAllows(`User-agent: *\nDisallow: /zzzz${"a".repeat(3000)}\n`, path),
      true,
    );

    const site = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(robots);
    });
    try {
      await assert.rejects(
        () => Capture.assertRobotsAllowed(`http://127.0.0.1:${site.port}${path}`),
        (error: unknown) => error instanceof CaptureError && /robots.txt disallows/.test(error.message),
      );
    } finally {
      site.close();
    }
  });

  it("matches many nonmatching literal rules without stalling other work", async () => {
    const rules = Array.from({ length: 1000 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return `Disallow: /private${"a".repeat(189)}${suffix}`;
    });
    const robots = `User-agent: *\n${rules.join("\n")}\n`;
    const path = `/private?${"b".repeat(1991)}`;
    let timerDelayMs = 0;
    const pending = new Promise<void>((resolve) => {
      const marked = performance.now();
      setTimeout(() => {
        timerDelayMs = performance.now() - marked;
        resolve();
      }, 0);
    });
    const started = performance.now();
    const allowed = Capture.robotsAllows(robots, path);
    const elapsedMs = performance.now() - started;
    await pending;
    assert.equal(allowed, true);
    assert.equal(Capture.robotsAllows(`${robots}Disallow: /\n`, path), false);
    assert.ok(elapsedMs < 200, `nonmatching rules blocked for ${elapsedMs}ms`);
    assert.ok(timerDelayMs < 200, `a pending timer waited ${timerDelayMs}ms`);
  });
});

describe("Capture.fromUrl", () => {
  it("rejects a page that serves HTML but never reaches network idle", { timeout: 60_000 }, async () => {
    const site = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/hang") return;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Loading</title><p>loading</p><img src='/hang'>");
    });
    const dir = mkdtempSync(join(tmpdir(), "atlas-hang-"));
    const screenshot = join(dir, "shot.png");
    try {
      await assert.rejects(
        () =>
          Capture.fromUrl(`http://127.0.0.1:${site.port}/`, {
            screenshotPath: screenshot,
            timeoutMs: 2000,
          }),
        (error: unknown) =>
          error instanceof CaptureError &&
          /Navigation failed/.test(error.message) &&
          /Timeout/.test(error.message),
      );
      assert.equal(existsSync(screenshot), false);
    } finally {
      site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a local page once network idle is reached", { timeout: 60_000 }, async () => {
    const site = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Ready</title><p>ready</p>");
    });
    const dir = mkdtempSync(join(tmpdir(), "atlas-ready-"));
    try {
      const result = await Capture.fromUrl(`http://127.0.0.1:${site.port}/`, {
        screenshotPath: join(dir, "shot.png"),
        timeoutMs: 15_000,
      });
      assert.equal(result.status, 200);
      assert.equal(result.title, "Ready");
      assert.equal(existsSync(join(dir, "shot.png")), true);
    } finally {
      site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a robots-prohibited page before capturing it", { timeout: 30_000 }, async () => {
    const cases = [
      "User-agent: *\nDisallow: /private/*\n",
      "User-agent: *\nDisallow: /\nUser-agent: googlebot\nAllow: /\n",
    ];
    for (const robots of cases) {
      const site = await listen((req, res) => {
        if (req.url === "/robots.txt") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(robots);
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Secret</title><p>prohibited</p>");
      });
      const dir = mkdtempSync(join(tmpdir(), "atlas-robots-"));
      try {
        await assert.rejects(
          () =>
            Capture.fromUrl(`http://127.0.0.1:${site.port}/private/report`, {
              screenshotPath: join(dir, "shot.png"),
              timeoutMs: 10_000,
            }),
          (error: unknown) => error instanceof CaptureError && /robots.txt disallows/.test(error.message),
        );
        assert.deepEqual(site.hits, ["/robots.txt"]);
        assert.equal(existsSync(join(dir, "shot.png")), false);
      } finally {
        site.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

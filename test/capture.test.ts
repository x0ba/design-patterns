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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Capture } from "../src/Capture.ts";

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
});

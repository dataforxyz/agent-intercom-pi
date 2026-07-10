import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("published package includes presentation assets and excludes tests", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  const paths = pack.files.map(file => file.path);

  assert.ok(paths.includes("banner.png"));
  assert.ok(paths.includes("broker/broker.ts"));
  assert.ok(paths.includes("inbound-inbox.ts"));
  assert.ok(paths.includes("outbound-outbox.ts"));
  assert.ok(paths.includes("durable-json.ts"));
  assert.equal(paths.some(path => path.endsWith(".test.ts")), false);
});

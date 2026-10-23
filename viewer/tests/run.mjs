import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const viewer = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = join(dirname(viewer), ".cache");
const stem = `monitoring-e2e-${randomUUID()}`;
const database = join(cache, `${stem}.sqlite3`);
const require = createRequire(import.meta.url);

// Global-setup teardown precedes web-server teardown. Cleanup belongs after the CLI exits.
const result = spawnSync(process.execPath, [
  require.resolve("@playwright/test/cli"), "test", ...process.argv.slice(2),
], {
  cwd: viewer, stdio: "inherit",
  env: { ...process.env, PARKING_TEST_DATABASE: database },
});
if (result.error) throw result.error;
if (result.status === null) {
  console.error("Browser runner was interrupted; its isolated files were kept rather than deleting a live database.");
  process.exitCode = 1;
} else {
  for (const suffix of [".sqlite3", ".sqlite3-wal", ".sqlite3-shm", ".sqlite3-journal", "-timestamp.mp4"]) {
    rmSync(join(cache, `${stem}${suffix}`), { force: true });
  }
  rmSync(join(cache, `${stem}-media`), { recursive: true, force: true });
  process.exitCode = result.status;
}

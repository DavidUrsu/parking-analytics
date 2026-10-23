import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const database = process.env.PARKING_TEST_DATABASE
  ?? join(repository, ".cache", `monitoring-e2e-${randomUUID()}.sqlite3`);
process.env.PARKING_TEST_DATABASE = database;
process.env.PARKING_TEST_METADATA_VIDEO = database.replace(/\.sqlite3$/, "-timestamp.mp4");

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: "line",
  globalSetup: fileURLToPath(new URL("./tests/setup.ts", import.meta.url)),
  use: {
    browserName: "chromium",
    channel: "msedge",
    headless: true,
    baseURL: "http://127.0.0.1:4175",
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `uv run --directory "${repository}" --no-sync parking serve --database "${database}" --port 4176 --frontend-origin http://127.0.0.1:4175`,
      url: "http://127.0.0.1:4176/api/health",
      env: {
        UV_CACHE_DIR: join(repository, ".cache", "uv"),
        UV_PYTHON_INSTALL_DIR: join(repository, ".cache", "python"),
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --port 4175 --strictPort",
      url: "http://127.0.0.1:4175",
      env: { PARKING_API_URL: "http://127.0.0.1:4176" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

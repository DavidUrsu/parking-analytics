import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisResponse } from "../src/analysis-types";

const fixture = fileURLToPath(new URL("../public/test-fixture/media/fixture.mp4", import.meta.url));

async function validated(page: Page, value: unknown): Promise<AnalysisResponse> {
  return page.evaluate(async (payload) => {
    const moduleURL = "/src/analysis-client.ts";
    const client: typeof import("../src/analysis-client") = await import(moduleURL);
    return client.parseAnalysis(payload);
  }, value);
}

async function importFixture(page: Page, path = fixture): Promise<string> {
  await page.goto("/?mode=analysis");
  await expect(page.locator("#analysis-limits")).toContainText("512 MiB");
  await page.locator("#video-file").setInputFiles(path);
  await page.locator("#content-kind").selectOption("synthetic_test");
  await page.locator("#upload-permission").check();
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/analysis/videos" && response.request().method() === "POST");
  await page.locator("#upload-button").click();
  const response = await pending;
  expect(response.ok(), `Upload HTTP ${response.status()}`).toBeTruthy();
  await expect(page.locator("#analysis-video")).toHaveValue(/^[0-9a-f]{32}$/);
  const id = await page.locator("#analysis-video").inputValue();
  const stored = await page.request.get("/api/analysis/videos");
  const result = await validated(page, await stored.json());
  if (result.kind !== "analysis_videos" || !result.videos.some((video) => video.id === id)) {
    throw new Error("Imported recording was not persisted");
  }
  await expect(page.locator("#geometry-canvas")).toHaveAttribute("width", "400");
  return id;
}

async function drawGeometry(page: Page): Promise<void> {
  await page.locator("#whole-frame").click();
  await page.locator("#geometry-tool").selectOption("gate");
  const canvas = page.locator("#geometry-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Missing visible camera geometry");
  await canvas.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.1 } });
  await canvas.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.9 } });
  await page.locator("#geometry-finish").click();
  await expect(page.locator("#geometry-shapes li")).toHaveCount(2);
  await expect(page.locator("#operations-error")).toBeHidden();
}

async function queuedJob(page: Page, name: string): Promise<string> {
  await drawGeometry(page);
  await page.locator("#recording-start").fill("2026-01-15T10:00:00+02:00");
  await page.locator("#realtime-confirmed").check();
  await page.locator("#fixed-confirmed").check();
  await page.locator("#analysis-name").fill(name);
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/analysis/jobs" && response.request().method() === "POST");
  await page.locator("#run-analysis").click();
  expect((await pending).ok()).toBe(true);
  const response = await page.request.get("/api/analysis/jobs");
  const payload = await validated(page, await response.json());
  const job = payload.kind === "analysis_jobs" ? payload.jobs.find((item) => item.name === name) : undefined;
  if (!job) throw new Error("Queued job was not persisted");
  return job.id;
}

async function requireModel(page: Page): Promise<void> {
  const response = await page.request.get("/api/analysis/capabilities");
  const capabilities = await validated(page, await response.json());
  if (capabilities.kind !== "analysis_capabilities") throw new Error("Missing capabilities");
  test.skip(!capabilities.model_files_present || !capabilities.inference_packages_present,
    "Cached model/inference extras absent. No fabricated results.");
}

test("drag/drop requires authorization and never guesses a recording clock", async ({ page }) => {
  await page.goto("/?mode=analysis");
  await expect(page.locator("#recording-start")).toBeDisabled();
  await page.locator("#video-file").setInputFiles({
    name: "invalid.mp4", mimeType: "video/mp4", buffer: Buffer.from("not a video"),
  });
  let uploads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/analysis/videos" && request.method() === "POST") uploads++;
  });
  await page.locator("#upload-button").click();
  expect(uploads).toBe(0);
  await page.locator("#upload-permission").check();
  await page.locator("#upload-button").click();
  await expect(page.locator("#operations-error")).toContainText("not a playlist");
  const bytes = Array.from(await readFile(fixture));
  const transfer = await page.evaluateHandle((content) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(content)], "synthetic-dropped.mp4", { type: "video/mp4", lastModified: Date.now() }));
    return data;
  }, bytes);
  await page.locator("#video-drop").dispatchEvent("drop", { dataTransfer: transfer });
  await page.locator("#content-kind").selectOption("synthetic_test");
  await page.locator("#upload-button").click();
  await expect(page.locator("#selected-video")).toBeVisible();
  await expect(page.locator("#timestamp-status")).toContainText("No usable");
  await expect(page.locator("#recording-start")).toHaveValue("");
  await expect(page.locator("#realtime-confirmed")).not.toBeChecked();
  await expect(page.locator("#fixed-confirmed")).not.toBeChecked();
  await expect(page.locator("#use-timestamp")).toBeDisabled();
  expect(page.url()).not.toContain("synthetic-dropped");
});

test("metadata is only a candidate and visual geometry persists as a camera preset", async ({ page }) => {
  const stamped = process.env.PARKING_TEST_METADATA_VIDEO;
  if (!stamped) throw new Error("Timestamp fixture was not prepared");
  const videoId = await importFixture(page, stamped);
  await expect(page.locator("#timestamp-candidate")).toContainText("2026-01-15T08:00:00");
  await expect(page.locator("#recording-start")).toHaveValue("");
  await page.locator("#use-timestamp").click();
  await expect(page.locator("#recording-start")).toHaveValue("2026-01-15T08:00:00Z");
  await expect(page.locator("#clock-source")).toHaveValue("metadata_confirmed");
  await expect(page.locator("#realtime-confirmed")).not.toBeChecked();
  await drawGeometry(page);
  const json = page.locator("#geometry-json");
  await expect(json).toHaveValue(/"inward_side": 1/);
  await page.locator("#geometry-shapes").getByRole("button", { name: "Flip entering side" }).click();
  await expect(json).toHaveValue(/"inward_side": -1/);
  await page.locator("#preset-name").fill("Synthetic fixed-camera browser check");
  await page.locator("#save-preset").click();
  await expect(page.locator("#camera-presets")).toContainText("Synthetic fixed-camera browser check");
  await page.reload();
  await expect(page.locator("#analysis-video")).toContainText("timestamp.mp4");
  await page.locator("#analysis-video").selectOption(videoId);
  await page.locator("#camera-presets").selectOption({ label: "Synthetic fixed-camera browser check (400x240)" });
  await page.locator("#apply-preset").click();
  await expect(page.locator("#geometry-shapes li")).toHaveCount(2);
  await expect(json).toHaveValue(/"inward_side": -1/);
  await expect(page.locator("#recording-start")).toHaveValue("");
  await expect(page.locator("#fixed-confirmed")).not.toBeChecked();
});

test("analysis controls fit mobile and keep Romanian navigation and keyboard geometry", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importFixture(page);
  await page.locator("#language").selectOption("ro");
  await expect(page.locator("h1")).toHaveText("Analizeaza si verifica filmarea");
  await expect(page.locator("#selected-file")).toContainText("Fisier selectat");
  await expect(page.locator("#mode-navigation a[data-mode=analysis]")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#recording-start")).toHaveValue("");
  await drawGeometry(page);
  const editor = page.locator("#geometry-json");
  await editor.locator("..").evaluate((node) => { if (node instanceof HTMLDetailsElement) node.open = true; });
  const raw: unknown = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify(raw, null, 2));
  await page.locator("#apply-geometry").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#operations-error")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("analysis-mobile-ro.png"), fullPage: true });
});

test("cancelling a real submitted job keeps its input but never offers partial replay", async ({ page }) => {
  const videoId = await importFixture(page);
  await requireModel(page);
  const id = await queuedJob(page, "Synthetic cancellation check");
  const card = page.locator(`[data-job="${id}"]`);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.locator(".job-status")).toContainText("Cancelled", { timeout: 15_000 });
  await expect(card.getByRole("link", { name: "Review synchronized results" })).toHaveCount(0);
  const response = await page.request.get(`/api/analysis/jobs/${id}/bundle`);
  expect(response.status()).toBe(409);
  expect((await page.request.get(`/api/analysis/videos/${videoId}/preview`)).ok()).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-video").click();
  await expect(page.locator("#selected-video")).toBeHidden();
  expect((await page.request.get(`/api/analysis/videos/${videoId}/preview`)).status()).toBe(404);
});

test("a damaged private input fails visibly instead of producing fallback results", async ({ page }) => {
  const videoId = await importFixture(page);
  await requireModel(page);
  const database = process.env.PARKING_TEST_DATABASE;
  if (!database || !/monitoring-e2e-[a-f0-9-]+\.sqlite3$/.test(database)) throw new Error("Unsafe test database");
  const media = database.replace(/\.sqlite3$/, "-media");
  await writeFile(join(media, "videos", videoId, "source.bin"), "controlled damaged synthetic input");
  const id = await queuedJob(page, "Synthetic damaged-input check");
  const card = page.locator(`[data-job="${id}"]`);
  await expect(card.locator(".job-status")).toContainText("Failed", { timeout: 20_000 });
  await expect(card.locator(".job-error")).toBeVisible();
  await expect(card.locator(".job-error")).toContainText("Analysis failed");
  await expect(card.locator("a")).toHaveCount(0);
  expect((await page.request.get(`/api/analysis/jobs/${id}/result.json`)).status()).toBe(409);
});

test("a real bounded detector job creates private replay with offset-aware recording times", async ({ page }, info) => {
  test.setTimeout(180_000);
  await importFixture(page);
  const capabilities = await page.request.get("/api/analysis/capabilities");
  const ready = await validated(page, await capabilities.json());
  if (ready.kind !== "analysis_capabilities") throw new Error("Missing inference capabilities");
  test.skip(!ready.model_files_present || !ready.inference_packages_present,
    "Cached pinned model/inference dependencies absent. No fake-success replacement.");
  await drawGeometry(page);
  await page.locator("#recording-start").fill("2026-01-15T10:00:00");
  await page.locator("#realtime-confirmed").check();
  await page.locator("#fixed-confirmed").check();
  await page.locator("#run-analysis").click();
  await expect(page.locator("#operations-error")).toContainText("ISO-8601 with timezone");
  await page.locator("#recording-start").fill("2026-01-15T10:00:00+02:00");
  await page.locator("#analysis-name").fill("Explicit synthetic input, real CPU inference");
  await page.locator("#analysis-device").selectOption("cpu");
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/analysis/jobs" && response.request().method() === "POST");
  await page.locator("#run-analysis").click();
  const response = await pending;
  expect(response.ok(), `Queue HTTP ${response.status()}`).toBeTruthy();
  const stored = await page.request.get("/api/analysis/jobs");
  const jobs = await validated(page, await stored.json());
  const job = jobs.kind === "analysis_jobs"
    ? jobs.jobs.find((item) => item.name === "Explicit synthetic input, real CPU inference") : undefined;
  if (!job) throw new Error("Expected actual persisted analysis job");
  const id = job.id;
  try {
    expect(job.clock.start_utc).toBe("2026-01-15T08:00:00Z");
    expect(job.clock.original_start).toBe("2026-01-15T10:00:00+02:00");
    expect(job.clock.independently_verified).toBe(false);
    await expect.poll(async () => {
      const current = await page.request.get(`/api/analysis/jobs/${id}`);
      const status = await validated(page, await current.json());
      if (status.kind !== "analysis_job") throw new Error("Missing job");
      if (status.job.status === "failed") throw new Error(status.job.error ?? "Inference failed");
      return status.job.status;
    }, { timeout: 145_000, intervals: [1000, 2000] }).toBe("succeeded");
    const card = page.locator(`[data-job="${id}"]`);
    await expect(card.locator(".job-status")).toContainText("Ready");
    await expect(card.locator(".job-clock")).toContainText("2026-01-15T08:00:00Z");
    const download = page.waitForEvent("download");
    await card.getByRole("link", { name: "Private results JSON" }).click();
    const file = await (await download).path();
    if (!file) throw new Error("Missing private JSON download");
    const exported: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(exported).toHaveProperty("recording_clock.start_utc", "2026-01-15T08:00:00Z");
    expect(exported).toHaveProperty("bundle.synthetic", true);
    expect(exported).toHaveProperty("bundle.run.device", "cpu");
    await page.screenshot({ path: info.outputPath("analysis-job-real-cpu.png"), fullPage: true });
    const checked = page.waitForRequest((request) =>
      request.method() === "HEAD" && new URL(request.url()).pathname === `/api/analysis/jobs/${id}/media/recording.mp4`);
    await card.getByRole("link", { name: "Review synchronized results" }).click();
    await checked;
    await expect(page.locator("#play")).toBeEnabled();
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator("#media-status")).toContainText("Local server verified");
    await expect(page.locator("#recording-utc")).toContainText("2026-01-15T08:00:00.000Z");
    await expect(page.locator("#review-status")).toContainText("NO GROUND TRUTH");
    await expect(page.locator("#reference-panel")).toBeHidden();
    await page.locator("#review-speed").selectOption("0.25");
    await page.locator("#seek").evaluate((node) => {
      if (!(node instanceof HTMLInputElement)) throw new Error("Missing native timeline");
      node.value = "1"; node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator("#recording-utc")).toContainText("2026-01-15T08:00:01.000Z");
    await page.locator("#next-sample").click();
    await expect(page.locator("#recording-utc")).toContainText("2026-01-15T08:00:01.200Z");
    expect(await page.locator("#video").evaluate((node) =>
      node instanceof HTMLVideoElement && node.src.startsWith(location.origin + "/api/analysis/"))).toBe(true);
    await page.screenshot({ path: info.outputPath("private-recording-review.png"), fullPage: true });
  } finally {
    await page.request.post(`/api/analysis/jobs/${id}/cancel`, { data: {} });
    await expect.poll(async () => {
      const current = await page.request.get(`/api/analysis/jobs/${id}`);
      const status = await validated(page, await current.json());
      return status.kind === "analysis_job" && ["cancelled", "succeeded", "failed"].includes(status.job.status);
    }, { timeout: 10_000 }).toBe(true);
  }
});

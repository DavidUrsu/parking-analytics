import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AnalysisJob } from "../src/analysis-types";
import type { Bundle } from "../src/types";

const STORAGE_KEY = "parking.camera-wall.v1";
const fixtureURL = new URL("../public/test-fixture/bundle.json", import.meta.url);
const fixtureMediaURL = new URL("../public/test-fixture/media/fixture.mp4", import.meta.url);

async function fixtureBundle(): Promise<Bundle> {
  const bundle: Bundle = JSON.parse(await readFile(fixtureURL, "utf8"));
  const original = bundle.clips[0];
  if (!original) throw new Error("Missing synthetic replay fixture");
  bundle.reference = null; bundle.evaluation = null;
  bundle.clips = ["first", "second", "third"].map((id, index) => ({
    ...structuredClone(original), id,
    name: { en: `Synthetic recording ${index + 1}`, ro: `Filmarea sintetica ${index + 1}` },
    video: "media/fixture.mp4",
  }));
  return bundle;
}

async function mockWall(page: Page, bundle?: Bundle): Promise<Bundle> {
  const data = bundle ?? await fixtureBundle();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route((url) => url.pathname === "/demo/bundle.json", (route) => route.fulfill({ json: data }));
  const media = await readFile(fixtureMediaURL);
  await page.route((url) => url.pathname === "/demo/media/fixture.mp4", (route) =>
    route.fulfill({ body: media, contentType: "video/mp4" }));
  return data;
}

async function loadWall(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#camera-grid .camera-tile")).toHaveCount(4);
  await expect(page.locator("#wall-load-error")).toBeHidden();
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
}

async function seekTile(page: Page, slot: number, at: number): Promise<void> {
  const video = page.locator(`[data-slot="${slot}"] video`);
  await page.locator(`[data-slot="${slot}"] input[type="range"]`).evaluate((node, value) => {
    if (!(node instanceof HTMLInputElement)) throw new Error("Missing camera timeline");
    node.value = String(value); node.dispatchEvent(new Event("input", { bubbles: true }));
  }, at);
  await expect.poll(() => video.evaluate((node) =>
    node instanceof HTMLVideoElement && !node.seeking)).toBe(true);
}

test("the homepage is a recorded camera wall with selectable, remembered layouts and sources", async ({ page }) => {
  let privateRequests = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/analysis/")) privateRequests++; });
  await mockWall(page);
  await loadWall(page);
  await expect(page.locator("h1")).toHaveText("Camera overview");
  await expect(page.locator("#mode-navigation a")).toHaveCount(5);
  await expect(page.locator('[data-mode="dashboard"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#dashboard-tools a")).toHaveCount(4);
  await expect(page.locator(".recorded-note")).toContainText("not a live feed");
  await expect(page.locator('[data-slot="0"] .camera-badge')).toHaveText("Synthetic test");
  await expect(page.locator('[data-slot="3"]')).toHaveAttribute("data-state", "noCamera");
  await page.getByRole("button", { name: "3 x 3 grid", exact: true }).click();
  await expect(page.locator(".camera-tile")).toHaveCount(9);
  await page.locator("#wall-camera-8").selectOption("demo:third");
  await expect(page.locator('[data-slot="8"]')).toHaveAttribute("data-state", "paused");
  await page.getByRole("button", { name: "Single view", exact: true }).click();
  await expect(page.locator(".camera-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "3 x 3 grid", exact: true }).click();
  await expect(page.locator("#wall-camera-8")).toHaveValue("demo:third");
  await page.reload();
  await expect(page.locator("#camera-grid")).toHaveAttribute("data-layout", "9");
  await expect(page.locator("#wall-camera-8")).toHaveValue("demo:third");
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), STORAGE_KEY);
  expect(saved.layout).toBe(9);
  expect(saved.slots.slice(0, 3)).toEqual(["demo:first", "demo:second", "demo:third"]);
  expect(privateRequests).toBe(0);
});

test("wall observations follow each clip's timeline, playback and rewind without inventing capacity", async ({ page }) => {
  await mockWall(page); await loadWall(page);
  await seekTile(page, 0, 2);
  await expect(page.locator('[data-slot="0"] [data-reading="zone"]')).toHaveText("1");
  await expect(page.locator('[data-slot="0"] [data-reading="wall:in"]')).toHaveText("1");
  await expect(page.locator('[data-slot="0"] [data-reading="wall:out"]')).toHaveText("0");
  const pixels = await page.locator('[data-slot="0"] canvas').evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Missing tile overlay");
    return node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data.some((value, index) => index % 4 === 3 && value > 0);
  });
  expect(pixels).toBe(true);
  await page.locator(".wall-options summary").click();
  await page.locator("#wall-overlays").uncheck();
  const cleared = await page.locator('[data-slot="0"] canvas').evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Missing tile overlay");
    return node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data.every((value) => value === 0);
  });
  expect(cleared).toBe(true);
  await seekTile(page, 0, 0.4);
  await expect(page.locator('[data-slot="0"] [data-reading="zone"]')).toHaveText("0");
  await expect(page.locator('[data-slot="0"] [data-reading="wall:in"]')).toHaveText("0");
  await page.locator("#wall-play").click();
  await expect.poll(() => page.locator('[data-slot="0"] video').evaluate((node) =>
    node instanceof HTMLVideoElement && !node.paused)).toBe(true);
  await page.locator("#wall-pause").click();
  await expect.poll(() => page.locator('#camera-grid video').evaluateAll((nodes) =>
    nodes.every((node) => node instanceof HTMLVideoElement && node.paused))).toBe(true);
  await expect(page.locator(".wall-model-note")).toContainText("not free parking spaces");
});

test("camera detail opens the selected recording and current time inside the same dashboard shell", async ({ page }) => {
  await mockWall(page); await loadWall(page);
  await page.locator("#wall-camera-0").selectOption("demo:third");
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
  await seekTile(page, 0, 2);
  await page.locator('[data-slot="0"]').getByRole("link", { name: "Open detailed review" }).click();
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#clips")).toHaveValue("third");
  await expect(page.locator("#seek")).toHaveValue("2");
  await expect(page.locator("#observed")).toHaveText("1");
  await expect(page.locator("#workspace-sidebar")).toBeVisible();
  await expect(page.locator('[data-mode="analysis"]')).toHaveAttribute("aria-current", "page");
  await page.locator('[data-mode="dashboard"]').click();
  await expect(page.locator("#wall-camera-0")).toHaveValue("demo:third");
});

test("missing footage and corrupt saved layouts are explicit, not replaced with fake feeds", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{"layout":9,"slots":["private:not-authorized"]}'), STORAGE_KEY);
  await page.route((url) => url.pathname === "/demo/bundle.json", (route) => route.fulfill({ status: 404, body: "No demo export" }));
  await page.goto("/");
  await expect(page.locator("#wall-load-error")).toContainText("has not been prepared");
  await expect(page.locator(".camera-tile")).toHaveCount(4);
  await expect(page.locator(".camera-stage:visible")).toHaveCount(0);
  await page.locator(".wall-options summary").click();
  await expect(page.locator("#wall-preferences-status")).toContainText("saved layout is invalid");
  await page.locator("#wall-reset").click();
  await expect(page.locator("#wall-preferences-status")).toBeHidden();
  await expect(page.locator("#camera-grid")).toHaveAttribute("data-layout", "4");
});

test("a failed media integrity check does not show apparently valid observations", async ({ page }) => {
  const bundle = await fixtureBundle();
  const first = bundle.clips[0];
  if (!first) throw new Error("Missing first fixture clip");
  first.video_sha256 = "0".repeat(64);
  await mockWall(page, bundle); await page.goto("/");
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "failed");
  await expect(page.locator('[data-slot="0"] .tile-state')).toContainText("SHA-256 mismatch");
  await expect(page.locator('[data-slot="0"] .camera-readings dd')).toHaveCount(0);
  await expect(page.locator('[data-slot="0"] .camera-stage')).toBeHidden();
  await expect(page.locator('[data-slot="0"] .camera-tile-actions a')).not.toHaveAttribute("href");
  await expect(page.locator('[data-slot="1"]')).toHaveAttribute("data-state", "paused");
});

test("private recordings require per-visit opt-in and never enter saved layout preferences", async ({ page }) => {
  const bundle = await mockWall(page);
  const id = "b".repeat(32);
  const job: AnalysisJob = {
    id, video_id: "a".repeat(32), name: "Private synthetic camera check", site: bundle.site,
    clock: {
      start_utc: "2026-01-15T08:00:00Z", original_start: "2026-01-15T10:00:00+02:00", source: "manual", metadata_key: null,
      playback_rate: 1, realtime_assumed: true, independently_verified: false,
    },
    device: "cpu", status: "succeeded", phase: "finished",
    created_at: "2026-01-15T12:00:00Z", updated_at: "2026-01-15T12:00:10Z",
    started_at: "2026-01-15T12:00:01Z", finished_at: "2026-01-15T12:00:10Z",
    duration_s: 3, processed_frames: 15, processed_media_s: 3, phase_fraction: 1, error: null,
    bundle_url: `/api/analysis/jobs/${id}/bundle`, events_url: `/api/analysis/jobs/${id}/events.csv`, export_url: `/api/analysis/jobs/${id}/result.json`,
  };
  const privateBundle = structuredClone(bundle);
  const clip = privateBundle.clips[0];
  if (!clip) throw new Error("Missing private synthetic clip");
  privateBundle.clips = [clip]; clip.id = "recording"; clip.video = "media/recording.mp4";
  clip.source.url = `/api/analysis/videos/${job.video_id}/source`;
  privateBundle.attribution.source_url = clip.source.url; privateBundle.attribution.license_url = null;
  let queries = 0, heads = 0;
  await page.route((url) => url.pathname === "/api/analysis/jobs", (route) => {
    queries++;
    return route.fulfill({ json: { kind: "analysis_jobs", jobs: [job, { ...job, id: "c".repeat(32), status: "failed" }] } });
  });
  await page.route((url) => url.pathname === `/api/analysis/jobs/${id}`, (route) =>
    route.fulfill({ json: { kind: "analysis_job", job } }));
  await page.route((url) => url.pathname === `/api/analysis/jobs/${id}/bundle`, (route) =>
    route.fulfill({ json: privateBundle }));
  const media = await readFile(fixtureMediaURL);
  await page.route((url) => url.pathname === `/api/analysis/jobs/${id}/media/recording.mp4`, (route) => {
    const head = route.request().method() === "HEAD";
    if (head) heads++;
    return route.fulfill({
      status: 200, contentType: "video/mp4", ...(head ? {} : { body: media }),
      headers: { "X-Content-SHA256": clip.video_sha256, "X-Integrity-Check": "server-verified", "Cache-Control": "no-store" },
    });
  });
  await loadWall(page);
  expect(queries).toBe(0);
  await page.locator(".wall-options summary").click();
  await page.locator("#wall-private").check();
  await expect(page.locator("#wall-camera-0")).toContainText("Private synthetic camera check");
  await expect(page.locator("#wall-camera-0 option")).toHaveCount(5);
  await page.locator("#wall-camera-0").selectOption(`private:${id}`);
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
  expect(heads).toBe(1);
  const saved = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(saved).not.toContain(id); expect(saved).not.toContain(job.name);
  await page.locator("#wall-private").uncheck();
  await expect(page.locator("#wall-camera-0")).toHaveValue("");
  await expect(page.locator('[data-slot="0"] .camera-stage')).toBeHidden();
  await expect(page.locator("#wall-camera-0")).not.toContainText(job.name);
  await page.reload();
  await expect(page.locator("#wall-camera-0")).toHaveValue("");
  await page.locator(".wall-options summary").click();
  await expect(page.locator("#wall-private")).not.toBeChecked();
  expect(queries).toBe(1);
});

test("private-catalogue errors remain visible and do not leave a fake loading state", async ({ page }) => {
  await mockWall(page);
  await page.route((url) => url.pathname === "/api/analysis/jobs", (route) =>
    route.fulfill({ status: 503, json: { detail: "The private API is unavailable" } }));
  await loadWall(page);
  await page.locator(".wall-options summary").click();
  await page.locator("#wall-private").check();
  await expect(page.locator("#operations-error")).toContainText("private API is unavailable");
  await expect(page.locator("#wall-private")).not.toBeChecked();
  await expect(page.locator("#wall-private-status")).toBeEmpty();
  await expect(page.locator("#wall-camera-0 option")).toHaveCount(4);
});

test("the dashboard is usable on mobile, in Romanian and with keyboard layout selection", async ({ page }, info) => {
  await mockWall(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await loadWall(page);
  await page.locator("#language").selectOption("ro");
  await expect(page.locator("h1")).toHaveText("Prezentarea camerelor");
  const button = page.getByRole("button", { name: "O singura imagine", exact: true });
  await button.focus(); await page.keyboard.press("Space");
  await expect(page.locator(".camera-tile")).toHaveCount(1);
  await expect(page.locator("#wall-camera-0")).toContainText("Filmarea sintetica 1");
  const image = await page.locator('[data-slot="0"] video').boundingBox();
  const overlay = await page.locator('[data-slot="0"] canvas').boundingBox();
  if (!image || !overlay) throw new Error("Missing visible media/overlay geometry");
  expect(image.width / image.height).toBeCloseTo(400 / 240, 2);
  expect(overlay.x).toBeCloseTo(image.x, 1);
  expect(overlay.y).toBeCloseTo(image.y, 1);
  expect(overlay.width).toBeCloseTo(image.width, 1);
  expect(overlay.height).toBeCloseTo(image.height, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("dashboard-mobile-ro.png"), fullPage: true });
  await page.locator('[data-tool="billing"]').click();
  await expect(page.locator("h1")).toContainText("Previzualizarea tarifului");
  await expect(page.locator("#workspace-sidebar")).toBeVisible();
  await expect(page.locator("#language")).toHaveValue("ro");
});

test("the real demo wall labels three historical views from one camera, not three live cameras", async ({ page }, info) => {
  test.skip(!existsSync(new URL("../public/demo/bundle.json", import.meta.url)), "Real replay absent; no synthetic replacement.");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const bundle: Bundle = await (await page.request.get("/demo/bundle.json")).json();
  expect(bundle.synthetic).toBe(false);
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
  await expect(page.locator('[data-slot="1"]')).toHaveAttribute("data-state", "paused");
  await expect(page.locator('[data-slot="2"]')).toHaveAttribute("data-state", "paused");
  await expect(page.locator(".camera-badge").first()).toHaveText("Recorded demo");
  await expect(page.locator('[data-dashboard="recordedHelp"]')).toContainText("one camera, not simultaneous");
  await expect(page.locator('[data-dashboard="noLive"]')).toHaveText("No live cameras connected");
  await expect(page.locator("#wall-catalogue")).toContainText("3 available recordings");
  await page.screenshot({ path: info.outputPath("dashboard-real-desktop.png"), fullPage: true });
});

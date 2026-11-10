import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Bundle } from "../src/types";

const directory = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
const fixture = fileURLToPath(new URL("../public/test-fixture/media/fixture.mp4", import.meta.url));

async function timeline(page: Page, slot: number, at: number): Promise<void> {
  await page.locator(`[data-slot="${slot}"] input[type="range"]`).evaluate((node, value) => {
    if (!(node instanceof HTMLInputElement)) throw new Error("Missing screenshot camera timeline");
    node.value = String(value); node.dispatchEvent(new Event("input", { bubbles: true }));
  }, at);
  await expect.poll(() => page.locator(`[data-slot="${slot}"] video`).evaluate((node) =>
    node instanceof HTMLVideoElement && !node.seeking)).toBe(true);
}

async function capture(page: Page, name: string): Promise<void> {
  await expect(page.locator("#workspace-sidebar")).toBeVisible();
  await expect(page.locator("#operations-error")).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(directory, name), fullPage: false, animations: "disabled" });
}

test("capture the platform with original synthetic data and no model inference", async ({ page }) => {
  await mkdir(directory, { recursive: true });
  const bundle: Bundle = JSON.parse(await readFile(new URL("../public/test-fixture/bundle.json", import.meta.url), "utf8"));
  const clip = bundle.clips[0];
  if (!clip || !bundle.synthetic || bundle.run.device !== "synthetic") {
    throw new Error("Public screenshots require the original synthetic fixture");
  }
  clip.name = { en: "Synthetic test recording", ro: "Filmarea sintetica de test" };
  bundle.reference = null; bundle.evaluation = null;
  const media = await readFile(fixture);
  await page.route((url) => url.pathname === "/demo/bundle.json", (route) =>
    route.fulfill({ json: bundle }));
  await page.route((url) => url.pathname === "/demo/media/fixture.mp4", (route) =>
    route.fulfill({ body: media, contentType: "video/mp4" }));
  let queuedJobs = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/analysis/jobs" && request.method() === "POST") queuedJobs++;
  });

  await page.goto("/");
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
  await page.locator("#wall-camera-1").selectOption(`demo:${clip.id}`);
  await page.locator("#wall-camera-2").selectOption(`demo:${clip.id}`);
  for (const [slot, at] of [[0, 0.8], [1, 1.8], [2, 2.4]] as const) {
    await expect(page.locator(`[data-slot="${slot}"]`)).toHaveAttribute("data-state", "paused");
    await expect(page.locator(`[data-slot="${slot}"] .camera-badge`)).toHaveText("Synthetic test");
    await timeline(page, slot, at);
  }
  const wall = await page.locator("#camera-grid").boundingBox();
  if (!wall) throw new Error("Missing screenshot camera wall");
  await page.setViewportSize({ width: 1440, height: Math.ceil(wall.y + wall.height + 30) });
  await capture(page, "dashboard.png");

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/?mode=monitoring");
  await expect(page.locator("#monitor-site option")).toHaveCount(1);
  await page.locator("#open-example").click();
  await expect(page.locator("#operations-synthetic")).toBeVisible();
  await expect(page.locator("#monitor-meta")).toContainText("Matching records");
  await expect(page.locator("#monitor-results")).toContainText("DEMO001");
  await capture(page, "monitoring.png");

  await page.goto("/?mode=analysis");
  await page.locator("#video-file").setInputFiles({
    name: "synthetic-camera.mp4", mimeType: "video/mp4", buffer: media,
  });
  await page.locator("#content-kind").selectOption("synthetic_test");
  await page.locator("#upload-permission").check();
  await page.locator("#upload-button").click();
  await expect(page.locator("#selected-video")).toBeVisible();
  await expect(page.locator("#video-details")).toContainText("Synthetic/test footage");
  await expect(page.locator("#geometry-canvas")).toHaveAttribute("width", "400");
  await page.locator("#recording-start").fill("2026-01-15T10:00:00+02:00");
  await page.locator("#whole-frame").click();
  await page.locator("#geometry-tool").selectOption("gate");
  const geometry = page.locator("#geometry-canvas");
  const bounds = await geometry.boundingBox();
  if (!bounds) throw new Error("Missing screenshot geometry editor");
  await geometry.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.15 } });
  await geometry.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.85 } });
  await page.locator("#geometry-finish").click();
  await expect(page.locator("#geometry-shapes li")).toHaveCount(2);
  await page.locator("#analysis-form section").nth(1).evaluate((node) =>
    node.scrollIntoView({ block: "start" }));
  await capture(page, "analysis.png");

  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto("/?mode=dashboard");
  await page.getByRole("button", { name: "Single view", exact: true }).click();
  await expect(page.locator('[data-slot="0"]')).toHaveAttribute("data-state", "paused");
  await timeline(page, 0, 1.8);
  await expect(page.locator("#wall-private")).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await capture(page, "mobile.png");
  expect(queuedJobs).toBe(0);
});

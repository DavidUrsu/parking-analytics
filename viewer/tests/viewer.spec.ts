import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Bundle } from "../src/types";

async function loadSynthetic(page: Page): Promise<void> {
  await page.goto("/?bundle=/test-fixture/bundle.json");
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#observed")).toHaveText("0");
  await expect(page.locator("#error")).toBeHidden();
}

async function bundleData(page: Page, path = "/test-fixture/bundle.json"): Promise<Bundle> {
  const response = await page.request.get(path);
  expect(response.ok()).toBeTruthy();
  const value: unknown = await response.json();
  return page.evaluate(async (payload) => {
    const moduleURL = "/src/replay.ts";
    const library: typeof import("../src/replay") = await import(moduleURL);
    return library.parseBundle(payload);
  }, value);
}

async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.locator("#seek").evaluate((node, value) => {
    if (!(node instanceof HTMLInputElement)) throw new Error("Missing native timeline");
    node.value = String(value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && !video.seeking;
  });
}

test("synthetic playback controls and backward seeks do not invent or duplicate counts", async ({ page }) => {
  await loadSynthetic(page);
  await expect(page.locator("#synthetic")).toBeVisible();
  await page.locator("#play").click();
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && !video.paused;
  });
  await page.locator("#play").click();
  await seekTo(page, 2);
  await expect(page.locator("#observed")).toHaveText("1");
  await expect(page.locator("#entries")).toHaveText("1");
  await expect(page.locator("#exits")).toHaveText("0");
  await page.locator("#boxes").uncheck();
  const trailPixel = await page.locator("#overlay").evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Missing overlay canvas");
    const context = node.getContext("2d");
    if (!context) throw new Error("Missing overlay context");
    return Array.from(context.getImageData(160, 168, 1, 1).data);
  });
  expect(trailPixel[3]).toBeGreaterThan(0);
  await page.locator("#trails").uncheck();
  const clearPixel = await page.locator("#overlay").evaluate((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("Missing overlay canvas");
    const context = node.getContext("2d");
    if (!context) throw new Error("Missing overlay context");
    return context.getImageData(160, 168, 1, 1).data[3];
  });
  expect(clearPixel).toBe(0);
  await page.locator("#boxes").check();
  await page.locator("#trails").check();
  await seekTo(page, 0.4);
  await expect(page.locator("#observed")).toHaveText("0");
  await expect(page.locator("#entries")).toHaveText("0");
  await seekTo(page, 2.8);
  await expect(page.locator("#entries")).toHaveText("1");
  await page.locator("#method").selectOption("baseline");
  await expect(page.locator("#entries")).toHaveText("1");
  await expect(page.locator("#overlay")).toHaveAttribute("width", "400");
  await expect(page.locator("#overlay")).toHaveAttribute("height", "240");
});

test("the consumer selects only past, fresh observations and reconstructs event prefixes", async ({ page }) => {
  await loadSynthetic(page);
  const fixture = await bundleData(page);
  const result = await page.evaluate(async (bundle) => {
    const moduleURL = "/src/replay.ts";
    const library: typeof import("../src/replay") = await import(moduleURL);
    const clip = bundle.clips[0];
    if (!clip) throw new Error("Fixture has no clip");
    return {
      past: library.sampleAt(clip.candidate, 0.19, 0.6)?.time_s,
      stale: library.sampleAt(clip.candidate, 0.19, 0.1),
      before: library.sampleAt(clip.candidate, -1, 0.6),
      counts: [2, 0.4, 2].map((time) => library.countsAt(clip.candidate, time).in),
    };
  }, fixture);
  expect(result).toEqual({ past: 0, stale: null, before: null, counts: [1, 0, 1] });
});

test("invalid contracts fail visibly instead of substituting synthetic or empty results", async ({ page }) => {
  await loadSynthetic(page);
  const fixture = await bundleData(page);
  const invalid = { ...fixture, schema_version: "unsupported" };
  await page.route((url) => url.pathname === "/bad/bundle.json",
    (route) => route.fulfill({ json: invalid }));
  await page.goto("/?bundle=/bad/bundle.json");
  await expect(page.locator("#error")).toContainText("Invalid replay contract");
  await expect(page.locator("#play")).toBeDisabled();
  await expect(page.locator("#observed")).toHaveText("Unknown");
  await expect(page.locator("#synthetic")).toBeHidden();
});

test("media checksum mismatch is an error, not an apparently working replay", async ({ page }) => {
  await loadSynthetic(page);
  const fixture = await bundleData(page);
  const clip = fixture.clips[0];
  if (!clip) throw new Error("Fixture has no clip");
  clip.video_sha256 = "0".repeat(64);
  const response = await page.request.get("/test-fixture/media/fixture.mp4");
  const media = await response.body();
  await page.route((url) => url.pathname === "/broken/bundle.json",
    (route) => route.fulfill({ json: fixture }));
  await page.route((url) => url.pathname === "/broken/media/fixture.mp4", (route) => route.fulfill({
    body: media, contentType: "video/mp4",
  }));
  await page.goto("/?bundle=/broken/bundle.json");
  await expect(page.locator("#error")).toContainText("SHA-256 mismatch");
  await expect(page.locator("#play")).toBeDisabled();
  await expect(page.locator("#observed")).toHaveText("Unknown");
});

test("reference edits export explicit provisional labels without rewriting the server", async ({ page }) => {
  await loadSynthetic(page);
  await page.locator("#snapshot").selectOption("2");
  await page.locator("#reference-count").fill("2");
  await page.locator("#reference-count").press("Tab");
  await expect(page.locator("#reference-dirty")).toBeVisible();
  await expect(page.locator("#human-reviewed")).not.toBeChecked();
  await expect(page.locator("#events-complete")).not.toBeChecked();
  const pending = page.waitForEvent("download");
  await page.locator("#download-reference").click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("Expected a local reference download");
  const exported: unknown = JSON.parse(await readFile(path, "utf-8"));
  expect(exported).toMatchObject({ review_status: "provisional", events_complete: false });
  expect(exported).toHaveProperty("clips.0.snapshots.2.zone_counts.zone", 2);
  const original = await bundleData(page);
  expect(original.reference?.review_status).toBe("provisional");
  expect(original.reference?.clips[0]?.snapshots[2]?.zone_counts.zone).toBe(1);
});

test("Romanian controls work with keyboard at a narrow mobile width", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadSynthetic(page);
  await page.locator("#language").selectOption("ro");
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.locator("h1")).toContainText("De la filmare");
  await expect(page.locator("#snapshot")).toHaveValue("0");
  await expect(page.locator("#media-status")).toContainText("Suma de control");
  await page.locator("#play").focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement && !video.paused;
  });
  await page.keyboard.press("Space");
  await page.locator("#seek").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#entries")).toHaveText("1");
  await page.keyboard.press("Home");
  await expect(page.locator("#entries")).toHaveText("0");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("romanian-mobile.png"), fullPage: true });
});

test("real replay shows actual model output, resets segments and never claims free capacity or scored F1", async ({ page }, info) => {
  test.skip(!existsSync(new URL("../public/demo/bundle.json", import.meta.url)),
    "Real export absent: prepare it with parking fetch/process/evaluate/export. No synthetic substitute.");
  await page.goto("/?mode=evidence");
  await expect(page.locator("#play")).toBeEnabled();
  await expect(page.locator("#error")).toBeHidden();
  const bundle = await bundleData(page, "/demo/bundle.json");
  expect(bundle.synthetic).toBe(false);
  expect(bundle.run.model_id).toBe("PekingU/rtdetr_r18vd");
  expect(bundle.run.model_revision).toBe("ac77a11ff0170a41b771c03264987f8ce2b0d753");
  expect(bundle.protocol.version).toBe("g328-zone-v2");
  expect(bundle.reference?.review_status).toBe("provisional");
  expect(bundle.evaluation?.events_complete).toBe(false);
  await expect(page.locator("#synthetic")).toBeHidden();
  await expect(page.locator("#incomplete")).toBeVisible();
  expect(await page.locator("#metrics").getByText("Not scored", { exact: true }).count()).toBe(2);
  const events = bundle.clips.flatMap((clip) => clip.candidate.events);
  expect(events.some((event) => event.direction === "in")).toBe(true);
  expect(events.some((event) => event.direction === "out")).toBe(true);
  expect(bundle.clips.some((clip) => new Set(
    clip.candidate.samples.map((sample) => sample.zones[0]?.vehicle_count),
  ).size > 1)).toBe(true);
  for (const clip of bundle.clips) {
    for (const method of [clip.baseline, clip.candidate]) {
      expect(method.samples.every((sample) => sample.zones.every(
        (zone) => zone.available === null && zone.capacity === null,
      ))).toBe(true);
    }
  }
  await page.locator("#clips").selectOption("arrival");
  await expect(page.locator("#media-status")).toHaveText("Media checksum and timing checked.");
  await expect(page.locator("#observed")).not.toHaveText("Unknown");
  await expect(page.locator("#entries")).toHaveText("0");
  await seekTo(page, 43);
  const expected = await page.evaluate(async (value) => {
    const moduleURL = "/src/replay.ts";
    const library: typeof import("../src/replay") = await import(moduleURL);
    const clip = value.clips.find((item) => item.id === "arrival");
    if (!clip) throw new Error("Missing real arrival segment");
    return library.countsAt(clip.candidate, 43);
  }, bundle);
  await expect(page.locator("#entries")).toHaveText(String(expected.in));
  await expect(page.locator("#exits")).toHaveText(String(expected.out));
  await seekTo(page, 0);
  await expect(page.locator("#entries")).toHaveText("0");
  await expect(page.locator("#overlay")).toHaveAttribute("width", "1344");
  await expect(page.locator("#overlay")).toHaveAttribute("height", "400");
  await page.screenshot({ path: info.outputPath("real-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("real-mobile.png"), fullPage: true });
});

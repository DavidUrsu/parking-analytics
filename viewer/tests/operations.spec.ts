import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { OperationsResponse, OperatorSite } from "../src/operations-types";

async function validated(page: Page, value: unknown): Promise<OperationsResponse> {
  return page.evaluate(async (payload) => {
    const url = "/src/operations-client.ts";
    const client: typeof import("../src/operations-client") = await import(url);
    return client.parseOperations(payload);
  }, value);
}

async function api(page: Page, path: string, body?: unknown): Promise<OperationsResponse> {
  const response = body === undefined
    ? await page.request.get(`/api/${path}`)
    : await page.request.post(`/api/${path}`, { data: body });
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload: unknown = await response.json();
  return validated(page, payload);
}

async function example(page: Page): Promise<OperatorSite> {
  await page.goto("/?mode=monitoring");
  const response = await api(page, "examples", { site_id: `example-${randomUUID().slice(0, 12)}` });
  if (response.kind !== "import") throw new Error("Expected an explicit synthetic example");
  expect(response.site.source_kind).toBe("synthetic");
  await page.goto("/?mode=monitoring");
  await expect(page.locator("#monitor-site")).toContainText(response.site.name);
  await page.locator("#monitor-site").selectOption(response.site.id);
  await expect(page.locator("#operations-synthetic")).toBeVisible();
  await expect(page.locator("#monitor-meta")).toContainText("Matching records");
  return response.site;
}

async function search(page: Page): Promise<void> {
  const response = page.waitForResponse((result) =>
    new URL(result.url()).pathname === "/api/monitoring/search"
      && result.request().method() === "POST");
  await page.locator("#search-events").click();
  await response;
  await expect(page.locator("#monitor-meta")).toContainText("Matching records");
}

function utcInput(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 19).replace(/:00$/, "");
}

test("Monitoring starts with no fabricated plate sources and all modes are navigable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Vehicle visits, not guesses.");
  await expect(page.locator("#empty-source")).toBeVisible();
  await expect(page.locator("#search-events")).toBeDisabled();
  await expect(page.locator("#plate-filter")).toBeDisabled();
  await expect(page.locator("#operations-synthetic")).toBeHidden();
  await expect(page.locator("#mode-navigation a")).toHaveCount(4);
  await expect(page.locator("#operations-error")).toBeHidden();
});

test("plate history and entry/exit/overlap filters answer distinct questions", async ({ page }) => {
  const site = await example(page);
  await page.locator("#plate-filter").fill("demo-001");
  await search(page);
  await expect(page.locator("#monitor-results tbody tr")).toHaveCount(2);
  await expect(page.locator("#monitor-results")).toContainText("DEMO001");
  const entries = await api(page, "monitoring/search", { site_id: site.id, plate: "DEMO001", view: "entries" });
  const exits = await api(page, "monitoring/search", { site_id: site.id, plate: "DEMO001", view: "exits" });
  if (entries.kind !== "monitoring" || exits.kind !== "monitoring") throw new Error("Missing event lists");
  const secondEntry = entries.records.find((row) =>
    row.record_type === "event" && row.event_id === "one-in-again");
  const firstExit = exits.records.find((row) => row.record_type === "event" && row.event_id === "one-out");
  if (secondEntry?.record_type !== "event" || firstExit?.record_type !== "event") {
    throw new Error("Missing synthetic boundary cases");
  }
  await page.locator("#range-start").fill(utcInput(
    new Date(Date.parse(firstExit.occurred_at) - 30 * 60_000).toISOString(),
  ));
  await page.locator("#range-end").fill(utcInput(secondEntry.occurred_at));
  await page.locator("#monitor-view").selectOption("entries");
  await search(page);
  await expect(page.locator("#monitor-meta")).toContainText("Matching records: 0");
  await page.locator("#monitor-view").selectOption("exits");
  await search(page);
  await expect(page.locator("#monitor-results tbody tr")).toHaveCount(1);
  await expect(page.locator("#monitor-results")).toContainText("one-out");
  await page.locator("#monitor-view").selectOption("present");
  await search(page);
  await expect(page.locator("#monitor-results tbody tr")).toHaveCount(1);
  expect(page.url()).not.toContain("DEMO001");
});

test("event correction is audited and enables only an unambiguous completed visit fee", async ({ page }) => {
  await example(page);
  await page.locator("#monitor-view").selectOption("review");
  await search(page);
  await page.getByRole("button", { name: "Review event duplicate-in-second", exact: true }).click();
  await expect(page.locator("#event-review")).toBeVisible();
  await page.locator("#review-state").selectOption("ignored");
  await page.locator("#review-reason").fill("Checked generated source: this is the duplicate read.");
  await page.locator("#review-checked").check();
  await page.locator("#save-event-review").click();
  await expect(page.locator("#review-saved")).toContainText("Correction saved");
  await expect(page.locator("#event-audit")).toContainText("duplicate read");
  await expect(page.locator("#monitor-meta")).toContainText("Matching records: 3");
  await page.locator("#monitor-view").selectOption("audit");
  await search(page);
  await expect(page.locator("#monitor-results tbody tr")).toHaveCount(1);
  await expect(page.locator("#monitor-results")).toContainText("Ignored");
  await page.locator("#monitor-view").selectOption("visits");
  await page.locator("#plate-filter").fill("DEMO004");
  await search(page);
  await expect(page.locator("#monitor-results tbody tr")).toHaveCount(1);
  await page.getByRole("link", { name: "Fee preview", exact: true }).click();
  await expect(page.locator("#billing-context")).toBeVisible();
  await expect(page.locator("#operations-synthetic")).toBeVisible();
  await page.locator("#billing-currency").selectOption("EUR");
  await page.locator("#billing-price").fill("1.05");
  await page.locator("#billing-interval").fill("30");
  await page.locator("#billing-free").fill("15");
  await page.locator("#calculate-billing").click();
  await expect(page.locator("#billing-total")).toHaveText("2.10 EUR");
  await expect(page.locator("#billing-result")).toContainText("not an invoice");
  expect(page.url()).not.toContain("DEMO004");
});

test("Billing requires an explicit price and never retains a stale quote after invalid times", async ({ page }) => {
  await page.goto("/?mode=billing");
  await expect(page.locator("#billing-price")).toHaveValue("");
  await expect(page.locator("#billing-currency")).toHaveValue("");
  await page.locator("#billing-entry").fill("2026-01-15T10:00");
  await page.locator("#billing-exit").fill("2026-01-15T11:15");
  await page.locator("#billing-currency").selectOption("RON");
  await page.locator("#billing-price").fill("5,00");
  await page.locator("#billing-interval").fill("30");
  await page.locator("#billing-free").fill("15");
  await page.locator("#calculate-billing").click();
  await expect(page.locator("#billing-total")).toHaveText("10.00 RON");
  await page.locator("#billing-exit").fill("2026-01-15T09:00");
  await page.locator("#calculate-billing").click();
  await expect(page.locator("#operations-error")).toContainText("Exit must not precede entry");
  await expect(page.locator("#billing-result")).toBeHidden();
});

test("Capacity subtracts unknown spaces and does not convert camera vehicles into free bays", async ({ page }) => {
  await page.goto("/?mode=capacity");
  await expect(page.locator("#mapped-spaces")).toHaveValue("");
  await expect(page.locator("#occupied-spaces")).toHaveValue("");
  await expect(page.locator("#unknown-spaces")).toHaveValue("");
  await page.locator("#mapped-spaces").fill("10");
  await page.locator("#occupied-spaces").fill("6");
  await page.locator("#unknown-spaces").fill("2");
  await page.locator("#calculate-capacity").click();
  await expect(page.locator("#available-spaces")).toHaveText("2");
  await expect(page.locator("#capacity-result")).toContainText("Operator inputs only");
  await page.locator("#unknown-spaces").fill("5");
  await page.locator("#calculate-capacity").click();
  await expect(page.locator("#operations-error")).toContainText("cannot exceed");
  await expect(page.locator("#capacity-result")).toBeHidden();
});

test("new modes retain Romanian labels and fit a mobile viewport without plate URLs", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await example(page);
  await page.locator("#plate-filter").fill("DEMO001");
  await search(page);
  await page.locator("#language").selectOption("ro");
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await expect(page.locator("#mode-navigation")).toContainText("Monitorizare");
  await expect(page.locator("#monitor-results")).toContainText("Incheiata");
  expect(page.url()).not.toContain("DEMO001");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("monitoring-mobile-ro.png"), fullPage: true });
  await page.locator("#mode-navigation a[data-mode=billing]").click();
  await expect(page.locator("h1")).toContainText("Previzualizarea tarifului");
  await expect(page.locator("html")).toHaveAttribute("lang", "ro");
  await page.locator("#mode-navigation a[data-mode=analysis]").click();
  await expect(page.locator("h1")).toContainText("Analizeaza");
  await page.locator("#benchmark-replay").click();
  await expect(page.locator("h1")).toContainText("De la filmare");
});

import { request } from "./operations-client";
import { language, opText as t } from "./operations-i18n";
import type { BillingPolicy, QuoteResponse, VisitResponse } from "./operations-types";
import {
  clearError, duration, element, inputTimestamp, option, setText,
  setupPage, showError, syntheticBanner, utcDisplay, utcInput,
} from "./operations-ui";
import { parseBundle, sampleAt } from "./replay";
import type { Bundle } from "./types";

function priceMinor(value: string): number {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match?.[1]) throw new Error(t("invalidPrice"));
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor > 1_000_000_000n) throw new Error(t("invalidPrice"));
  return Number(minor);
}

function formatMoney(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Invalid exact-money response");
  const integer = BigInt(minor) / 100n;
  const fraction = (BigInt(minor) % 100n).toString().padStart(2, "0");
  const separator = new Intl.NumberFormat(language()).formatToParts(1.1).find(
    (part) => part.type === "decimal",
  )?.value;
  if (!separator) throw new Error("Locale decimal separator is unavailable");
  return `${new Intl.NumberFormat(language(), { maximumFractionDigits: 0 }).format(integer)}${separator}${fraction} ${currency}`;
}

export async function mountBilling(): Promise<void> {
  setupPage("billingTitle", "billingIntro", `
    <p class="banner" data-op="completeOnly"></p>
    <section id="billing-context" class="panel" hidden>
      <h2 data-op="recordedVisit"></h2><p id="billing-record"></p>
      <a id="manual-billing" data-op="manualInstead"></a>
    </section>
    <form id="billing-form" class="panel op-gap">
      <h2 data-op="manual" id="billing-basis"></h2>
      <div class="op-grid">
        <div class="field"><label for="billing-entry" data-op="entered"></label><input id="billing-entry" type="datetime-local" step="1" required /></div>
        <div class="field"><label for="billing-exit" data-op="exited"></label><input id="billing-exit" type="datetime-local" step="1" required /></div>
        <div class="field"><label for="billing-currency" data-op="currency"></label><select id="billing-currency" required>
          <option value="" data-op="chooseCurrency"></option><option value="RON">RON</option><option value="EUR">EUR</option><option value="USD">USD</option>
        </select></div>
        <div class="field"><label for="billing-price" data-op="price"></label><input id="billing-price" inputmode="decimal" autocomplete="off" required /></div>
        <div class="field"><label for="billing-interval" data-op="interval"></label><input id="billing-interval" type="number" min="1" max="10080" value="60" step="1" required /></div>
        <div class="field"><label for="billing-free" data-op="free"></label><input id="billing-free" type="number" min="0" max="1000000" value="0" step="1" required /></div>
      </div>
      <p class="caption" data-op="tariffRule"></p><button id="calculate-billing" class="primary" data-op="quote"></button>
    </form>
    <section class="panel op-gap" id="billing-result" hidden aria-live="polite">
      <h2 data-op="total"></h2><output id="billing-total" class="op-total"></output>
      <dl id="billing-breakdown"></dl><p class="caption" data-op="notInvoice"></p>
    </section>`);
  let selected: VisitResponse | null = null;
  let quote: QuoteResponse | null = null;
  let busy = false;
  const form = element<HTMLFormElement>("#billing-form");
  const query = new URLSearchParams(location.search);
  const site = query.get("site"), visitId = query.get("visit");
  const manualURL = new URL(location.href);
  manualURL.search = new URLSearchParams({ mode: "billing", lang: language() }).toString();
  element<HTMLAnchorElement>("#manual-billing").href = manualURL.href;

  function renderQuote(): void {
    if (!quote) return;
    element("#billing-result").hidden = false;
    setText("#billing-total", formatMoney(quote.total_minor, quote.policy.currency));
    const details = element("#billing-breakdown"); details.replaceChildren();
    for (const [label, value] of [
      [t("entered"), utcDisplay(quote.entered_at)], [t("exited"), utcDisplay(quote.exited_at)],
      [t("duration"), duration(quote.duration_seconds)], [t("billable"), duration(quote.billable_seconds)],
      [t("intervals"), String(quote.charged_intervals)],
      [t("free"), String(quote.policy.free_minutes)],
    ]) {
      const term = document.createElement("dt"); term.textContent = label ?? "";
      const result = document.createElement("dd"); result.textContent = value ?? "";
      details.append(term, result);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const calculate = async (): Promise<void> => {
      clearError(); quote = null; element("#billing-result").hidden = true;
      const currency = element<HTMLSelectElement>("#billing-currency").value;
      if (currency !== "RON" && currency !== "EUR" && currency !== "USD") throw new Error("Choose currency");
      const policy: BillingPolicy = {
        currency, price_minor: priceMinor(element<HTMLInputElement>("#billing-price").value),
        interval_minutes: element<HTMLInputElement>("#billing-interval").valueAsNumber,
        free_minutes: element<HTMLInputElement>("#billing-free").valueAsNumber,
      };
      const response = selected
        ? await request("billing/visit", {
          site_id: selected.site.id, visit_id: selected.visit.visit_id, policy,
        })
        : await request("billing/preview", {
          entered_at: inputTimestamp(element<HTMLInputElement>("#billing-entry").value),
          exited_at: inputTimestamp(element<HTMLInputElement>("#billing-exit").value), policy,
        });
      if (response.kind !== "quote" || response.is_invoice) throw new Error("Expected a non-invoice preview");
      quote = response; syntheticBanner(response.source_kind); renderQuote();
    };
    busy = true; element<HTMLButtonElement>("#calculate-billing").disabled = true;
    calculate().catch(showError).finally(() => {
      busy = false; element<HTMLButtonElement>("#calculate-billing").disabled = false;
    });
  });
  document.addEventListener("parking-language", () => {
    if (selected) setText("#billing-basis", t("recordedVisit"));
    renderQuote();
  });
  if (site || visitId) {
    if (!site || !visitId) throw new Error("A recorded visit needs both site and visit identifiers");
    element<HTMLButtonElement>("#calculate-billing").disabled = true;
    const response = await request("visits/detail", { site_id: site, visit_id: visitId });
    if (response.kind !== "visit") throw new Error("Expected a recorded visit");
    selected = response; syntheticBanner(response.site.source_kind);
    element("#billing-context").hidden = false;
    setText("#billing-basis", t("recordedVisit"));
    setText("#billing-record", `${response.site.name} · ${response.visit.plate} · ${response.visit.country_code} · ${response.visit.status}`);
    element<HTMLInputElement>("#billing-entry").value = utcInput(response.visit.entered_at);
    element<HTMLInputElement>("#billing-entry").disabled = true;
    element<HTMLInputElement>("#billing-exit").value = response.visit.exited_at ? utcInput(response.visit.exited_at) : "";
    element<HTMLInputElement>("#billing-exit").disabled = true;
    if (response.visit.status !== "completed" || !response.visit.exited_at) {
      throw new Error(t("completeOnly"));
    }
    element<HTMLButtonElement>("#calculate-billing").disabled = false;
  }
}

export async function mountCapacity(): Promise<void> {
  setupPage("capacityTitle", "capacityIntro", `
    <section class="panel">
      <h2 data-op="manual"></h2><p data-op="capacityBasis"></p>
      <form id="capacity-form">
        <div class="op-grid">
          <div class="field"><label for="mapped-spaces" data-op="mapped"></label><input id="mapped-spaces" type="number" min="0" max="1000000" step="1" required /></div>
          <div class="field"><label for="occupied-spaces" data-op="occupied"></label><input id="occupied-spaces" type="number" min="0" max="1000000" step="1" required /></div>
          <div class="field"><label for="unknown-spaces" data-op="unknownSpaces"></label><input id="unknown-spaces" type="number" min="0" max="1000000" step="1" required /></div>
        </div>
        <p class="caption" data-op="inventoryHint"></p><button id="calculate-capacity" class="primary" data-op="capacityCalculate"></button>
      </form>
      <div id="capacity-result" hidden class="op-gap" aria-live="polite">
        <div data-op="available"></div><output id="available-spaces" class="op-total"></output>
        <p id="capacity-unknown"></p><p class="caption" data-op="capacityBasis"></p>
      </div>
    </section>
    <section class="panel op-gap">
      <h2 data-op="cameraContext"></h2><p data-op="cameraHint"></p>
      <div id="capacity-camera-error" class="banner error" role="alert" hidden></div>
      <div id="capacity-camera" hidden>
        <div class="op-grid">
          <div class="field"><label for="capacity-clip" data-op="clip"></label><select id="capacity-clip"></select></div>
          <div class="field"><label for="capacity-time" data-op="cameraTime"></label><input id="capacity-time" type="range" min="0" value="0" step="0.2" /></div>
        </div>
        <div class="stats">
          <div class="stat"><div class="stat-label" data-op="observedVehicles"></div><output id="capacity-observed"></output><small id="capacity-camera-time"></small></div>
          <div class="stat unknown"><div class="stat-label" data-op="cameraCapacity"></div><output data-op="unknown"></output></div>
        </div>
        <a id="capacity-evidence" data-op="openEvidence"></a>
      </div>
    </section>`);
  let bundle: Bundle | null = null;
  let unknownCount: number | null = null;
  let availableCount: number | null = null;
  let busy = false;
  const form = element<HTMLFormElement>("#capacity-form");

  function renderCapacity(): void {
    if (availableCount === null || unknownCount === null) return;
    setText("#available-spaces", String(availableCount));
    setText("#capacity-unknown", `${t("unknownSpaces")}: ${unknownCount}`);
    element("#capacity-result").hidden = false;
  }

  function renderCamera(): void {
    if (!bundle) return;
    const clip = bundle.clips.find((item) => item.id === element<HTMLSelectElement>("#capacity-clip").value);
    if (!clip) throw new Error("Unknown capacity camera segment");
    const time = Number(element<HTMLInputElement>("#capacity-time").value);
    const sample = sampleAt(clip.candidate, time, bundle.stale_after_s);
    const count = sample?.zones[0]?.vehicle_count;
    setText("#capacity-observed", count === undefined || count === null ? t("unknown") : String(count));
    setText("#capacity-camera-time", `${time.toFixed(2)} s · ${clip.name[language()]}`);
    const url = new URL(location.href);
    url.search = new URLSearchParams({ mode: "evidence", lang: language() }).toString();
    element<HTMLAnchorElement>("#capacity-evidence").href = url.href;
  }

  function chooseClip(): void {
    if (!bundle) return;
    const clip = bundle.clips.find((item) => item.id === element<HTMLSelectElement>("#capacity-clip").value);
    if (!clip) throw new Error("Unknown camera segment");
    const slider = element<HTMLInputElement>("#capacity-time");
    slider.max = String(clip.duration_s); slider.value = "0"; renderCamera();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    clearError(); availableCount = null; unknownCount = null;
    element("#capacity-result").hidden = true;
    busy = true;
    request("capacity/calculate", {
      mapped_spaces: element<HTMLInputElement>("#mapped-spaces").valueAsNumber,
      occupied_spaces: element<HTMLInputElement>("#occupied-spaces").valueAsNumber,
      unknown_spaces: element<HTMLInputElement>("#unknown-spaces").valueAsNumber,
    }).then((response) => {
      if (response.kind !== "capacity" || response.basis !== "operator_inputs") {
        throw new Error("Expected operator-input capacity arithmetic");
      }
      availableCount = response.available_mapped_spaces; unknownCount = response.unknown_spaces;
      renderCapacity();
    }).catch(showError).finally(() => { busy = false; });
  });
  element("#capacity-clip").addEventListener("change", chooseClip);
  element("#capacity-time").addEventListener("input", renderCamera);
  document.addEventListener("parking-language", () => {
    renderCapacity();
    if (bundle) {
      const selected = element<HTMLSelectElement>("#capacity-clip").value;
      element<HTMLSelectElement>("#capacity-clip").replaceChildren(
        ...bundle.clips.map((clip) => option(clip.id, clip.name[language()])),
      );
      element<HTMLSelectElement>("#capacity-clip").value = selected;
      renderCamera();
    }
  });
  try {
    const response = await fetch("/demo/bundle.json");
    if (!response.ok) throw new Error(`Camera replay is unavailable (HTTP ${response.status})`);
    const payload: unknown = await response.json(); bundle = parseBundle(payload);
    element<HTMLSelectElement>("#capacity-clip").replaceChildren(
      ...bundle.clips.map((clip) => option(clip.id, clip.name[language()])),
    );
    element("#capacity-camera").hidden = false;
    chooseClip();
  } catch (error) {
    setText("#capacity-camera-error", error instanceof Error ? error.message : String(error));
    element("#capacity-camera-error").hidden = false;
  }
}

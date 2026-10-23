import { request } from "./operations-client";
import { opText as t } from "./operations-i18n";
import type {
  EventResponse, MonitoringResponse, OperatorSite, View,
} from "./operations-types";
import {
  button, clearError, duration, element, inputTimestamp, option, setText,
  setupPage, showError, syntheticBanner, utcDisplay, utcInput,
} from "./operations-ui";

export async function mountMonitoring(): Promise<void> {
  setupPage("monitoringTitle", "monitoringIntro", `
    <p class="banner" data-op="noOCR"></p>
    <section class="panel op-source">
      <div class="field grow"><label for="monitor-site" data-op="source"></label><select id="monitor-site"><option value="">...</option></select></div>
      <button id="refresh-sites" type="button" data-op="refresh"></button>
      <button id="open-example" type="button" data-op="example"></button>
    </section>
    <section id="empty-source" class="panel op-gap" hidden>
      <h2 data-op="noSources"></h2><p data-op="importHint"></p>
    </section>
    <form id="monitor-search" class="panel op-gap">
      <fieldset id="monitor-fields" disabled>
        <div class="op-grid">
          <div class="field"><label for="plate-filter" data-op="plate"></label><input id="plate-filter" autocomplete="off" maxlength="24" /></div>
          <div class="field"><label for="country-filter" data-op="country"></label><input id="country-filter" autocomplete="off" maxlength="2" pattern="[A-Za-z]{2}" /></div>
          <div class="field"><label for="monitor-view" data-op="view"></label><select id="monitor-view">
            <option value="visits" data-op="visits"></option><option value="entries" data-op="entries"></option><option value="exits" data-op="exits"></option>
            <option value="present" data-op="present"></option><option value="active" data-op="active"></option><option value="review" data-op="review"></option><option value="audit" data-op="auditView"></option>
          </select></div>
          <div class="field"><label for="range-start" data-op="from"></label><input id="range-start" type="datetime-local" step="1" /></div>
          <div class="field"><label for="range-end" data-op="to"></label><input id="range-end" type="datetime-local" step="1" /></div>
          <button class="primary" id="search-events" data-op="search"></button>
        </div>
      </fieldset>
      <p class="caption" data-op="rangeHint"></p>
    </form>
    <section class="panel op-gap" aria-live="polite">
      <p id="monitor-meta" class="caption"></p>
      <div id="monitor-results" class="scroll-table" tabindex="0"></div>
      <div class="op-pagination"><button id="previous-page" type="button" data-op="previous" disabled></button>
        <span id="page-range"></span><button id="next-page" type="button" data-op="next" disabled></button></div>
    </section>
    <section id="event-review" class="panel op-gap" hidden>
      <h2 data-op="reviewTitle"></h2><p id="review-source" class="caption"></p>
      <details><summary data-op="original"></summary><pre id="review-original" class="op-json"></pre></details>
      <form id="review-form">
        <div class="op-grid op-gap">
          <div class="field"><label for="review-plate" data-op="plateColumn"></label><input id="review-plate" autocomplete="off" maxlength="24" /></div>
          <div class="field"><label for="review-country" data-op="jurisdiction"></label><input id="review-country" autocomplete="off" maxlength="2" pattern="[A-Za-z]{2}" /></div>
          <div class="field"><label for="review-time" data-op="timestamp"></label><input id="review-time" required /></div>
          <div class="field"><label for="review-direction" data-op="direction"></label><select id="review-direction"><option value="in" data-op="in"></option><option value="out" data-op="out"></option></select></div>
          <div class="field"><label for="review-state" data-op="resolution"></label><select id="review-state"><option value="confirmed" data-op="confirmed"></option><option value="needs_review" data-op="needs_review"></option><option value="ignored" data-op="ignored"></option></select></div>
        </div>
        <div class="field op-gap"><label for="review-reason" data-op="reason"></label><textarea id="review-reason" minlength="3" maxlength="1000" required></textarea></div>
        <label class="check op-gap"><input id="review-checked" type="checkbox" required /><span data-op="checked"></span></label>
        <div class="op-actions"><button id="save-event-review" class="primary" data-op="saveReview"></button><button id="close-review" type="button" data-op="cancel"></button></div>
      </form>
      <p id="review-saved" role="status"></p><h3 data-op="audit"></h3><div id="event-audit"></div>
    </section>`);

  let sites: OperatorSite[] = [];
  let result: MonitoringResponse | null = null;
  let detail: EventResponse | null = null;
  let querySequence = 0;
  let queryController: AbortController | null = null;
  let reviewDirty = false;
  const siteSelect = element<HTMLSelectElement>("#monitor-site");
  const form = element<HTMLFormElement>("#monitor-search");
  const fields = element<HTMLFieldSetElement>("#monitor-fields");
  const viewSelect = element<HTMLSelectElement>("#monitor-view");
  const previous = element<HTMLButtonElement>("#previous-page");
  const next = element<HTMLButtonElement>("#next-page");
  const views: View[] = ["visits", "entries", "exits", "present", "active", "review", "audit"];

  function selectedView(): View {
    const value = viewSelect.value;
    const view = views.find((item) => item === value);
    if (!view) throw new Error("Unsupported monitoring query");
    return view;
  }

  function updateView(): void {
    const active = selectedView() === "active";
    element<HTMLInputElement>("#range-start").disabled = active;
    element<HTMLInputElement>("#range-end").disabled = active;
    const required = selectedView() === "present";
    element<HTMLInputElement>("#range-start").required = required;
    element<HTMLInputElement>("#range-end").required = required;
  }

  function renderSites(): void {
    const selected = siteSelect.value;
    siteSelect.replaceChildren(option("", t("chooseSource")),
      ...sites.map((site) => option(site.id, `${site.name} (${site.event_count})`)));
    if (sites.some((site) => site.id === selected)) siteSelect.value = selected;
    element("#empty-source").hidden = sites.length !== 0;
    fields.disabled = !siteSelect.value;
  }

  function appendCell(row: HTMLTableRowElement, value: string): HTMLTableCellElement {
    const cell = row.insertCell(); cell.textContent = value; return cell;
  }

  function renderResults(): void {
    const container = element("#monitor-results"); container.replaceChildren();
    previous.disabled = !result || result.offset === 0;
    next.disabled = !result || result.offset + result.records.length >= result.total;
    if (!result) { setText("#monitor-meta", ""); setText("#page-range", ""); return; }
    syntheticBanner(result.site.source_kind);
    setText("#monitor-meta", `${t("records")}: ${result.total} · ${t("asOf")}: ${utcDisplay(result.as_of)}`);
    setText("#page-range", result.total
      ? `${result.offset + 1}-${result.offset + result.records.length} / ${result.total}` : "0 / 0");
    if (!result.records.length) { container.textContent = t("noMatches"); return; }
    const table = document.createElement("table");
    const heading = table.createTHead().insertRow();
    const timeLabel = result.view === "exits" ? t("exitTime") : t("startEvent");
    for (const label of [t("record"), t("plateColumn"), t("jurisdiction"), timeLabel,
      t("exitTime"), t("duration"), t("status"), t("actions")]) {
      const th = document.createElement("th"); th.scope = "col"; th.textContent = label; heading.append(th);
    }
    const body = table.createTBody();
    for (const record of result.records) {
      const row = body.insertRow();
      appendCell(row, record.record_type === "visit" ? t("visit")
        : t(record.direction === "in" ? "entry" : "exit"));
      appendCell(row, record.plate ?? t("unknown"));
      appendCell(row, record.country_code ?? t("unknown"));
      appendCell(row, utcDisplay(record.record_type === "visit" ? record.entered_at : record.occurred_at));
      appendCell(row, record.record_type === "visit" ? utcDisplay(record.exited_at) : "--");
      appendCell(row, record.record_type === "event" ? "--"
        : record.status === "active" ? `${duration(record.elapsed_seconds)} (${t("soFar")})`
          : duration(record.duration_seconds));
      const status = record.record_type === "visit" ? t(record.status === "active" ? "open" : record.status)
        : t(record.issues.length ? "needs_review" : record.review_state);
      const state = appendCell(row, status);
      if (record.issues.length) {
        const issue = document.createElement("small");
        issue.textContent = record.issues.map((code) => t(code)).join("; "); state.append(issue);
      }
      const actions = row.insertCell(); actions.className = "op-row-actions";
      if (record.record_type === "event") {
        actions.append(button(`${t("eventDetails")} ${record.event_id}`,
          () => { openReview(record.event_id).catch(showError); }));
      } else {
        if (record.status === "completed") {
          const link = document.createElement("a");
          const url = new URL(location.href);
          url.search = new URLSearchParams({
            mode: "billing", lang: document.documentElement.lang,
            site: result.site.id, visit: record.visit_id,
          }).toString();
          link.href = url.href; link.textContent = t("calculate"); actions.append(link);
        }
        for (const eventId of record.event_ids) {
          actions.append(button(`${t("eventDetails")} ${eventId}`,
            () => { openReview(eventId).catch(showError); }));
        }
      }
    }
    container.append(table);
  }

  async function loadSites(): Promise<void> {
    clearError();
    const response = await request("sites");
    if (response.kind !== "sites") throw new Error("Expected site metadata");
    sites = response.sites; renderSites();
  }

  async function runSearch(offset = 0): Promise<void> {
    if (!form.reportValidity() || !siteSelect.value) return;
    const sequence = ++querySequence;
    queryController?.abort();
    queryController = new AbortController();
    const site = siteSelect.value;
    const view = selectedView();
    const start = element<HTMLInputElement>("#range-start").value;
    const end = element<HTMLInputElement>("#range-end").value;
    if (view !== "active" && Boolean(start) !== Boolean(end)) throw new Error(t("bothDates"));
    result = null; renderResults(); clearError();
    setText("#monitor-meta", t("loading"));
    try {
      const response = await request("monitoring/search", {
        site_id: site, view,
        plate: element<HTMLInputElement>("#plate-filter").value.trim() || null,
        country_code: element<HTMLInputElement>("#country-filter").value.trim() || null,
        start: view === "active" || !start ? null : inputTimestamp(start),
        end: view === "active" || !end ? null : inputTimestamp(end),
        offset, limit: 50,
      }, queryController.signal);
      if (sequence !== querySequence || siteSelect.value !== site) return;
      if (response.kind !== "monitoring") throw new Error("Expected monitoring records");
      result = response; renderResults();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (sequence !== querySequence) return;
      result = null; renderResults(); throw error;
    }
  }

  async function chooseSite(): Promise<void> {
    if (reviewDirty && !confirm(t("discardReview"))) {
      siteSelect.value = detail?.site.id ?? result?.site.id ?? "";
      return;
    }
    reviewDirty = false;
    queryController?.abort();
    querySequence++;
    detail = null; element("#event-review").hidden = true;
    result = null; renderResults(); clearError();
    const site = sites.find((item) => item.id === siteSelect.value);
    fields.disabled = !site;
    if (!site) { syntheticBanner(null); return; }
    syntheticBanner(site.source_kind);
    if (site.first_event_at && site.last_event_at) {
      element<HTMLInputElement>("#range-start").value = utcInput(site.first_event_at);
      element<HTMLInputElement>("#range-end").value = utcInput(
        new Date(Math.max(Date.now() + 1000, Date.parse(site.last_event_at) + 1000)).toISOString(),
      );
    }
    updateView(); await runSearch();
  }

  function renderReview(): void {
    if (!detail) return;
    reviewDirty = false;
    const record = detail.current;
    element("#event-review").hidden = false;
    setText("#review-source", `${detail.site.name} · ${detail.source_label} · ${record.event_id}`);
    setText("#review-original", JSON.stringify(detail.original, null, 2));
    element<HTMLInputElement>("#review-plate").value = record.plate ?? "";
    element<HTMLInputElement>("#review-country").value = record.country_code ?? "";
    element<HTMLInputElement>("#review-time").value = record.occurred_at;
    element<HTMLSelectElement>("#review-direction").value = record.direction;
    element<HTMLSelectElement>("#review-state").value = record.review_state;
    element<HTMLTextAreaElement>("#review-reason").value = "";
    element<HTMLInputElement>("#review-checked").checked = false;
    const audit = element("#event-audit"); audit.replaceChildren();
    if (!detail.audit.length) audit.textContent = t("noAudit");
    for (const item of detail.audit) {
      const entry = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${utcDisplay(item.changed_at)} · ${item.reason}`;
      const values = document.createElement("pre"); values.className = "op-json";
      values.textContent = JSON.stringify({ before: item.before, after: item.after }, null, 2);
      entry.append(summary, values); audit.append(entry);
    }
  }

  async function openReview(eventId: string): Promise<void> {
    if (reviewDirty && !confirm(t("discardReview"))) return;
    const site = siteSelect.value;
    clearError();
    const response = await request("events/detail", { site_id: site, event_id: eventId });
    if (siteSelect.value !== site) return;
    if (response.kind !== "event") throw new Error("Expected event detail");
    detail = response; setText("#review-saved", ""); renderReview();
    element("#event-review").scrollIntoView({ behavior: "instant", block: "start" });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault(); runSearch().catch(showError);
  });
  siteSelect.addEventListener("change", () => { chooseSite().catch(showError); });
  viewSelect.addEventListener("change", updateView);
  previous.addEventListener("click", () => {
    if (result) runSearch(Math.max(0, result.offset - result.limit)).catch(showError);
  });
  next.addEventListener("click", () => {
    if (result) runSearch(result.offset + result.limit).catch(showError);
  });
  element("#refresh-sites").addEventListener("click", () => { loadSites().catch(showError); });
  element("#open-example").addEventListener("click", () => {
    const control = element<HTMLButtonElement>("#open-example"); control.disabled = true;
    request("examples", {}).then(async (response) => {
      if (response.kind !== "import" || response.site.source_kind !== "synthetic") {
        throw new Error("Expected an explicitly synthetic example");
      }
      await loadSites(); siteSelect.value = response.site.id; await chooseSite();
    }).catch(showError).finally(() => { control.disabled = false; });
  });
  element("#close-review").addEventListener("click", () => {
    if (reviewDirty && !confirm(t("discardReview"))) return;
    reviewDirty = false;
    detail = null; element("#event-review").hidden = true;
  });
  element("#review-form").addEventListener("input", () => { reviewDirty = true; });
  window.addEventListener("beforeunload", (event) => {
    if (reviewDirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  element<HTMLFormElement>("#review-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const editor = element<HTMLFormElement>("#review-form");
    if (!detail || !editor.reportValidity()) return;
    const current = detail;
    const save = element<HTMLButtonElement>("#save-event-review");
    save.disabled = true; siteSelect.disabled = true; clearError();
    request("events/review", {
      site_id: current.site.id, event_id: current.current.event_id,
      expected_event_hash: current.current_hash,
      occurred_at: element<HTMLInputElement>("#review-time").value,
      plate: element<HTMLInputElement>("#review-plate").value.trim() || null,
      country_code: element<HTMLInputElement>("#review-country").value.trim() || null,
      direction: element<HTMLSelectElement>("#review-direction").value,
      review_state: element<HTMLSelectElement>("#review-state").value,
      reason: element<HTMLTextAreaElement>("#review-reason").value.trim(),
      source_checked: element<HTMLInputElement>("#review-checked").checked,
    }).then(async (response) => {
      if (response.kind !== "event") throw new Error("Expected saved event resolution");
      detail = response; renderReview(); setText("#review-saved", t("saved"));
      await loadSites(); await runSearch();
    }).catch(showError).finally(() => { save.disabled = false; siteSelect.disabled = false; });
  });
  document.addEventListener("parking-language", () => {
    renderSites(); renderResults(); updateView();
  });
  await loadSites();
}

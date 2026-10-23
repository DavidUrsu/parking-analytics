import "./style.css";
import "./analysis.css";
import { analysisRequest } from "./analysis-client";
import type { AnalysisJob } from "./analysis-types";
import { isKey, text, type Key } from "./i18n";
import { countsAt, parseBundle, sampleAt } from "./replay";
import type {
  Bundle, Language, Method, Point, Reference, ReferenceClip, ReplayClip, Split,
} from "./types";

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing viewer element: ${selector}`);
  return result;
}

element("#app").innerHTML = `
  <header>
    <div>
      <div class="eyebrow" data-i18n="eyebrow"></div>
      <h1 data-i18n="title"></h1>
      <p class="intro" data-i18n="intro"></p>
    </div>
    <label class="language"><span data-i18n="language"></span>
      <select id="language" aria-label="Language"><option value="en">English</option><option value="ro">Rom\u00e2n\u0103</option></select>
    </label>
  </header>
  <div id="error" class="banner error" role="alert" hidden></div>
  <div id="synthetic" class="banner" data-i18n="synthetic" hidden></div>
  <div class="badge" id="review-status"></div>
  <p id="site-description" class="caption"></p>
  <main>
    <section class="panel player-panel" aria-label="Replay">
      <div class="toolbar">
        <div class="field grow"><label for="clips" data-i18n="segment"></label><select id="clips" disabled></select></div>
        <div class="field"><label for="method" data-i18n="method"></label>
          <select id="method" disabled><option value="candidate" data-i18n="candidate"></option><option value="baseline" data-i18n="baseline"></option></select>
        </div>
      </div>
      <div class="video-wrap">
        <video id="video" muted playsinline preload="metadata" aria-describedby="site-description"></video>
        <canvas id="overlay" aria-hidden="true"></canvas>
      </div>
      <div class="playback">
        <button id="play" class="primary" disabled data-i18n="play"></button>
        <input id="seek" type="range" min="0" max="1" step="0.01" value="0" disabled />
        <span class="clock" id="clock">00:00 / 00:00</span>
      </div>
      <div class="review-tools">
        <button id="previous-sample" data-i18n="previousSample" disabled></button>
        <button id="next-sample" data-i18n="nextSample" disabled></button>
        <label><span data-i18n="reviewSpeed"></span><select id="review-speed"><option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option></select></label>
      </div>
      <p id="recording-utc" class="caption" hidden></p>
      <div id="zone-readings" class="zone-readings"></div>
      <div class="layer-controls">
        <label class="check"><input id="boxes" type="checkbox" checked /><span data-i18n="boxes"></span></label>
        <label class="check"><input id="trails" type="checkbox" checked /><span data-i18n="trails"></span></label>
        <label class="check"><input id="reference-overlay" type="checkbox" /><span data-i18n="referenceOverlay"></span></label>
      </div>
      <div class="legend">
        <span data-i18n="legendVehicles"></span><span data-i18n="legendBoundary"></span><span data-i18n="legendUnknown"></span>
      </div>
      <div class="status" id="media-status" role="status"></div>
    </section>
    <section class="stats" aria-label="Current observations">
      <div class="stat"><div class="stat-label" data-i18n="observed"></div><output id="observed">—</output><small id="observation-state"></small><small data-i18n="zoneHelp"></small></div>
      <div class="stat unknown"><div class="stat-label" data-i18n="capacity"></div><output data-i18n="unknown"></output><small data-i18n="unknownCapacity"></small></div>
      <div class="stat"><div class="stat-label" data-i18n="entries"></div><output id="entries">—</output><small data-i18n="boundaryHelp"></small></div>
      <div class="stat"><div class="stat-label" data-i18n="exits"></div><output id="exits">—</output></div>
    </section>
    <div class="columns">
      <div class="stack">
        <section class="panel"><h2 data-i18n="evidence"></h2>
          <div class="field"><label for="split" data-i18n="split"></label><select id="split"><option value="held_out" data-i18n="held_out"></option><option value="development" data-i18n="development"></option></select></div>
          <div id="metrics" class="scroll-table" tabindex="0" role="region"></div>
          <details><summary data-i18n="flowMetrics"></summary><p id="flow-method" class="caption"></p><div id="flow-metrics" class="scroll-table" tabindex="0" role="region"></div></details>
          <p id="incomplete" class="caption" data-i18n="incomplete" hidden></p>
          <p class="caption" data-i18n="referenceText"></p>
        </section>
        <section class="panel"><h2 data-i18n="crossings"></h2><div id="crossings" class="moments"></div></section>
      </div>
      <section class="panel"><h2 data-i18n="review"></h2>
        <label class="field"><span data-i18n="reviewFilter"></span><select id="review-filter">
          <option value="all" data-i18n="allMoments"></option><option value="low_confidence" data-i18n="low_confidence"></option>
          <option value="reference_disagreement" data-i18n="reference_disagreement"></option><option value="confirmed_error" data-i18n="confirmed_error"></option>
        </select></label><div id="moments" class="moments op-gap"></div>
        <p class="caption" id="reference-now"></p>
      </section>
    </div>
    <section class="panel reference-panel" id="reference-panel" hidden>
      <h2 data-i18n="referenceTitle"></h2><p class="caption" data-i18n="referenceTip"></p>
      <div id="reference-dirty" class="banner" data-i18n="referenceChanges" hidden></div>
      <div class="reference-controls">
        <div class="field"><label for="snapshot" data-i18n="snapshot"></label><select id="snapshot"></select></div>
        <div class="field"><label for="reference-zone" data-i18n="zone"></label><select id="reference-zone"></select></div>
        <div class="field"><label for="reference-count" data-i18n="count"></label><input id="reference-count" type="number" min="0" step="1" /></div>
        <div class="field wide"><label for="reference-notes" data-i18n="notes"></label><textarea id="reference-notes"></textarea></div>
      </div>
      <h3 data-i18n="events"></h3><div id="event-editor" class="event-editor"></div>
      <button id="add-event" data-i18n="addEvent"></button>
      <div class="review-checks">
        <label class="check"><input id="events-complete" type="checkbox" /><span data-i18n="eventsComplete"></span></label>
        <label class="check"><input id="human-reviewed" type="checkbox" /><span data-i18n="humanReview"></span></label>
      </div>
      <button id="download-reference" class="primary" data-i18n="downloadReference"></button>
      <p class="caption" id="reference-message" role="status"></p>
    </section>
    <details class="panel"><summary data-i18n="methodology"></summary>
      <div class="method-copy"><p data-i18n="methodologyText"></p><p data-i18n="baselineText"></p>
        <p id="staged" data-i18n="staged"></p><p data-i18n="publication"></p>
      </div>
      <dl id="provenance"></dl>
      <a id="raw-bundle" target="_blank" rel="noopener" data-i18n="rawBundle"></a>
    </details>
  </main>
  <footer data-i18n="publication"></footer>
`;

let language: Language = document.documentElement.lang === "ro" ? "ro" : "en";
let method: Method = "candidate";
let data: Bundle | null = null;
let current: ReplayClip | null = null;
let draft: Reference | null = null;
let draftDirty = false;
let mediaReady = false;
let request = 0;
let controller: AbortController | null = null;
let objectURL: string | null = null;
let animation = 0;
let recordingJob: AnalysisJob | null = null;
let privateReplay = false;
let serverVerified = false;
const video = element<HTMLVideoElement>("#video");
const canvas = element<HTMLCanvasElement>("#overlay");
const context = canvas.getContext("2d");
if (!context) {
  element("#error").textContent = "Canvas rendering is unavailable in this browser.";
  element("#error").hidden = false;
  throw new Error("Canvas rendering is unavailable");
}
const ctx = context;
const seek = element<HTMLInputElement>("#seek");
const play = element<HTMLButtonElement>("#play");
const clipSelect = element<HTMLSelectElement>("#clips");
element<HTMLSelectElement>("#language").value = language;
let bundleURL: URL;

function t(key: Key): string { return text(key, language); }
function setText(selector: string, value: string): void {
  const node = element(selector);
  if (node.textContent !== value) node.textContent = value;
}
function clock(time: number): string {
  return `${Math.floor(time / 60).toString().padStart(2, "0")}:${(time % 60).toFixed(1).padStart(4, "0")}`;
}
function number(value: number | null, percent = false): string {
  if (value === null) return t("notMeasured");
  return new Intl.NumberFormat(language, {
    maximumFractionDigits: percent ? 1 : 3,
    ...(percent ? { style: "percent" } : {}),
  }).format(value);
}
function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value; node.textContent = label;
  return node;
}
function showError(error: unknown): void {
  video.pause();
  mediaReady = false;
  const message = error instanceof Error ? error.message : String(error);
  setText("#error", `${t("error")} ${message} ${t(privateReplay ? "privateNoData" : "noData")}`);
  element("#error").hidden = false;
  play.disabled = true; seek.disabled = true;
  for (const id of ["previous-sample", "next-sample"]) element<HTMLButtonElement>(`#${id}`).disabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setText("#zone-readings", "");
  element("#recording-utc").hidden = true;
  for (const id of ["observed", "entries", "exits"]) setText(`#${id}`, t("unknown"));
}

function translate(): void {
  document.documentElement.lang = language;
  document.title = `Parking | ${t("evidence")}`;
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (!key || !isKey(key)) throw new Error(`Unknown UI translation: ${key}`);
    node.textContent = t(key);
  }
  seek.setAttribute("aria-label", t("seek"));
  video.setAttribute("aria-label", t("segment"));
  element("#language").setAttribute("aria-label", t("language"));
  element("#metrics").setAttribute("aria-label", t("evidence"));
  element("#flow-metrics").setAttribute("aria-label", t("flowMetrics"));
  if (mediaReady) setText("#media-status", t(serverVerified ? "streamReady" : "ready"));
  if (!data) return;
  const selected = current?.id ?? data.clips[0]?.id;
  clipSelect.replaceChildren(...data.clips.map(
    (clip) => option(clip.id, `${clip.name[language]} · ${t(clip.split)}`),
  ));
  if (selected) clipSelect.value = selected;
  element("#synthetic").hidden = !data.synthetic;
  setText("#synthetic", t(data.run.device === "synthetic" ? "synthetic" : "syntheticInput"));
  element("#staged").hidden = privateReplay || data.synthetic || !data.attribution.staged_scenarios;
  setText("#review-status", t(!data.reference ? "unverifiedObservations"
    : data.reference.review_status === "reviewed" ? "reviewed" : "provisional"));
  if (privateReplay) {
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n=publication]")) node.textContent = t("privatePublication");
    for (const node of document.querySelectorAll<HTMLElement>("[data-i18n=referenceText]")) node.textContent = t("noReference");
  }
  setText("#site-description", data.site.description[language]);
  renderMetrics(); renderProvenance(); renderLists(); renderReference();
  renderAt(video.currentTime);
}

function path(points: Point[], close = false): void {
  ctx.beginPath();
  for (const [index, point] of points.entries()) {
    const x = point[0] * canvas.width, y = point[1] * canvas.height;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (close) ctx.closePath();
}

function currentReference(): ReferenceClip | undefined {
  return draft?.clips.find((clip) => clip.clip_id === current?.id);
}

function renderAt(time: number): void {
  if (!data || !current || !mediaReady) return;
  if (video.seeking) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const id of ["observed", "entries", "exits"]) setText(`#${id}`, t("unknown"));
    return;
  }
  const analysis = current[method];
  const sample = sampleAt(analysis, time, data.stale_after_s);
  const observed = sample?.zones[0];
  setText("#observed", observed?.vehicle_count === null || !observed
    ? t("unknown") : String(observed.vehicle_count));
  setText("#observation-state", !observed ? t("noObservation")
    : observed.state === "unknown" ? t("confirmationPending")
      : `${sample?.time_s.toFixed(2)} s · ${observed.unconfirmed_count} ${t("tentative")}`);
  const counts = countsAt(analysis, time);
  setText("#entries", String(counts.in)); setText("#exits", String(counts.out));
  setText("#clock", `${clock(time)} / ${clock(current.duration_s)}`);
  const zones = data.site.zones.map((zone) => {
    const observation = sample?.zones.find((item) => item.zone_id === zone.id);
    return `${zone.name[language]}: ${observation?.vehicle_count ?? t("unknown")}`;
  });
  setText("#zone-readings", zones.join(" · "));
  element("#recording-utc").hidden = !recordingJob;
  if (recordingJob) {
    const utc = new Date(Date.parse(recordingJob.clock.start_utc) + (current.source_start_s + time) * 1000).toISOString();
    setText("#recording-utc", `${t("recordingTime")}: ${utc} · ${t("assumedClock")}`);
  }
  seek.value = String(time);
  play.textContent = t(video.paused ? "play" : "pause");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const zone of data.site.zones) {
    const known = sample?.zones.find((value) => value.zone_id === zone.id)?.state === "observed";
    path(zone.polygon, true);
    ctx.strokeStyle = "#e9c879";
    ctx.lineWidth = 2; ctx.setLineDash(known ? [] : [7, 5]); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const gate of data.site.gates) {
    path([gate.start, gate.end]); ctx.strokeStyle = "#75d8e8"; ctx.lineWidth = 3; ctx.stroke();
  }
  if (sample) {
    for (const vehicle of sample.vehicles) {
      const [x1, y1, x2, y2] = vehicle.box;
      if (vehicle.track_id !== null && element<HTMLInputElement>("#trails").checked) {
        const history = analysis.samples.filter(
          (previous) => previous.time_s <= sample.time_s && sample.time_s - previous.time_s <= 1.5,
        );
        let previousTime: number | null = null;
        ctx.beginPath();
        for (const previous of history) {
          const tracked = previous.vehicles.find((item) => item.track_id === vehicle.track_id);
          if (!tracked) { previousTime = null; continue; }
          const x = (tracked.box[0] + tracked.box[2]) / 2 * canvas.width;
          const y = tracked.box[3] * canvas.height;
          if (previousTime === null || previous.time_s - previousTime > data.stale_after_s) {
            ctx.moveTo(x, y);
          } else ctx.lineTo(x, y);
          previousTime = previous.time_s;
        }
        ctx.strokeStyle = "#a0dde4"; ctx.lineWidth = 2; ctx.stroke();
      }
      if (!element<HTMLInputElement>("#boxes").checked) continue;
      ctx.strokeStyle = "#f3cb70"; ctx.lineWidth = 2;
      ctx.setLineDash(vehicle.track_id === null ? [4, 4] : []);
      ctx.strokeRect(x1 * canvas.width, y1 * canvas.height,
        (x2 - x1) * canvas.width, (y2 - y1) * canvas.height);
      ctx.setLineDash([]);
      const label = `${vehicle.track_id === null ? "?" : `#${vehicle.track_id}`} · ${t("score")} ${vehicle.score.toFixed(2)}`;
      ctx.font = "13px system-ui";
      const y = Math.max(17, y1 * canvas.height);
      ctx.fillStyle = "#0b1118";
      ctx.fillRect(x1 * canvas.width, y - 17, ctx.measureText(label).width + 8, 18);
      ctx.fillStyle = "#ffdda0"; ctx.fillText(label, x1 * canvas.width + 4, y - 3);
    }
  }
  const reference = currentReference()?.snapshots.find(
    (snapshot) => snapshot.time_s <= time && time - snapshot.time_s < 0.25,
  );
  setText("#reference-now", reference
    ? `${t("currentReference")}: ${Object.values(reference.zone_counts).map(
      (value) => value === null ? t("unknown") : String(value),
    ).join(", ")} · ${clock(reference.time_s)} · ${t(draft?.review_status === "reviewed" ? "reviewed" : "provisional")}`
    : t("noReferenceAtTime"));
  if (reference && element<HTMLInputElement>("#reference-overlay").checked) {
    ctx.font = "15px system-ui"; ctx.fillStyle = "#152b35";
    ctx.fillRect(12, 12, Math.min(canvas.width - 24, 430), 30);
    ctx.fillStyle = "#adf0f3";
    ctx.fillText(`${t("currentReference")}: ${Object.values(reference.zone_counts).map(
      (value) => value ?? t("unknown"),
    ).join(", ")}`, 20, 32);
  }
}

function animate(): void {
  cancelAnimationFrame(animation);
  renderAt(video.currentTime);
  if (!video.paused) animation = requestAnimationFrame(animate);
}

async function waitForMedia(url: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const loaded = (): void => { cleanup(); resolve(); };
    const failed = (): void => { cleanup(); reject(new Error(t("mediaError"))); };
    const aborted = (): void => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    video.addEventListener("loadedmetadata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    video.src = url; video.load();
  });
}

async function selectClip(id: string): Promise<void> {
  if (!data) throw new Error("Replay is not loaded");
  const clip = data.clips.find((item) => item.id === id);
  if (!clip) throw new Error(`Unknown clip: ${id}`);
  const token = ++request;
  controller?.abort();
  const active = new AbortController(); controller = active;
  video.pause(); mediaReady = false;
  play.disabled = true; seek.disabled = true;
  for (const name of ["previous-sample", "next-sample"]) element<HTMLButtonElement>(`#${name}`).disabled = true;
  setText("#media-status", t("loading"));
  for (const name of ["observed", "entries", "exits"]) setText(`#${name}`, t("unknown"));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const url = new URL(clip.video, bundleURL);
  if (url.origin !== location.origin) throw new Error("Replay media must be same-origin local assets");
  try {
    serverVerified = false;
    if (recordingJob && url.pathname === `/api/analysis/jobs/${recordingJob.id}/media/recording.mp4`) {
      const response = await fetch(url, { method: "HEAD", signal: active.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`Private media request failed (${response.status})`);
      if (response.headers.get("X-Integrity-Check") !== "server-verified"
          || response.headers.get("X-Content-SHA256") !== clip.video_sha256) {
        throw new Error(`Private media SHA-256 mismatch: ${clip.id}`);
      }
      if (token !== request) return;
      if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
      await waitForMedia(url.href, active.signal);
      serverVerified = true;
    } else {
      const response = await fetch(url, { signal: active.signal });
      if (!response.ok) throw new Error(`Media request failed (${response.status}): ${clip.video}`);
      const size = Number(response.headers.get("Content-Length"));
      if (size > 64 * 1024 ** 2) throw new Error("Static clip exceeds the 64 MiB buffered-media limit");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 64 * 1024 ** 2) throw new Error("Clip exceeds the media size limit");
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== clip.video_sha256) throw new Error(`Media SHA-256 mismatch: ${clip.id}`);
      if (token !== request) return;
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
      await waitForMedia(objectURL, active.signal);
    }
    if (token !== request) return;
    if (video.videoWidth !== clip.width || video.videoHeight !== clip.height
        || Math.abs(video.duration - clip.duration_s) > 0.1) throw new Error(t("mediaError"));
    current = clip; clipSelect.value = clip.id;
    element<HTMLSelectElement>("#snapshot").value = "0";
    canvas.width = clip.width; canvas.height = clip.height;
    seek.max = String(clip.duration_s); seek.value = "0";
    video.currentTime = 0; mediaReady = true;
    play.disabled = false; seek.disabled = false;
    for (const name of ["previous-sample", "next-sample"]) element<HTMLButtonElement>(`#${name}`).disabled = false;
    element<HTMLSelectElement>("#method").disabled = false; clipSelect.disabled = false;
    element("#error").hidden = true;
    setText("#media-status", t(serverVerified ? "streamReady" : "ready"));
    renderLists(); renderReference(); renderProvenance(); renderAt(0);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (token === request) showError(error);
  }
}

function timeButton(time: number, title: string, detail = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "moment";
  const timestamp = document.createElement("time"); timestamp.textContent = clock(time);
  const body = document.createElement("span"); body.textContent = title;
  if (detail) {
    const description = document.createElement("small"); description.textContent = detail;
    body.append(description);
  }
  button.append(timestamp, body);
  button.addEventListener("click", () => {
    if (!mediaReady) return;
    video.pause(); video.currentTime = time; renderAt(time);
  });
  return button;
}

function renderLists(): void {
  if (!data || !current) return;
  const events = current[method].events;
  const log = element("#crossings");
  log.replaceChildren(...events.map((event) => {
    const gate = data?.site.gates.find((item) => item.id === event.gate_id);
    return timeButton(event.time_s, `${t(event.direction)} · ${gate?.name[language] ?? event.gate_id}`,
      `${current?.id}/${event.track_id}${recordingJob
        ? ` · ${new Date(Date.parse(recordingJob.clock.start_utc) + event.time_s * 1000).toISOString()}` : ""}`);
  }));
  if (!events.length) log.textContent = t("noEvents");
  const filter = element<HTMLSelectElement>("#review-filter").value;
  const moments = current.review_moments.filter((moment) =>
    moment.method === method && (filter === "all" || moment.kind === filter));
  const list = element("#moments");
  list.replaceChildren(...moments.map(
    (moment) => timeButton(moment.time_s, t(moment.kind), moment.details),
  ));
  if (!moments.length) list.textContent = t("noExceptions");
}

function renderMetrics(): void {
  const container = element("#metrics");
  container.replaceChildren();
  if (!data?.evaluation) { container.textContent = t("notEvaluated"); return; }
  const value = element<HTMLSelectElement>("#split").value;
  if (value !== "development" && value !== "held_out") throw new Error("Unknown evaluation split");
  const split: Split = value;
  const metrics = data.evaluation.by_split[split];
  if (!metrics) { container.textContent = t("notEvaluated"); return; }
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const key of ["method", "mae", "coverage", "exact", "n", "abstentions", "unknownReference", "f1"] satisfies Key[]) {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = t(key); head.append(th);
  }
  const body = table.createTBody();
  for (const name of ["baseline", "candidate"] satisfies Method[]) {
    const metric = metrics[name];
    if (!metric) throw new Error("Evaluation is missing a required comparison method");
    const row = body.insertRow();
    const values = [t(name), number(metric.occupancy.mean_absolute_error),
      number(metric.occupancy.coverage, true), number(metric.occupancy.exact_match_rate, true),
      String(metric.occupancy.reference_samples),
      String(metric.occupancy.abstentions), String(metric.occupancy.unknown_reference_samples),
      data.evaluation.events_complete ? number(metric.events.f1) : t("notScored")];
    for (const cell of values) row.insertCell().textContent = cell;
  }
  container.append(table);
  element("#incomplete").hidden = data.evaluation.events_complete;
  setText("#flow-method", `${t(method)} · ${t(split)}`);
  const flow = document.createElement("table");
  const flowHead = flow.createTHead().insertRow();
  const expected: Key = data.evaluation.events_complete ? "expected" : "draftExpected";
  for (const key of ["gate", "direction", "predicted", expected, "precision", "recall", "f1"] satisfies Key[]) {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = t(key); flowHead.append(th);
  }
  const flowBody = flow.createTBody();
  for (const gate of data.site.gates) {
    for (const direction of ["in", "out"] as const) {
      const group = metrics[method].event_groups[`${gate.id}/${direction}`];
      if (!group) throw new Error("Missing directional event comparison");
      const row = flowBody.insertRow();
      const scores = data.evaluation.events_complete
        ? [number(group.precision), number(group.recall), number(group.f1)]
        : [t("notScored"), t("notScored"), t("notScored")];
      for (const value of [gate.name[language], t(direction), String(group.predicted_events),
        String(group.reference_events), ...scores]) row.insertCell().textContent = value;
    }
  }
  element("#flow-metrics").replaceChildren(flow);
}

function externalLink(url: string, label: string): HTMLAnchorElement {
  const parsed = new URL(url, location.href);
  const local = /^\/api\/analysis\/videos\/[0-9a-f]{32}\/source$/.test(url);
  if (!(local && parsed.origin === location.origin) && parsed.protocol !== "https:") {
    throw new Error("Source/licence links must use HTTPS or the private source endpoint");
  }
  const link = document.createElement("a");
  link.href = parsed.href; link.target = "_blank"; link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function renderProvenance(): void {
  if (!data) return;
  const list = element("#provenance"); list.replaceChildren();
  const rows: [Key, string | HTMLElement][] = [
    ["source", externalLink(data.attribution.source_url, data.attribution.title)],
    ["license", data.attribution.license_url
      ? externalLink(data.attribution.license_url, data.attribution.license) : data.attribution.license],
    ["modifications", data.attribution.modifications],
    ["model", data.run.model_id], ["revision", data.run.model_revision],
    ["codeRevision", data.run.code_revision ?? t("uncommitted")],
    ["configHash", data.run.config_sha256],
    ["referenceHash", data.evaluation?.reference_sha256 ?? t("notMeasured")],
    ["device", `${data.run.device} / ${data.run.hardware}`],
    ["elapsed", `${data.run.elapsed_seconds.toFixed(2)} s`],
    ["command", data.run.command.join(" ")],
  ];
  if (current) {
    rows.push(["sourceFile", current.source.file],
      ["sourceOffset", `${current.source_start_s} s / ${current.source_clock}; frame ${current.source_start_frame ?? "—"}; raw PTS irregularities: ${current.source_pts_irregularities}`]);
  }
  for (const [key, value] of rows) {
    const term = document.createElement("dt"); term.textContent = t(key);
    const description = document.createElement("dd");
    if (typeof value === "string") description.textContent = value; else description.append(value);
    list.append(term, description);
  }
  element<HTMLAnchorElement>("#raw-bundle").href = bundleURL.href;
}

function markDirty(): void {
  if (!draft) throw new Error("No reference to edit");
  draft.review_status = "provisional"; draft.events_complete = false; draftDirty = true;
  element<HTMLInputElement>("#human-reviewed").checked = false;
  element<HTMLInputElement>("#events-complete").checked = false;
  element("#reference-dirty").hidden = false;
  setText("#reference-message", "");
}

function selectedSnapshot() {
  const index = Number(element<HTMLSelectElement>("#snapshot").value);
  return currentReference()?.snapshots[index];
}

function showSnapshot(): void {
  const snapshot = selectedSnapshot();
  const zone = element<HTMLSelectElement>("#reference-zone").value;
  element<HTMLInputElement>("#reference-count").value = snapshot?.zone_counts[zone]?.toString() ?? "";
  element<HTMLTextAreaElement>("#reference-notes").value = snapshot?.notes ?? "";
}

function renderReference(): void {
  if (!data || !current) return;
  const reference = currentReference();
  element("#reference-panel").hidden = !reference;
  if (!reference) return;
  const previous = element<HTMLSelectElement>("#snapshot").value;
  const selector = element<HTMLSelectElement>("#snapshot");
  selector.replaceChildren(...reference.snapshots.map(
    (snapshot, index) => option(String(index), clock(snapshot.time_s)),
  ));
  selector.value = previous !== "" && reference.snapshots[Number(previous)] ? previous : "0";
  element<HTMLSelectElement>("#reference-zone").replaceChildren(
    ...data.site.zones.map((zone) => option(zone.id, zone.name[language])),
  );
  element("#reference-dirty").hidden = !draftDirty;
  showSnapshot(); renderEventEditor();
}

function labelled(label: string, input: HTMLElement): HTMLLabelElement {
  const field = document.createElement("label"); field.className = "field";
  const title = document.createElement("span"); title.textContent = label;
  field.append(title, input); return field;
}

function renderEventEditor(): void {
  if (!data || !current) return;
  const reference = currentReference();
  const editor = element("#event-editor"); editor.replaceChildren();
  if (!reference) return;
  for (const event of reference.events) {
    const row = document.createElement("div"); row.className = "event-row";
    const time = document.createElement("input");
    time.type = "number"; time.min = "0"; time.max = String(current.duration_s - 0.001);
    time.step = "0.001"; time.required = true; time.value = String(event.time_s);
    const gate = document.createElement("select");
    gate.append(...data.site.gates.map((item) => option(item.id, item.name[language])));
    gate.value = event.gate_id;
    const direction = document.createElement("select");
    direction.append(option("in", t("in")), option("out", t("out"))); direction.value = event.direction;
    const remove = document.createElement("button"); remove.textContent = t("remove");
    time.addEventListener("change", () => {
      if (!time.reportValidity() || !Number.isFinite(time.valueAsNumber)) return;
      event.time_s = time.valueAsNumber; markDirty();
    });
    gate.addEventListener("change", () => { event.gate_id = gate.value; markDirty(); });
    direction.addEventListener("change", () => {
      if (direction.value !== "in" && direction.value !== "out") throw new Error("Invalid direction");
      event.direction = direction.value; markDirty();
    });
    remove.addEventListener("click", () => {
      reference.events.splice(reference.events.indexOf(event), 1); markDirty(); renderEventEditor();
    });
    row.append(labelled(t("eventTime"), time), labelled(t("gate"), gate),
      labelled(t("direction"), direction), remove);
    editor.append(row);
    if (event.notes) {
      const notes = document.createElement("small"); notes.textContent = event.notes; editor.append(notes);
    }
  }
}

function downloadReference(): void {
  if (!draft) throw new Error(t("noReference"));
  const complete = element<HTMLInputElement>("#events-complete").checked;
  const human = element<HTMLInputElement>("#human-reviewed").checked;
  if (human && !complete) { setText("#reference-message", t("reviewRequired")); return; }
  const exported = structuredClone(draft);
  exported.events_complete = complete;
  exported.review_status = human && complete ? "reviewed" : "provisional";
  for (const clip of exported.clips) clip.events.sort((a, b) => a.time_s - b.time_s);
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2) + "\n"],
    { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = `reference-${exported.review_status}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setText("#reference-message", t("referenceDownloaded"));
}

play.addEventListener("click", () => {
  if (video.paused) video.play().catch(showError); else video.pause();
});
video.addEventListener("play", animate);
video.addEventListener("error", () => {
  if (mediaReady) showError(new Error(t("mediaError")));
});
video.addEventListener("seeking", () => renderAt(video.currentTime));
for (const event of ["pause", "seeked", "timeupdate", "ended"]) {
  video.addEventListener(event, () => renderAt(video.currentTime));
}
seek.addEventListener("input", () => {
  video.pause(); video.currentTime = Number(seek.value); renderAt(video.currentTime);
});
clipSelect.addEventListener("change", () => { selectClip(clipSelect.value).catch(showError); });
element<HTMLSelectElement>("#method").addEventListener("change", (event) => {
  const value = (event.currentTarget instanceof HTMLSelectElement) ? event.currentTarget.value : "";
  if (value !== "baseline" && value !== "candidate") { showError(new Error("Invalid method")); return; }
  method = value; renderLists(); renderMetrics(); renderAt(video.currentTime);
});
element<HTMLSelectElement>("#language").addEventListener("change", (event) => {
  const value = (event.currentTarget instanceof HTMLSelectElement) ? event.currentTarget.value : "";
  if (value !== "en" && value !== "ro") { showError(new Error("Invalid language")); return; }
  language = value; translate();
});
for (const name of ["boxes", "trails", "reference-overlay"]) {
  element<HTMLInputElement>(`#${name}`).addEventListener("change", () => renderAt(video.currentTime));
}
element("#split").addEventListener("change", renderMetrics);
element("#review-filter").addEventListener("change", renderLists);
element("#review-speed").addEventListener("change", () => {
  const value = Number(element<HTMLSelectElement>("#review-speed").value);
  if (![0.25, 0.5, 1, 2].includes(value)) { showError(new Error("Invalid review playback speed")); return; }
  video.playbackRate = value;
});
for (const direction of ["previous", "next"] as const) {
  element(`#${direction}-sample`).addEventListener("click", () => {
    if (!current || !mediaReady) return;
    const samples = current[method].samples;
    const sample = direction === "next"
      ? samples.find((item) => item.time_s > video.currentTime + 0.0001)
      : [...samples].reverse().find((item) => item.time_s < video.currentTime - 0.0001);
    if (sample) { video.pause(); video.currentTime = sample.time_s; renderAt(sample.time_s); }
  });
}
element("#snapshot").addEventListener("change", () => {
  showSnapshot();
  const snapshot = selectedSnapshot();
  if (snapshot && mediaReady) { video.pause(); video.currentTime = snapshot.time_s; renderAt(snapshot.time_s); }
});
element("#reference-zone").addEventListener("change", showSnapshot);
element<HTMLInputElement>("#reference-count").addEventListener("change", (event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || !input.reportValidity()) return;
  const snapshot = selectedSnapshot();
  if (!snapshot) return;
  const value = input.value === "" ? null : input.valueAsNumber;
  if (value !== null && !Number.isFinite(value)) { input.reportValidity(); return; }
  snapshot.zone_counts[element<HTMLSelectElement>("#reference-zone").value] = value;
  markDirty(); renderAt(video.currentTime);
});
element<HTMLTextAreaElement>("#reference-notes").addEventListener("change", () => {
  const snapshot = selectedSnapshot();
  if (snapshot) { snapshot.notes = element<HTMLTextAreaElement>("#reference-notes").value; markDirty(); }
});
element("#add-event").addEventListener("click", () => {
  const reference = currentReference(), gate = data?.site.gates[0];
  if (!reference || !gate || !mediaReady) return;
  reference.events.push({
    time_s: Math.min(Math.round(video.currentTime * 10) / 10, Math.max(0, video.duration - 0.001)),
    gate_id: gate.id, direction: "in", notes: "",
  });
  markDirty(); renderEventEditor();
});
element("#download-reference").addEventListener("click", downloadReference);
window.addEventListener("beforeunload", (event) => {
  if (draftDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  if (objectURL) URL.revokeObjectURL(objectURL);
});

async function load(): Promise<void> {
  translate(); setText("#media-status", t("loading"));
  bundleURL = new URL(
    new URLSearchParams(location.search).get("bundle") ?? "/demo/bundle.json", location.href,
  );
  if (bundleURL.origin !== location.origin) throw new Error("Only same-origin replay bundles are supported");
  const privateJobId = bundleURL.pathname.match(/^\/api\/analysis\/jobs\/([0-9a-f]{32})\/bundle$/)?.[1];
  privateReplay = privateJobId !== undefined;
  if (privateJobId) {
    const response = await analysisRequest(`jobs/${privateJobId}`);
    if (response.kind !== "analysis_job" || response.job.status !== "succeeded") throw new Error("Private job is not a completed result");
    recordingJob = response.job;
  }
  const response = await fetch(bundleURL, { cache: privateReplay ? "no-store" : "default" });
  if (!response.ok) throw new Error(`Replay request failed (${response.status})`);
  const payload: unknown = await response.json();
  data = parseBundle(payload);
  draft = data.reference ? structuredClone(data.reference) : null;
  translate();
  const first = data.clips[0];
  if (!first) throw new Error("Replay has no clips");
  await selectClip(first.id);
}

load().catch(showError);

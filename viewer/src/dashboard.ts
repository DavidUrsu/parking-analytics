import { analysisRequest } from "./analysis-client";
import type { AnalysisJob, RecordingClock } from "./analysis-types";
import { dashboardText as t, translateDashboard, type DashboardKey } from "./dashboard-i18n";
import { language, opText } from "./operations-i18n";
import { element, option, setupPage, showError } from "./operations-ui";
import { countsAt, parseBundle, sampleAt } from "./replay";
import { loadReplayMedia, type ReplayMedia } from "./replay-media";
import type { Bundle, LocalText, Point, ReplayClip } from "./types";

type Layout = 1 | 4 | 9;
type Feed =
  | { id: string; kind: "demo"; name: LocalText; bundle: Bundle; clip: ReplayClip; url: URL }
  | { id: string; kind: "private"; name: LocalText; job: AnalysisJob };
interface WallSettings { layout: Layout; slots: (string | null)[] }
interface PlaybackOptions { playing: boolean; overlays: boolean; loop: boolean }
const STORAGE_KEY = "parking.camera-wall.v1";
const EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-3v10l-4-3M7 12h6M10 9v6"/></svg>';

function isLayout(value: unknown): value is Layout {
  return value === 1 || value === 4 || value === 9;
}

function isSettings(value: unknown): value is WallSettings {
  if (typeof value !== "object" || value === null || !("layout" in value) || !("slots" in value)) return false;
  return isLayout(value.layout) && Array.isArray(value.slots) && value.slots.length === 9
    && value.slots.every((slot: unknown) =>
      slot === null || (typeof slot === "string" && /^demo:[a-z][a-z0-9_-]*$/.test(slot)));
}

function timestamp(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function modeURL(mode: string): URL {
  const url = new URL(location.href);
  url.search = new URLSearchParams({ mode, lang: language() }).toString();
  return url;
}

class CameraTile {
  readonly root = document.createElement("article");
  private readonly select = document.createElement("select");
  private readonly video = document.createElement("video");
  private readonly canvas = document.createElement("canvas");
  private readonly stage = document.createElement("div");
  private readonly placeholder = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly badge = document.createElement("span");
  private readonly readings = document.createElement("dl");
  private readonly clock = document.createElement("span");
  private readonly review = document.createElement("a");
  private readonly toggle = document.createElement("button");
  private readonly seek = document.createElement("input");
  private readonly context: CanvasRenderingContext2D;
  private readonly resize: ResizeObserver;
  private readonly outputs = new Map<string, HTMLElement>();
  private resource: ReplayMedia | null = null;
  private controller: AbortController | null = null;
  private animation = 0;
  private clip: ReplayClip | null = null;
  private bundle: Bundle | null = null;
  private bundleURL: URL | null = null;
  private recordingClock: RecordingClock | null = null;
  private selectedId: string | null = null;
  private ready = false;
  private state: DashboardKey = "noCamera";
  private failure = "";
  private disposed = false;

  constructor(
    readonly index: number,
    private readonly options: () => PlaybackOptions,
    private readonly changed: (id: string | null) => void,
  ) {
    this.root.className = "camera-tile"; this.root.dataset.slot = String(index);
    this.root.innerHTML = `
      <div class="camera-heading"><span class="camera-number"></span></div>
      <label class="camera-selector"><span></span></label>
      <div class="camera-player"></div>
      <div class="camera-tile-actions"></div>`;
    this.badge.className = "camera-badge"; this.root.querySelector(".camera-heading")?.append(this.badge);
    this.select.id = `wall-camera-${index}`;
    this.root.querySelector(".camera-selector")?.append(this.select);
    this.stage.className = "camera-stage"; this.stage.hidden = true;
    this.video.muted = true; this.video.playsInline = true; this.video.preload = "metadata";
    this.canvas.setAttribute("aria-hidden", "true");
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    this.context = context;
    this.stage.append(this.video, this.canvas);
    this.placeholder.className = "camera-empty";
    this.placeholder.innerHTML = `${EMPTY_ICON}<strong></strong><small></small>`;
    this.root.querySelector(".camera-player")?.append(this.stage, this.placeholder);
    this.resize = new ResizeObserver(() => this.fitStage());
    this.resize.observe(this.node(".camera-player"));
    this.status.className = "tile-state"; this.status.setAttribute("role", "status");
    this.readings.className = "camera-readings";
    const transport = document.createElement("div"); transport.className = "camera-playback";
    this.toggle.type = "button";
    this.seek.type = "range"; this.seek.min = "0"; this.seek.max = "1"; this.seek.step = "0.01"; this.seek.value = "0";
    transport.append(this.toggle, this.seek);
    const actions = this.root.querySelector(".camera-tile-actions");
    if (!actions) throw new Error("Missing camera tile actions");
    actions.before(transport, this.status, this.readings); actions.append(this.clock, this.review);
    this.toggle.addEventListener("click", () => {
      if (this.video.paused) void this.play();
      else this.pause();
    });
    this.seek.addEventListener("input", () => {
      if (!this.ready || !this.clip) return;
      this.video.pause(); this.video.currentTime = this.seek.valueAsNumber; this.draw();
    });
    this.select.addEventListener("change", () => this.changed(this.select.value || null));
    this.video.addEventListener("play", () => {
      if (this.ready) { this.state = "ready"; this.renderState(); this.animate(); }
    });
    for (const event of ["pause", "ended", "seeked", "seeking", "timeupdate"]) {
      this.video.addEventListener(event, () => {
        if (!this.ready) return;
        if (this.video.ended) this.state = "ended";
        else if (this.video.paused) this.state = "paused";
        this.renderState(); this.draw();
      });
    }
    this.video.addEventListener("error", () => {
      if (this.ready) this.fail(new Error("The browser could not continue decoding this recording"));
    });
    this.translate();
  }

  private node<T extends HTMLElement>(selector: string): T {
    const node = this.root.querySelector<T>(selector);
    if (!node) throw new Error(`Missing camera tile element: ${selector}`);
    return node;
  }

  updateChoices(feeds: Feed[], selectedId: string | null): void {
    this.selectedId = selectedId;
    this.select.replaceChildren(option("", t("none")), ...feeds.map((feed) =>
      option(feed.id, `${feed.kind === "private" ? t("privateBadge") : feed.bundle.site.id} / ${feed.name[language()]}`)));
    if (selectedId && !feeds.some((feed) => feed.id === selectedId)) {
      this.select.append(option(selectedId, t("missing")));
    }
    this.select.value = selectedId ?? "";
    this.select.title = this.select.selectedOptions[0]?.textContent ?? "";
  }

  async load(feed: Feed | undefined, selectedId: string | null): Promise<void> {
    this.controller?.abort(); this.controller = null;
    this.ready = false; this.failure = ""; cancelAnimationFrame(this.animation);
    this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    this.resource?.dispose(); this.resource = null;
    this.clip = null; this.bundle = null; this.bundleURL = null; this.recordingClock = null;
    this.selectedId = selectedId;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.stage.hidden = true; this.placeholder.hidden = false;
    this.review.hidden = true; this.review.removeAttribute("href"); this.review.removeAttribute("title");
    this.readings.replaceChildren(); this.outputs.clear(); this.clock.textContent = "";
    this.badge.textContent = feed ? t(feed.kind === "private" ? "privateBadge" : "recorded") : "";
    this.state = feed ? "loading" : selectedId ? "missing" : "noCamera";
    this.renderState();
    if (!feed) return;
    const active = new AbortController(); this.controller = active;
    try {
      let bundle: Bundle, clip: ReplayClip, url: URL;
      let recordingClock: RecordingClock | null = null;
      if (feed.kind === "demo") {
        bundle = feed.bundle; clip = feed.clip; url = feed.url;
      } else {
        const jobResponse = await analysisRequest(`jobs/${feed.job.id}`, undefined, active.signal);
        if (jobResponse.kind !== "analysis_job" || jobResponse.job.status !== "succeeded") {
          throw new Error("The private analysis is not a completed result");
        }
        url = new URL(`/api/analysis/jobs/${feed.job.id}/bundle`, location.href);
        const response = await fetch(url, { signal: active.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Private replay request failed (${response.status})`);
        bundle = parseBundle(await response.json());
        const first = bundle.clips[0];
        if (!first) throw new Error("Private analysis has no replay clip");
        clip = first; recordingClock = jobResponse.job.clock;
      }
      const resource = await loadReplayMedia(this.video, clip, url, active.signal);
      if (active.signal.aborted || this.disposed) { resource.dispose(); return; }
      this.resource = resource; this.clip = clip; this.bundle = bundle; this.bundleURL = url;
      this.recordingClock = recordingClock;
      this.canvas.width = clip.width; this.canvas.height = clip.height;
      this.stage.hidden = false; this.placeholder.hidden = true;
      this.fitStage();
      this.badge.textContent = t(bundle.synthetic ? "syntheticBadge" : feed.kind === "private" ? "privateBadge" : "recorded");
      this.badge.title = t("noReference");
      for (const zone of bundle.site.zones) this.addReading(zone.id, zone.name[language()]);
      this.addReading("wall:in", t("entries")); this.addReading("wall:out", t("exits"));
      this.ready = true; this.state = "paused"; this.video.loop = this.options().loop;
      this.seek.max = String(clip.duration_s); this.seek.value = "0";
      this.review.hidden = false; this.translate(); this.draw();
      if (this.options().playing) await this.play();
    } catch (error) {
      if (active.signal.aborted || this.disposed) return;
      this.fail(error);
    }
  }

  private addReading(id: string, label: string): void {
    const group = document.createElement("div"); group.className = "camera-reading";
    const term = document.createElement("dt"); term.textContent = label;
    const value = document.createElement("dd"); value.textContent = t("unknown"); value.dataset.reading = id;
    group.append(term, value); this.readings.append(group); this.outputs.set(id, value);
  }

  private fitStage(): void {
    if (!this.clip) return;
    const bounds = this.node(".camera-player").getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const ratio = this.clip.width / this.clip.height, viewport = bounds.width / bounds.height;
    const width = Math.min(1, ratio / viewport) * 100;
    const height = Math.min(1, viewport / ratio) * 100;
    Object.assign(this.stage.style, {
      width: `${width}%`, height: `${height}%`, left: `${(100 - width) / 2}%`, top: `${(100 - height) / 2}%`,
    });
  }

  private fail(error: unknown): void {
    this.ready = false; this.state = "failed";
    this.failure = error instanceof Error ? error.message : String(error);
    this.video.pause(); cancelAnimationFrame(this.animation);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const value of this.outputs.values()) value.textContent = t("unknown");
    this.review.hidden = true; this.stage.hidden = true; this.placeholder.hidden = false;
    this.renderState();
  }

  private renderState(): void {
    this.root.dataset.state = this.state;
    const message = `${t(this.state)}${this.failure ? `: ${this.failure}` : ""}`;
    if (this.status.textContent !== message) this.status.textContent = message;
    this.toggle.disabled = !this.ready; this.seek.disabled = !this.ready;
    const pause = this.ready && !this.video.paused;
    this.toggle.setAttribute("aria-label", `${t(pause ? "pauseRecording" : "playRecording")} ${this.index + 1}`);
    this.toggle.title = t(pause ? "pauseRecording" : "playRecording");
    const icon = pause ? '<path d="M8 5v14M16 5v14" stroke-width="3"/>' : '<path d="m8 5 11 7-11 7Z" fill="currentColor"/>';
    this.toggle.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">${icon}</svg>`;
    this.node("strong").textContent = t(this.state === "noCamera" ? "emptySlot" : this.state);
    this.node("small").textContent = this.failure || t("emptyHelp");
  }

  translate(): void {
    this.node(".camera-number").textContent = `${t("slot")} ${this.index + 1}`;
    this.node(".camera-selector > span").textContent = t("choose");
    this.select.setAttribute("aria-label", `${t("choose")} ${this.index + 1}`);
    this.video.setAttribute("aria-label", `${t("recorded")} ${this.index + 1}`);
    this.seek.setAttribute("aria-label", `${t("clipTime")} ${this.index + 1}`);
    this.review.textContent = t("review");
    if (!this.bundle) this.badge.textContent = this.selectedId
      ? t(this.selectedId.startsWith("private:") ? "privateBadge" : "recorded") : "";
    else {
      this.badge.textContent = t(this.bundle.synthetic ? "syntheticBadge" : this.recordingClock ? "privateBadge" : "recorded");
      for (const zone of this.bundle.site.zones) {
        const output = this.outputs.get(zone.id);
        if (output?.previousElementSibling) output.previousElementSibling.textContent = zone.name[language()];
      }
      for (const [id, key] of [["wall:in", "entries"], ["wall:out", "exits"]] as const) {
        const output = this.outputs.get(id);
        if (output?.previousElementSibling) output.previousElementSibling.textContent = t(key);
      }
    }
    this.renderState(); this.draw();
  }

  private line(points: Point[], close = false): void {
    this.context.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (!index) this.context.moveTo(x * this.canvas.width, y * this.canvas.height);
      else this.context.lineTo(x * this.canvas.width, y * this.canvas.height);
    }
    if (close) this.context.closePath();
    this.context.stroke();
  }

  draw(): void {
    const ctx = this.context, clip = this.clip, bundle = this.bundle;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.ready || !clip || !bundle) return;
    const at = this.video.currentTime;
    this.clock.textContent = `${timestamp(at)} / ${timestamp(clip.duration_s)}`;
    this.seek.value = String(at);
    const review = modeURL("evidence");
    review.searchParams.set("bundle", this.bundleURL?.pathname ?? "");
    review.searchParams.set("clip", clip.id);
    review.searchParams.set("at", String(Math.min(Math.max(0, clip.duration_s - 0.001), at).toFixed(3)));
    this.review.href = review.href;
    this.review.title = this.recordingClock
      ? `${new Date(Date.parse(this.recordingClock.start_utc) + at * 1000).toISOString()} / 1x`
      : t("review");
    if (this.video.seeking) {
      for (const output of this.outputs.values()) output.textContent = t("unknown");
      return;
    }
    const sample = sampleAt(clip.candidate, at, bundle.stale_after_s);
    for (const zone of bundle.site.zones) {
      const output = this.outputs.get(zone.id);
      if (output) output.textContent = String(sample?.zones.find((item) => item.zone_id === zone.id)?.vehicle_count ?? t("unknown"));
    }
    const counts = countsAt(clip.candidate, at);
    for (const direction of ["in", "out"] as const) {
      const output = this.outputs.get(`wall:${direction}`);
      if (output) output.textContent = String(counts[direction]);
    }
    if (!this.options().overlays) return;
    ctx.lineWidth = Math.max(2, clip.width / 360);
    ctx.strokeStyle = "#efc16a";
    for (const zone of bundle.site.zones) {
      ctx.setLineDash(sample ? [] : [10, 7]); this.line(zone.polygon, true);
    }
    ctx.setLineDash([]); ctx.strokeStyle = "#75d8e8";
    for (const gate of bundle.site.gates) this.line([gate.start, gate.end]);
    if (!sample) return;
    const font = Math.max(14, clip.width / 38);
    ctx.font = `${font}px system-ui`;
    for (const vehicle of sample.vehicles) {
      const [x1, y1, x2, y2] = vehicle.box;
      ctx.strokeStyle = "#f3cb70"; ctx.setLineDash(vehicle.track_id === null ? [8, 6] : []);
      ctx.strokeRect(x1 * clip.width, y1 * clip.height, (x2 - x1) * clip.width, (y2 - y1) * clip.height);
      ctx.setLineDash([]);
      const label = vehicle.track_id === null ? "?" : `#${vehicle.track_id}`;
      const y = Math.max(font, y1 * clip.height);
      ctx.fillStyle = "#101923"; ctx.fillRect(x1 * clip.width, y - font, ctx.measureText(label).width + 8, font * 1.15);
      ctx.fillStyle = "#ffdda0"; ctx.fillText(label, x1 * clip.width + 4, y - 2);
    }
  }

  private animate(): void {
    cancelAnimationFrame(this.animation); this.draw();
    if (this.ready && !this.video.paused) this.animation = requestAnimationFrame(() => this.animate());
  }

  async play(): Promise<void> {
    if (!this.ready) return;
    try { await this.video.play(); }
    catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.state = "blocked"; this.renderState();
      } else if (!(error instanceof DOMException) || error.name !== "AbortError") this.fail(error);
    }
  }

  pause(): void { this.video.pause(); }

  updateOptions(): void {
    this.video.loop = this.options().loop; this.draw();
  }

  dispose(): void {
    this.disposed = true; this.ready = false; this.controller?.abort();
    this.resize.disconnect();
    cancelAnimationFrame(this.animation); this.video.pause();
    this.video.removeAttribute("src"); this.video.load(); this.resource?.dispose();
    this.root.remove();
  }
}

export async function mountDashboard(): Promise<void> {
  setupPage("dashboardTitle", "dashboardIntro", `
    <div class="recorded-note"><span class="recorded-label" data-dashboard="recorded"></span><span data-dashboard="recordedNote"></span></div>
    <div id="wall-load-error" class="banner error" role="alert" hidden></div>
    <div class="wall-toolbar">
      <div class="wall-toolbar-group"><span class="toolbar-label" data-dashboard="layout"></span><div class="layout-buttons" id="wall-layouts" role="group">
        <button type="button" data-layout="1">1 x 1</button><button type="button" data-layout="4">2 x 2</button><button type="button" data-layout="9">3 x 3</button>
      </div></div>
      <div class="wall-toolbar-group"><button id="wall-play" type="button" data-dashboard="playAll"></button><button id="wall-pause" type="button" data-dashboard="pauseAll"></button></div>
    </div>
    <details class="wall-options"><summary data-dashboard="options"></summary><div class="wall-options-body">
      <div class="wall-toolbar-group"><label class="check"><input id="wall-overlays" type="checkbox" checked /><span data-dashboard="overlays"></span></label>
        <label class="check"><input id="wall-loop" type="checkbox" checked /><span data-dashboard="loop"></span></label></div>
      <label class="check op-gap"><input id="wall-private" type="checkbox" /><span data-dashboard="private"></span></label>
      <p class="caption" data-dashboard="privateHelp"></p><p id="wall-private-status" class="caption" role="status"></p>
      <div class="wall-options-actions"><button id="wall-refresh" type="button" data-dashboard="refresh"></button><button id="wall-reset" type="button" data-dashboard="reset"></button></div>
      <p id="wall-preferences-status" class="caption" role="status" hidden></p>
    </div></details>
    <p id="wall-catalogue" class="wall-catalogue"></p>
    <section id="camera-grid" class="camera-grid" aria-label="Recorded camera wall"></section>
    <p class="wall-model-note" data-dashboard="modelNote"></p>
    <section class="dashboard-tools"><h2 data-dashboard="tools"></h2><p data-dashboard="toolsIntro"></p><div id="dashboard-tools" class="dashboard-tool-grid"></div></section>
    <details class="dashboard-about"><summary data-dashboard="about"></summary>
      <p data-dashboard="recordedHelp"></p><p data-dashboard="aboutPrivacy"></p><p data-dashboard="aboutEvidence"></p>
      <div id="dashboard-attribution" class="dashboard-attribution"></div>
    </details>
  `);
  let feeds: Feed[] = [];
  let settings: WallSettings = { layout: 4, slots: Array.from({ length: 9 }, () => null) };
  let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let overlays = true, loop = true, disposed = false;
  let preferencesMessage: DashboardKey | null = null;
  let privateMessage: DashboardKey | null = null;
  let demoError: DashboardKey | null = null;
  let demoDetails = "";
  let refreshing = false;
  const tiles = new Map<number, CameraTile>();
  const grid = element("#camera-grid");
  const controller = new AbortController();

  function defaultSettings(): WallSettings {
    const demo = feeds.filter((feed) => feed.kind === "demo");
    return { layout: 4, slots: Array.from({ length: 9 }, (_, index) => demo[index]?.id ?? null) };
  }

  function saveSettings(): void {
    const persisted: WallSettings = {
      layout: settings.layout,
      slots: settings.slots.map((slot) => slot?.startsWith("demo:") ? slot : null),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      preferencesMessage = null;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      preferencesMessage = "presetUnavailable";
    }
    renderNotices();
  }

  function restoreSettings(): void {
    let raw: string | null;
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch (error) {
      if (!(error instanceof DOMException)) throw error;
      preferencesMessage = "presetUnavailable"; return;
    }
    if (raw === null) return;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      preferencesMessage = "presetInvalid"; return;
    }
    if (!isSettings(value)) { preferencesMessage = "presetInvalid"; return; }
    settings = value;
  }

  function renderNotices(): void {
    element("#wall-preferences-status").hidden = !preferencesMessage;
    element("#wall-preferences-status").textContent = preferencesMessage ? t(preferencesMessage) : "";
    element("#wall-private-status").textContent = privateMessage ? t(privateMessage) : "";
    element("#wall-load-error").hidden = !demoError;
    element("#wall-load-error").textContent = demoError ? `${t(demoError)}${demoDetails ? ` ${demoDetails}` : ""}` : "";
  }

  function renderGrid(): void {
    grid.dataset.layout = String(settings.layout);
    for (const node of document.querySelectorAll<HTMLButtonElement>("#wall-layouts button")) {
      node.setAttribute("aria-pressed", String(Number(node.dataset.layout) === settings.layout));
    }
    for (const [index, tile] of tiles) {
      if (index >= settings.layout) { tile.dispose(); tiles.delete(index); }
    }
    for (let index = 0; index < settings.layout; index++) {
      let tile = tiles.get(index);
      if (!tile) {
        tile = new CameraTile(index, () => ({ playing, overlays, loop }), (id) => {
          settings.slots[index] = id; saveSettings();
          const current = tiles.get(index);
          current?.updateChoices(feeds, id);
          void current?.load(feeds.find((feed) => feed.id === id), id);
        });
        tiles.set(index, tile); grid.append(tile.root);
        const id = settings.slots[index] ?? null;
        tile.updateChoices(feeds, id);
        void tile.load(feeds.find((feed) => feed.id === id), id);
      }
    }
  }

  function updateChoices(): void {
    element("#wall-catalogue").textContent = `${feeds.length} ${t("catalogue")}`;
    for (const [index, tile] of tiles) tile.updateChoices(feeds, settings.slots[index] ?? null);
  }

  async function demoFeeds(): Promise<void> {
    const url = new URL("/demo/bundle.json", location.href);
    const response = await fetch(url, { signal: controller.signal, cache: "no-cache" });
    if (response.status === 404) {
      demoError = "emptyDemo"; demoDetails = "";
      feeds = feeds.filter((feed) => feed.kind !== "demo"); return;
    }
    if (!response.ok) throw new Error(`Demo request failed (${response.status})`);
    const bundle = parseBundle(await response.json());
    feeds = [
      ...bundle.clips.map((clip): Feed => ({ id: `demo:${clip.id}`, kind: "demo", name: clip.name, bundle, clip, url })),
      ...feeds.filter((feed) => feed.kind === "private"),
    ];
    demoError = null; demoDetails = "";
  }

  async function privateFeeds(): Promise<void> {
    privateMessage = "privateLoading"; renderNotices();
    const response = await analysisRequest("jobs", undefined, controller.signal);
    if (response.kind !== "analysis_jobs") throw new Error("Expected private analysis choices");
    feeds = [
      ...feeds.filter((feed) => feed.kind === "demo"),
      ...response.jobs.filter((job) => job.status === "succeeded").map((job): Feed => ({
        id: `private:${job.id}`, kind: "private", name: { en: job.name, ro: job.name }, job,
      })),
    ];
    privateMessage = feeds.some((feed) => feed.kind === "private") ? null : "privateEmpty";
    renderNotices();
  }

  function renderTools(): void {
    const root = element("#dashboard-tools"); root.replaceChildren();
    for (const [mode, description] of [
      ["monitoring", "monitoringHelp"], ["billing", "billingHelp"],
      ["capacity", "capacityHelp"], ["analysis", "analysisHelp"],
    ] as const) {
      const link = document.createElement("a"); link.className = "dashboard-tool";
      link.href = modeURL(mode).href; link.dataset.tool = mode;
      const title = document.createElement("strong"); title.textContent = opText(mode);
      const help = document.createElement("p"); help.textContent = t(description);
      link.append(title, help); root.append(link);
    }
  }

  function renderAttribution(): void {
    const root = element("#dashboard-attribution"); root.replaceChildren();
    const demo = feeds.find((feed) => feed.kind === "demo");
    if (!demo || demo.kind !== "demo") return;
    const attribution = demo.bundle.attribution;
    const description = document.createElement("p");
    description.textContent = `${attribution.title} / ${attribution.creator} / ${attribution.license}. ${attribution.modifications}`;
    root.append(description);
    for (const [href, label] of [[attribution.source_url, "source"], [attribution.license_url, "attribution"]] as const) {
      if (href) {
        const url = new URL(href, location.href);
        if (url.protocol !== "https:") throw new Error("Demo attribution links must use HTTPS");
        const link = document.createElement("a"); link.href = url.href; link.textContent = t(label);
        link.target = "_blank"; link.rel = "noopener noreferrer"; root.append(link);
      }
    }
  }

  function translate(): void {
    translateDashboard(); updateChoices(); renderTools(); renderAttribution(); renderNotices();
    element("#wall-layouts").setAttribute("aria-label", t("layout"));
    for (const [layout, label] of [[1, "single"], [4, "four"], [9, "nine"]] as const) {
      element(`#wall-layouts button[data-layout="${layout}"]`).setAttribute("aria-label", t(label));
    }
    grid.setAttribute("aria-label", t("recorded"));
    for (const tile of tiles.values()) tile.translate();
  }

  element("#wall-layouts").addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const layout = Number(target.dataset.layout);
    if (!isLayout(layout)) { showError(new Error("Unsupported camera layout")); return; }
    settings.layout = layout; saveSettings(); renderGrid();
  });
  element("#wall-play").addEventListener("click", () => {
    playing = true; void Promise.all([...tiles.values()].map((tile) => tile.play()));
  });
  element("#wall-pause").addEventListener("click", () => {
    playing = false; for (const tile of tiles.values()) tile.pause();
  });
  for (const id of ["wall-overlays", "wall-loop"]) {
    element(`#${id}`).addEventListener("change", () => {
      overlays = element<HTMLInputElement>("#wall-overlays").checked;
      loop = element<HTMLInputElement>("#wall-loop").checked;
      for (const tile of tiles.values()) tile.updateOptions();
    });
  }
  element("#wall-private").addEventListener("change", async () => {
    const checkbox = element<HTMLInputElement>("#wall-private");
    checkbox.disabled = true;
    try {
      if (checkbox.checked) await privateFeeds();
      else {
        feeds = feeds.filter((feed) => feed.kind === "demo");
        for (const [index, id] of settings.slots.entries()) {
          if (id?.startsWith("private:")) {
            settings.slots[index] = null; void tiles.get(index)?.load(undefined, null);
          }
        }
        privateMessage = "privacyCleared";
      }
      updateChoices(); renderNotices();
    } catch (error) {
      if (!disposed) {
        checkbox.checked = false; privateMessage = null; renderNotices(); showError(error);
      }
    } finally { checkbox.disabled = false; }
  });
  element("#wall-reset").addEventListener("click", () => {
    settings = defaultSettings(); saveSettings();
    for (const tile of tiles.values()) tile.dispose(); tiles.clear(); renderGrid();
  });
  element("#wall-refresh").addEventListener("click", async () => {
    if (refreshing) return;
    refreshing = true;
    const button = element<HTMLButtonElement>("#wall-refresh"); button.disabled = true;
    try {
      await demoFeeds();
      if (element<HTMLInputElement>("#wall-private").checked) await privateFeeds();
      for (const [index, tile] of tiles) {
        const id = settings.slots[index] ?? null;
        void tile.load(feeds.find((feed) => feed.id === id), id);
      }
      translate();
    } catch (error) {
      if (!disposed) showError(error);
    } finally { refreshing = false; button.disabled = false; }
  });
  document.addEventListener("parking-language", translate);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      playing = false;
      for (const tile of tiles.values()) tile.pause();
    }
  });
  window.addEventListener("pagehide", () => {
    disposed = true; controller.abort();
    for (const tile of tiles.values()) tile.dispose(); tiles.clear();
  }, { once: true });

  try { await demoFeeds(); }
  catch (error) {
    demoError = "failedDemo"; demoDetails = error instanceof Error ? error.message : String(error);
  }
  settings = defaultSettings(); restoreSettings(); renderGrid(); translate();
}

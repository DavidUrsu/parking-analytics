import "./analysis.css";
import { analysisRequest, uploadVideo } from "./analysis-client";
import { analysisText as t, translateAnalysis } from "./analysis-i18n";
import type { AnalysisCapabilities, AnalysisJob, CameraPreset, UploadedVideo } from "./analysis-types";
import { language } from "./operations-i18n";
import {
  button, clearError, element, option, setText, setupPage, showError,
} from "./operations-ui";
import { parseSite } from "./replay";
import type { Bundle, Point } from "./types";

export async function mountAnalysis(): Promise<void> {
  setupPage("analysis", "analysisIntro", `
    <div class="analysis-stack">
      <section class="panel">
        <h2 data-analysis="choose"></h2>
        <form id="upload-form">
          <div class="analysis-drop" id="video-drop">
            <label for="video-file" data-analysis="drop"></label>
            <input id="video-file" type="file" accept=".mp4,.mov,.avi,.webm,.mkv,video/*" />
            <p id="selected-file" class="caption"></p>
          </div>
          <div class="field"><label for="content-kind" data-analysis="inputKind"></label>
            <select id="content-kind"><option value="recording" data-analysis="recording"></option><option value="synthetic_test" data-analysis="synthetic"></option></select>
          </div>
          <div class="analysis-checks"><label class="check"><input type="checkbox" id="upload-permission" required /><span data-analysis="permission"></span></label></div>
          <button type="submit" class="primary" id="upload-button" data-analysis="import"></button>
          <button type="button" id="cancel-upload" data-analysis="cancelUpload" hidden></button>
        </form>
        <p id="analysis-status" role="status"></p><p class="caption" id="analysis-limits"></p>
      </section>
      <section class="panel">
        <h2 data-analysis="videos"></h2>
        <div class="op-source"><label class="field grow"><span data-analysis="chooseVideo"></span><select id="analysis-video"></select></label><button id="analysis-refresh" data-analysis="refresh"></button></div>
        <div id="selected-video" hidden>
          <h3 data-analysis="source"></h3><p id="video-details" class="analysis-info"></p>
          <details><summary data-analysis="source"></summary><video id="source-preview" controls muted playsinline preload="metadata"></video><p id="source-preview-error" class="caption" data-analysis="previewError" hidden></p></details>
          <button id="delete-video" class="op-gap" data-analysis="delete"></button>
        </div>
      </section>
      <form id="analysis-form">
        <fieldset id="analysis-fields" disabled class="analysis-stack">
          <section class="panel">
            <h2 data-analysis="clock"></h2><p data-analysis="metadataWarning"></p>
            <p id="timestamp-status" class="caption"></p>
            <label class="field"><span data-analysis="candidate"></span><select id="timestamp-candidate"></select></label>
            <button id="use-timestamp" type="button" class="op-gap" data-analysis="useCandidate"></button>
            <p data-analysis="burnedIn" class="caption"></p>
            <div class="field op-gap"><label for="clock-source" data-analysis="clockSource"></label><select id="clock-source"><option value="manual" data-analysis="manual"></option><option value="metadata_confirmed" data-analysis="metadataConfirmed"></option></select></div>
            <div class="field op-gap"><label for="recording-start" data-analysis="start"></label><input id="recording-start" type="text" maxlength="80" required placeholder="2026-10-22T18:00:00+03:00" autocomplete="off" /></div>
            <div class="analysis-checks"><label class="check"><input id="realtime-confirmed" type="checkbox" required /><span data-analysis="realtime"></span></label></div>
            <p class="caption" data-analysis="clockWarning"></p>
          </section>
          <section class="panel">
            <h2 data-analysis="geometry"></h2><p class="caption" data-analysis="geometryHelp" id="geometry-help"></p>
            <div class="op-source"><label class="field"><span data-analysis="tool"></span><select id="geometry-tool"><option value="zone" data-analysis="zone"></option><option value="gate" data-analysis="gate"></option></select></label>
              <button type="button" id="geometry-finish" data-analysis="finish"></button><button type="button" id="geometry-clear" data-analysis="clear"></button><button type="button" id="whole-frame" data-analysis="fullFrame"></button></div>
            <div class="geometry-frame"><canvas id="geometry-canvas" width="800" height="450" role="img" aria-describedby="geometry-help"></canvas></div>
            <ul id="geometry-shapes"></ul>
            <details><summary data-analysis="advanced"></summary><label for="geometry-json" class="caption" data-analysis="advanced"></label><textarea id="geometry-json" spellcheck="false"></textarea><button type="button" id="apply-geometry" data-analysis="applyJson"></button></details>
            <h3 data-analysis="presets"></h3><p class="caption" data-analysis="presetWarning"></p>
            <div class="op-source"><select id="camera-presets" aria-label="Saved camera presets"></select><button type="button" id="apply-preset" data-analysis="applyPreset"></button></div>
            <div class="op-source op-gap"><label class="field grow"><span data-analysis="presetName"></span><input id="preset-name" type="text" maxlength="120" /></label><button type="button" id="save-preset" data-analysis="savePreset"></button></div>
            <div class="analysis-checks"><label class="check"><input type="checkbox" id="fixed-confirmed" required /><span data-analysis="fixed"></span></label></div>
          </section>
          <section class="panel">
            <div class="op-grid">
              <label class="field"><span data-analysis="name"></span><input id="analysis-name" type="text" maxlength="120" required /></label>
              <label class="field"><span data-analysis="device"></span><select id="analysis-device"><option value="cpu" data-analysis="cpu"></option><option value="cuda" data-analysis="cuda"></option></select></label>
            </div>
            <p class="caption" data-analysis="unverified"></p><p id="missing-model" class="banner" data-analysis="missingModel" hidden></p>
            <button type="submit" id="run-analysis" class="primary op-gap" data-analysis="run"></button>
          </section>
        </fieldset>
      </form>
      <section class="panel"><h2 data-analysis="jobs"></h2><div id="analysis-jobs" class="analysis-jobs"></div></section>
      <section class="panel"><a id="benchmark-replay" data-analysis="benchmark"></a></section>
    </div>
  `);
  const header = element("h1"); header.dataset.analysis = "title"; delete header.dataset.op;
  const intro = element(".intro"); intro.dataset.analysis = "intro"; delete intro.dataset.op;
  translateAnalysis();

  let videos: UploadedVideo[] = [];
  let presets: CameraPreset[] = [];
  let selected: UploadedVideo | null = null;
  let chosenFile: File | null = null;
  let importing: AbortController | null = null;
  let disposed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let previewRequest = 0;
  let preview: HTMLImageElement | null = null;
  let pending: Point[] = [];
  let jsonDirty = false;
  let geometry: Bundle["site"] = emptyGeometry();
  let latestJobs: AnalysisJob[] = [];
  let maximumUploadBytes = 0;
  let currentLimits: AnalysisCapabilities | null = null;
  const cards = new Map<string, HTMLElement>();
  const canvas = element<HTMLCanvasElement>("#geometry-canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable");
  const context = ctx;

  function emptyGeometry(): Bundle["site"] {
    return {
      id: "camera", name: { en: "Private camera", ro: "Camera privata" },
      description: {
        en: "Operator-defined visible vehicle zones. Bay capacity/availability unknown.",
        ro: "Zone vizibile definite de operator. Capacitatea si locurile libere sunt necunoscute.",
      }, zones: [], gates: [],
    };
  }

  function act(action: () => void | Promise<void>): void {
    clearError();
    Promise.resolve().then(action).catch(showError);
  }

  function needVideo(): UploadedVideo {
    if (!selected) throw new Error(t("chooseFirst"));
    return selected;
  }

  function geometryReady(): Bundle["site"] {
    if (jsonDirty) throw new Error(t("pendingJson"));
    if (pending.length) throw new Error(t("pendingShape"));
    return parseSite(geometry);
  }

  function checkDrawing(): void {
    needVideo();
    if (jsonDirty) throw new Error(t("pendingJson"));
  }

  function drawPath(points: Point[], close = false): void {
    context.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (index === 0) context.moveTo(x * canvas.width, y * canvas.height);
      else context.lineTo(x * canvas.width, y * canvas.height);
    }
    if (close) context.closePath();
    context.stroke();
  }

  function draw(): void {
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (preview) context.drawImage(preview, 0, 0, canvas.width, canvas.height);
    context.lineWidth = 3; context.setLineDash([]); context.strokeStyle = "#efc16a";
    for (const zone of geometry.zones) drawPath(zone.polygon, true);
    context.strokeStyle = "#75d8e8";
    for (const gate of geometry.gates) {
      drawPath([gate.start, gate.end]);
      const [sx, sy] = gate.start, [ex, ey] = gate.end;
      const mx = (sx + ex) * canvas.width / 2, my = (sy + ey) * canvas.height / 2;
      const nx = -(ey - sy) * canvas.height, ny = (ex - sx) * canvas.width;
      const size = Math.hypot(nx, ny);
      if (!size) continue;
      const dx = nx / size * 32 * gate.inward_side, dy = ny / size * 32 * gate.inward_side;
      context.beginPath(); context.moveTo(mx, my); context.lineTo(mx + dx, my + dy);
      context.moveTo(mx + dx * 0.65 - dy * 0.2, my + dy * 0.65 + dx * 0.2);
      context.lineTo(mx + dx, my + dy);
      context.lineTo(mx + dx * 0.65 + dy * 0.2, my + dy * 0.65 - dx * 0.2);
      context.stroke();
    }
    context.strokeStyle = "#ffffff"; context.fillStyle = "#ffffff"; context.setLineDash([6, 4]);
    drawPath(pending);
    for (const [x, y] of pending) {
      context.beginPath(); context.arc(x * canvas.width, y * canvas.height, 5, 0, Math.PI * 2); context.fill();
    }
    context.setLineDash([]);
  }

  function syncGeometry(): void {
    element<HTMLTextAreaElement>("#geometry-json").value = JSON.stringify(geometry, null, 2);
    jsonDirty = false; draw();
    const list = element("#geometry-shapes"); list.replaceChildren();
    for (const kind of ["zones", "gates"] as const) {
      for (const shape of geometry[kind]) {
        const row = document.createElement("li");
        row.append(`${shape.name[language()]} (${shape.id})`);
        if (kind === "gates") {
          row.append(button(t("flip"), () => act(() => {
            checkDrawing();
            const gate = geometry.gates.find((item) => item.id === shape.id);
            if (!gate) throw new Error("Boundary no longer exists");
            gate.inward_side *= -1; syncGeometry();
          })));
        }
        row.append(button(t("remove"), () => act(() => {
          checkDrawing();
          if (kind === "zones") geometry.zones = geometry.zones.filter((item) => item.id !== shape.id);
          else geometry.gates = geometry.gates.filter((item) => item.id !== shape.id);
          syncGeometry();
        })));
        list.append(row);
      }
    }
  }

  function nextId(kind: "zones" | "gates"): string {
    let index = 1;
    while (geometry[kind].some((shape) => shape.id === `${kind}-${index}`)) index++;
    return `${kind}-${index}`;
  }

  function addZone(points: Point[]): void {
    if (geometry.zones.length >= 8 || points.length > 24) throw new Error("Maximum: 8 zones, 24 points each.");
    const id = nextId("zones");
    geometry.zones.push({ id, name: { en: `Zone ${geometry.zones.length + 1}`, ro: `Zona ${geometry.zones.length + 1}` }, polygon: points, capacity: null });
  }

  function finishShape(): void {
    checkDrawing();
    const tool = element<HTMLSelectElement>("#geometry-tool").value;
    if (tool === "zone" && pending.length >= 3) addZone(pending);
    else if (tool === "gate" && pending.length === 2) {
      if (geometry.gates.length >= 8) throw new Error("Maximum: 8 boundaries.");
      const start = pending[0], end = pending[1];
      if (!start || !end || (start[0] === end[0] && start[1] === end[1])) throw new Error("Boundary must have distinct endpoints.");
      const id = nextId("gates");
      geometry.gates.push({ id, name: { en: `Boundary ${geometry.gates.length + 1}`, ro: `Limita ${geometry.gates.length + 1}` }, start, end, inward_side: 1 });
    } else throw new Error(t("pendingShape"));
    pending = []; syncGeometry();
  }

  function renderVideos(): void {
    const selector = element<HTMLSelectElement>("#analysis-video");
    selector.replaceChildren(option("", t("chooseVideo")), ...videos.map(
      (video) => option(video.id, `${video.original_name} (${video.duration_s.toFixed(1)} s)`),
    ));
    selector.value = selected?.id ?? "";
  }

  function renderPresets(): void {
    element<HTMLSelectElement>("#camera-presets").replaceChildren(
      option("", t("presets")), ...presets.map((preset) => option(preset.id, `${preset.name} (${preset.width}x${preset.height})`)),
    );
  }

  function sourceLabels(): void {
    if (!selected) return;
    const video = selected;
    setText("#video-details", `${video.original_name} · ${video.width} x ${video.height} · ${video.duration_s.toFixed(3)} s · ${video.codec}\nSHA-256: ${video.sha256}\n${video.content_kind === "synthetic_test" ? t("synthetic") : t("recording")}`);
    setText("#timestamp-status", video.timestamp_candidates.some((item) => item.parsed_utc !== null) ? t("metadataWarning") : t("noTimestamp"));
  }

  function selectVideo(id: string): void {
    selected = videos.find((video) => video.id === id) ?? null;
    preview = null; previewRequest++; pending = []; geometry = emptyGeometry();
    element<HTMLFieldSetElement>("#analysis-fields").disabled = !selected;
    element("#selected-video").hidden = !selected;
    element<HTMLInputElement>("#recording-start").value = "";
    element<HTMLSelectElement>("#clock-source").value = "manual";
    element<HTMLInputElement>("#realtime-confirmed").checked = false;
    element<HTMLInputElement>("#fixed-confirmed").checked = false;
    const sourcePlayer = element<HTMLVideoElement>("#source-preview");
    sourcePlayer.pause(); sourcePlayer.removeAttribute("src"); sourcePlayer.load();
    if (!selected) { syncGeometry(); return; }
    const video = selected;
    element<HTMLSelectElement>("#analysis-video").value = video.id;
    sourceLabels();
    element<HTMLInputElement>("#analysis-name").value = video.original_name.slice(0, 120);
    element("#source-preview-error").hidden = true;
    sourcePlayer.src = `/api/analysis/videos/${video.id}/source`;
    const candidates = video.timestamp_candidates;
    element<HTMLSelectElement>("#timestamp-candidate").replaceChildren(
      ...candidates.map((item, index) => option(String(index), `${item.key}: ${item.raw_value}`)),
    );
    element<HTMLButtonElement>("#use-timestamp").disabled = !candidates[0]?.parsed_utc;
    const metadataOption = element<HTMLOptionElement>("#clock-source option[value=metadata_confirmed]");
    metadataOption.disabled = !candidates.some((item) => item.parsed_utc !== null);
    const token = previewRequest;
    const image = new Image();
    image.onload = () => {
      if (token !== previewRequest) return;
      preview = image; canvas.width = video.width; canvas.height = video.height; draw();
    };
    image.onerror = () => {
      if (token === previewRequest) showError(new Error("Decoded preview could not be loaded."));
    };
    image.src = `/api/analysis/videos/${video.id}/preview`;
    syncGeometry();
  }

  async function refreshVideos(): Promise<void> {
    const response = await analysisRequest("videos");
    if (response.kind !== "analysis_videos") throw new Error("Expected private recordings");
    videos = response.videos; renderVideos();
  }

  function showJobs(): void {
    const root = element("#analysis-jobs");
    if (!latestJobs.length) { root.textContent = t("noJobs"); cards.clear(); return; }
    const ids = new Set(latestJobs.map((job) => job.id));
    for (const [id, node] of cards) {
      if (!ids.has(id)) { node.remove(); cards.delete(id); }
    }
    for (const job of latestJobs) {
      let card = cards.get(job.id);
      if (!card) {
        if (!cards.size) root.replaceChildren();
        card = document.createElement("article"); card.className = "analysis-job"; card.dataset.job = job.id;
        const title = document.createElement("h3"); title.textContent = job.name; card.append(title);
        for (const className of ["job-status", "job-clock", "job-details", "job-error"]) {
          const row = document.createElement("p"); row.className = className; card.append(row);
        }
        const progress = document.createElement("progress"); progress.max = 1; card.append(progress);
        const actions = document.createElement("div"); actions.className = "op-actions";
        const cancel = button(t("cancel"), () => act(async () => {
          cancel.disabled = true;
          try { await analysisRequest(`jobs/${job.id}/cancel`, {}); await refreshJobs(); }
          finally { cancel.disabled = false; }
        }));
        actions.append(cancel); card.append(actions);
        cards.set(job.id, card);
        root.append(card);
      }
      const put = (selector: string, value: string): void => {
        const node = card?.querySelector(selector);
        if (!node) throw new Error("Missing job element");
        node.textContent = value;
      };
      put(".job-status", `${t("status")}: ${t(job.status)} / ${t(job.phase)}`);
      put(".job-clock", `${t("clock")}: ${job.clock.start_utc} · ${t("assumed")}`);
      put(".job-details", `${job.processed_frames} ${t("frames")} · ${job.processed_media_s.toFixed(2)} / ${job.duration_s.toFixed(2)} s`);
      put(".job-error", job.error ?? "");
      const error = card.querySelector<HTMLElement>(".job-error");
      if (error) {
        error.hidden = !job.error;
        error.className = job.status === "failed" ? "job-error banner error" : "job-error caption";
      }
      const progress = card.querySelector("progress");
      if (!progress) throw new Error("Missing progress element");
      progress.setAttribute("aria-label", `${t("progress")}: ${t(job.phase)}`);
      if (job.phase_fraction === null) progress.removeAttribute("value");
      else progress.value = job.phase_fraction;
      progress.hidden = ["cancelled", "failed"].includes(job.status);
      const cancel = card.querySelector("button");
      if (!cancel) throw new Error("Missing cancel button");
      cancel.textContent = t("cancel"); cancel.hidden = !["queued", "running", "cancelling"].includes(job.status);
      if (job.status === "succeeded" && !card.querySelector("a")) {
        const actions = card.querySelector(".op-actions");
        if (!actions) throw new Error("Missing job actions");
        const review = new URL(location.href); review.search = new URLSearchParams({
          mode: "evidence", lang: language(), bundle: `/api/analysis/jobs/${job.id}/bundle`, job: job.id,
        }).toString();
        const links = [
          ["review", review.href], ["csv", `/api/analysis/jobs/${job.id}/events.csv`],
          ["json", `/api/analysis/jobs/${job.id}/result.json`],
        ] as const;
        for (const [key, href] of links) {
          const link = document.createElement("a"); link.dataset.analysis = key;
          link.textContent = t(key); link.href = href;
          if (key !== "review") link.download = "";
          actions.append(link);
        }
      }
      const reviewLink = card.querySelector<HTMLAnchorElement>("a[data-analysis=review]");
      if (reviewLink) {
        const url = new URL(reviewLink.href); url.searchParams.set("lang", language());
        reviewLink.href = url.href;
      }
    }
    for (const [index, job] of latestJobs.entries()) {
      const card = cards.get(job.id);
      const existing = root.children[index];
      if (card && existing !== card) root.insertBefore(card, existing ?? null);
    }
  }

  async function refreshJobs(): Promise<void> {
    const response = await analysisRequest("jobs");
    if (response.kind !== "analysis_jobs") throw new Error("Expected jobs");
    latestJobs = response.jobs; showJobs();
  }

  function capabilities(value: AnalysisCapabilities): void {
    currentLimits = value;
    maximumUploadBytes = value.max_upload_bytes;
    setText("#analysis-limits", `${t("limits")}: ${value.max_upload_bytes / 1024 ** 2} MiB / ${value.max_duration_s} s / ${value.max_pixels.toLocaleString()} px; ${value.max_queued} jobs; ${value.max_run_s / 60} min/job.`);
    const ready = value.model_files_present && value.inference_packages_present;
    element("#missing-model").hidden = ready;
    element<HTMLButtonElement>("#run-analysis").disabled = !ready;
  }

  function chosen(file: File): void {
    chosenFile = file;
    setText("#selected-file", `${t("selected")}: ${file.name} · ${file.size.toLocaleString()} ${t("bytes")}`);
  }

  element("#video-file").addEventListener("change", () => {
    const files = element<HTMLInputElement>("#video-file").files;
    if (files?.length === 1 && files[0]) chosen(files[0]);
  });
  const drop = element("#video-drop");
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault(); drop.classList.remove("dragging");
    const files = event.dataTransfer?.files;
    if (!files || files.length !== 1 || !files[0]) { showError(new Error("Choose exactly one video.")); return; }
    chosen(files[0]);
  });
  element("#upload-form").addEventListener("submit", (event) => {
    event.preventDefault();
    act(async () => {
      if (!chosenFile) throw new Error(t("choose"));
      if (importing) return;
      if (!chosenFile.size || chosenFile.size > maximumUploadBytes) {
        throw new Error(`Choose a nonempty video up to ${maximumUploadBytes / 1024 ** 2} MiB.`);
      }
      const kind = element<HTMLSelectElement>("#content-kind").value;
      if (kind !== "recording" && kind !== "synthetic_test") throw new Error("Invalid content kind");
      importing = new AbortController();
      element<HTMLButtonElement>("#upload-button").disabled = true;
      element("#cancel-upload").hidden = false; setText("#analysis-status", t("importing"));
      try {
        const response = await uploadVideo(chosenFile, kind, importing.signal);
        if (response.kind !== "analysis_video") throw new Error("Expected imported recording");
        await refreshVideos(); selectVideo(response.video.id); setText("#analysis-status", "");
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
        setText("#analysis-status", t("importCancelled"));
        await refreshVideos();
      } finally {
        importing = null; element<HTMLButtonElement>("#upload-button").disabled = false;
        element("#cancel-upload").hidden = true;
      }
    });
  });
  element("#cancel-upload").addEventListener("click", () => importing?.abort());
  element("#analysis-video").addEventListener("change", () => act(() => selectVideo(element<HTMLSelectElement>("#analysis-video").value)));
  element("#analysis-refresh").addEventListener("click", () => act(async () => { await refreshVideos(); await refreshJobs(); }));
  element("#source-preview").addEventListener("error", () => { element("#source-preview-error").hidden = false; });
  element("#use-timestamp").addEventListener("click", () => act(() => {
    const item = needVideo().timestamp_candidates[Number(element<HTMLSelectElement>("#timestamp-candidate").value)];
    if (!item?.parsed_utc) throw new Error(t("noTimestamp"));
    element<HTMLInputElement>("#recording-start").value = item.parsed_utc;
    element<HTMLSelectElement>("#clock-source").value = "metadata_confirmed";
  }));
  element("#timestamp-candidate").addEventListener("change", () => {
    const candidate = selected?.timestamp_candidates[Number(element<HTMLSelectElement>("#timestamp-candidate").value)];
    element<HTMLButtonElement>("#use-timestamp").disabled = !candidate?.parsed_utc;
  });
  canvas.addEventListener("click", (event) => act(() => {
    checkDrawing();
    const max = element<HTMLSelectElement>("#geometry-tool").value === "gate" ? 2 : 24;
    if (pending.length >= max) throw new Error(t("pendingShape"));
    const bounds = canvas.getBoundingClientRect();
    pending.push([
      Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    ]);
    draw();
  }));
  element("#geometry-finish").addEventListener("click", () => act(finishShape));
  element("#geometry-clear").addEventListener("click", () => { pending = []; draw(); });
  element("#whole-frame").addEventListener("click", () => act(() => {
    checkDrawing(); addZone([[0, 0], [1, 0], [1, 1], [0, 1]]); syncGeometry();
  }));
  element("#geometry-tool").addEventListener("change", () => { pending = []; draw(); });
  element("#geometry-json").addEventListener("input", () => { jsonDirty = true; });
  element("#apply-geometry").addEventListener("click", () => act(() => {
    const value: unknown = JSON.parse(element<HTMLTextAreaElement>("#geometry-json").value);
    geometry = parseSite(value); pending = []; syncGeometry();
  }));
  element("#save-preset").addEventListener("click", () => act(async () => {
    const video = needVideo();
    const response = await analysisRequest("presets", {
      name: element<HTMLInputElement>("#preset-name").value, width: video.width, height: video.height, site: geometryReady(),
    });
    if (response.kind !== "analysis_presets") throw new Error("Expected camera presets");
    presets = response.presets; renderPresets();
  }));
  element("#apply-preset").addEventListener("click", () => act(() => {
    const video = needVideo();
    const preset = presets.find((item) => item.id === element<HTMLSelectElement>("#camera-presets").value);
    if (!preset) throw new Error(t("presets"));
    if (video.width !== preset.width || video.height !== preset.height) throw new Error(t("wrongPreset"));
    checkDrawing(); geometry = structuredClone(preset.site); pending = []; syncGeometry();
    element<HTMLInputElement>("#fixed-confirmed").checked = false;
  }));
  element("#analysis-form").addEventListener("submit", (event) => {
    event.preventDefault();
    act(async () => {
      const video = needVideo();
      const source = element<HTMLSelectElement>("#clock-source").value;
      const device = element<HTMLSelectElement>("#analysis-device").value;
      if (source !== "manual" && source !== "metadata_confirmed") throw new Error("Invalid clock source");
      if (device !== "cpu" && device !== "cuda") throw new Error("Invalid compute device");
      const input = element<HTMLInputElement>("#recording-start");
      if (!/(?:Z|[+-]\d\d:\d\d)$/.test(input.value) || !Number.isFinite(Date.parse(input.value))) {
        throw new Error(t("start"));
      }
      const candidate = video.timestamp_candidates[Number(element<HTMLSelectElement>("#timestamp-candidate").value)];
      element<HTMLButtonElement>("#run-analysis").disabled = true;
      try {
        const response = await analysisRequest("jobs", {
          video_id: video.id, name: element<HTMLInputElement>("#analysis-name").value,
          site: geometryReady(), recording_start: input.value, clock_source: source,
          metadata_key: source === "manual" ? null : candidate?.key ?? null,
          realtime_confirmed: element<HTMLInputElement>("#realtime-confirmed").checked,
          fixed_camera_confirmed: element<HTMLInputElement>("#fixed-confirmed").checked, device,
        });
        if (response.kind !== "analysis_job") throw new Error("Expected queued job");
        await refreshJobs();
        cards.get(response.job.id)?.scrollIntoView({ block: "nearest" });
      } finally { element<HTMLButtonElement>("#run-analysis").disabled = false; }
    });
  });
  element("#delete-video").addEventListener("click", () => act(async () => {
    const video = needVideo();
    if (!window.confirm(t("deleteConfirm"))) return;
    const player = element<HTMLVideoElement>("#source-preview");
    player.pause(); player.removeAttribute("src"); player.load();
    await analysisRequest(`videos/${video.id}/delete`, {});
    selectVideo(""); await refreshVideos(); await refreshJobs();
  }));

  function translate(): void {
    translateAnalysis(); renderVideos(); renderPresets(); sourceLabels();
    if (chosenFile) chosen(chosenFile);
    if (!jsonDirty) syncGeometry();
    showJobs();
    const benchmark = new URL(location.href);
    benchmark.search = new URLSearchParams({ mode: "evidence", lang: language() }).toString();
    element<HTMLAnchorElement>("#benchmark-replay").href = benchmark.href;
    element("#camera-presets").setAttribute("aria-label", t("presets"));
    canvas.setAttribute("aria-label", t("geometry"));
    if (currentLimits) capabilities(currentLimits);
  }
  document.addEventListener("parking-language", translate);
  window.addEventListener("pagehide", () => {
    disposed = true; importing?.abort(); clearTimeout(poll); previewRequest++;
  }, { once: true });

  const [limits, cameras] = await Promise.all([analysisRequest("capabilities"), analysisRequest("presets")]);
  if (limits.kind !== "analysis_capabilities" || cameras.kind !== "analysis_presets") throw new Error("Invalid analysis setup response");
  capabilities(limits); presets = cameras.presets;
  await Promise.all([refreshVideos(), refreshJobs()]);
  syncGeometry(); translate();
  async function pollJobs(): Promise<void> {
    try { await refreshJobs(); }
    catch (error) { showError(error); }
    if (!disposed) poll = setTimeout(() => { void pollJobs(); }, 1500);
  }
  poll = setTimeout(() => { void pollJobs(); }, 1500);
}

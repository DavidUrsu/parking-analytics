import { language } from "./operations-i18n";

const en = {
  title: "Analyze & review your recording",
  intro: "Private fixed-camera video, explicit recording time, visible geometry and actual model output.",
  choose: "Choose video", drop: "Drop one video here, or choose a file",
  permission: "I am authorized to process this recording. Uploading does not grant public redistribution rights.",
  inputKind: "Recording type", recording: "Recorded camera footage", synthetic: "Synthetic/test footage",
  import: "Import privately", importing: "Importing and probing the recording...", cancelUpload: "Cancel import",
  importCancelled: "Import cancelled. The list still includes any import that finished before cancellation.",
  videos: "Private recordings", chooseVideo: "Choose a recording", refresh: "Refresh",
  source: "Recording details", metadata: "Recording-time metadata candidates",
  noTimestamp: "No usable timezone-aware recording timestamp was found. Enter the first-frame time below.",
  metadataWarning: "Creation/export metadata is not proof of capture time. Check it against the recording.",
  burnedIn: "On-screen/burned-in dates are not automatically read. Inspect the preview and enter their first-frame date/time if needed.",
  candidate: "Metadata candidate", useCandidate: "Use selected candidate", manual: "Manual start time",
  clockSource: "Time source", metadataConfirmed: "Checked metadata candidate",
  start: "Recording start (ISO-8601 with timezone, e.g. 2026-10-22T18:00:00+03:00)",
  realtime: "The recording runs at real time (1x), without time-lapse, speed changes or removed-time gaps.",
  fixed: "This is a fixed camera/view; I checked the zones and entering direction for this recording.",
  clockWarning: "Event UTC = first-frame start + media seconds under your 1x assumption. Upload time and file mtime are never used. Slower review playback does not change event dates.",
  geometry: "Camera geometry", geometryHelp: "Define at least one zone and one boundary. Click ordered polygon points or two boundary endpoints, then Finish shape. Arrow = entering side; exits are opposite. Zones count vehicles, not free parking bays.",
  zone: "Zone polygon", gate: "Crossing boundary", tool: "Drawing tool", finish: "Finish shape",
  clear: "Clear pending points", fullFrame: "Add whole-frame visible zone", remove: "Remove",
  flip: "Flip entering side", presets: "Saved camera presets", presetName: "Camera preset name",
  savePreset: "Save preset", applyPreset: "Apply selected preset",
  presetWarning: "Only apply a preset to the same fixed camera/view. Matching dimensions alone do not establish that.",
  wrongPreset: "Preset dimensions differ. Redraw/review geometry rather than silently rescaling it.",
  advanced: "Keyboard/advanced geometry JSON", applyJson: "Apply geometry JSON",
  pendingJson: "Apply or reset the edited JSON before drawing.",
  pendingShape: "Add at least three points for a zone or exactly two for a boundary.",
  name: "Analysis name", device: "Compute device", cpu: "Local CPU", cuda: "Local CUDA GPU",
  run: "Queue vehicle-flow analysis", missingModel: "The fixed model is not ready. Install inference extras and fetch the pinned model; no fallback detections are generated.",
  jobs: "Recent analysis jobs (latest 100)", status: "Status / stage", progress: "Actual stage progress",
  queued: "Queued", running: "Running", cancelling: "Cancelling", cancelled: "Cancelled",
  succeeded: "Ready", failed: "Failed", waiting_resource: "Waiting for model resource",
  preparing_media: "Preparing playable media", loading_model: "Loading cached model",
  analyzing: "Running detector/tracker", finalizing: "Finalizing private results", finished: "Finished",
  frames: "processed frames", noJobs: "No analysis jobs have been submitted.",
  cancel: "Cancel", review: "Review synchronized results", csv: "Private events CSV", json: "Private results JSON",
  unverified: "Model observations are unverified. This is vehicle flow, not plate recognition, free-bay detection or an accuracy certificate.",
  benchmark: "Open the existing MEVA benchmark replay",
  delete: "Delete recording and its finished results", deleteConfirm: "Permanently delete this private recording and its finished results?",
  chooseFirst: "Import/select a recording first.",
  previewError: "Original codec is not playable here; use the decoded frame below. The analysis creates an H.264 replay.",
  limits: "Limits", seconds: "seconds", bytes: "bytes", selected: "Selected file",
  clock: "Recording clock", assumed: "User-confirmed 1x assumption, not independently verified",
};

export type AnalysisKey = keyof typeof en;
const ro: Record<AnalysisKey, string> = {
  title: "Analizeaza si verifica filmarea",
  intro: "Filmari private de la camera fixa, moment explicit, geometrie vizibila si rezultate reale ale modelului.",
  choose: "Alege filmarea", drop: "Trage o singura filmare aici sau alege un fisier",
  permission: "Sunt autorizat sa procesez filmarea. Importul nu acorda drepturi de publicare.",
  inputKind: "Tipul filmarii", recording: "Filmarea unei camere", synthetic: "Filmarea sintetica/de test",
  import: "Importa privat", importing: "Se importa si inspecteaza filmarea...", cancelUpload: "Anuleaza importul",
  importCancelled: "Import anulat. Lista include orice import incheiat inainte de anulare.",
  videos: "Filmari private", chooseVideo: "Alege o filmare", refresh: "Actualizeaza",
  source: "Detaliile filmarii", metadata: "Momente candidate din metadate",
  noTimestamp: "Nu exista un moment utilizabil cu fus orar. Introdu momentul primului cadru mai jos.",
  metadataWarning: "Metadatele de creare/export nu dovedesc momentul capturii. Verifica filmarea.",
  burnedIn: "Datele desenate pe imagine nu sunt citite automat. Inspecteaza cadrul si introdu momentul primului cadru.",
  candidate: "Metadate candidate", useCandidate: "Foloseste candidatul", manual: "Moment manual",
  clockSource: "Sursa momentului", metadataConfirmed: "Metadate verificate",
  start: "Inceput (ISO-8601 cu fus orar, ex. 2026-10-22T18:00:00+03:00)",
  realtime: "Filmarea ruleaza in timp real (1x), fara accelerari, incetiniri sau intervale eliminate.",
  fixed: "Camera/perspectiva este fixa; am verificat zonele si sensul intrarii pentru aceasta filmare.",
  clockWarning: "UTC = inceputul primului cadru + secundele media, presupunand 1x. Nu folosim ora importului/modificarii fisierului. Redarea lenta nu schimba datele.",
  geometry: "Geometria camerei", geometryHelp: "Defineste minimum o zona si o limita. Alege punctele poligonului sau doua capete si termina forma. Sageata indica intrarea. Zonele numara vehicule, nu locuri libere.",
  zone: "Poligonul zonei", gate: "Limita de traversare", tool: "Unealta", finish: "Termina forma",
  clear: "Sterge punctele curente", fullFrame: "Adauga zona intregului cadru", remove: "Sterge",
  flip: "Inverseaza sensul", presets: "Configuratii salvate", presetName: "Numele camerei",
  savePreset: "Salveaza configuratia", applyPreset: "Aplica configuratia",
  presetWarning: "Aplica doar aceleiasi camere/perspective. Dimensiunile identice nu sunt suficiente.",
  wrongPreset: "Dimensiunile difera. Redeseneaza/verifica geometria; nu o redimensionam automat.",
  advanced: "Geometrie JSON pentru tastatura", applyJson: "Aplica JSON",
  pendingJson: "Aplica sau reseteaza JSON-ul inainte de desenare.",
  pendingShape: "Minimum trei puncte pentru zona sau exact doua pentru limita.",
  name: "Numele analizei", device: "Procesare", cpu: "CPU local", cuda: "GPU CUDA local",
  run: "Adauga analiza fluxului", missingModel: "Modelul fix nu este pregatit. Instaleaza dependintele si descarca modelul fixat; nu generam detecii false.",
  jobs: "Analize recente (ultimele 100)", status: "Stare / etapa", progress: "Progresul real al etapei",
  queued: "In asteptare", running: "Ruleaza", cancelling: "Se anuleaza", cancelled: "Anulat",
  succeeded: "Pregatit", failed: "Esuat", waiting_resource: "Asteapta resursa modelului",
  preparing_media: "Pregateste filmarea", loading_model: "Incarca modelul local",
  analyzing: "Ruleaza detectorul/urmarirea", finalizing: "Finalizeaza rezultate private", finished: "Terminat",
  frames: "cadre procesate", noJobs: "Nu exista analize.",
  cancel: "Anuleaza", review: "Verifica rezultatele sincronizate", csv: "Evenimente CSV private", json: "Rezultate JSON private",
  unverified: "Observatii neverificate ale modelului. Nu este recunoastere de numere, detectie de locuri libere sau certificat de acuratete.",
  benchmark: "Deschide filmarea de evaluare MEVA",
  delete: "Sterge filmarea si rezultatele incheiate", deleteConfirm: "Stergi definitiv filmarea privata si rezultatele incheiate?",
  chooseFirst: "Importa/selecteaza mai intai filmarea.",
  previewError: "Codecul original nu poate fi redat aici; foloseste cadrul decodat. Analiza genereaza o filmare H.264.",
  limits: "Limite", seconds: "secunde", bytes: "octeti", selected: "Fisier selectat",
  clock: "Momentul inregistrarii", assumed: "Presupunere 1x confirmata de utilizator, neverificata independent",
};

export function analysisText(key: AnalysisKey): string {
  return language() === "ro" ? ro[key] : en[key];
}

function isKey(key: string): key is AnalysisKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function translateAnalysis(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-analysis]")) {
    const key = node.dataset.analysis;
    if (!key || !isKey(key)) throw new Error(`Unknown analysis translation: ${key}`);
    node.textContent = analysisText(key);
  }
}

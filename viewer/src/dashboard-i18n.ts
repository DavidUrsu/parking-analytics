import { language } from "./operations-i18n";

const en = {
  workspace: "Operator workspace", local: "Local workspace", noLive: "No live cameras connected",
  skip: "Skip to content", addRecording: "Add recording", languageUnavailable: "Language control is unavailable",
  recorded: "Recorded demo", recordedNote: "A camera-wall demo, not a live feed.",
  recordedHelp: "The demo clips are different moments from one camera, not simultaneous views. Nothing on this screen claims current site occupancy.",
  layout: "Grid layout", single: "Single view", four: "2 x 2 grid", nine: "3 x 3 grid",
  playAll: "Play wall", pauseAll: "Pause wall", options: "Wall options",
  playRecording: "Play recording", pauseRecording: "Pause recording", source: "Footage source",
  overlays: "Show detections", loop: "Loop recorded clips",
  private: "Show private analyzed recordings", privateHelp: "Opt in for this visit only. Private recordings are never selected automatically or saved in your browser layout.",
  refresh: "Refresh recordings", reset: "Reset layout", catalogue: "available recordings",
  emptyDemo: "Demo footage has not been prepared on this checkout. Add and analyze your own recording, or prepare the MEVA replay using the README.",
  failedDemo: "Demo recordings could not be loaded. No replacement footage was substituted.",
  loading: "Checking media", ready: "Playing replay", paused: "Replay paused", ended: "Replay ended",
  blocked: "Press Play to start", failed: "Recording unavailable", missing: "Saved recording is unavailable",
  slot: "View", choose: "Camera / recording", none: "Empty view",
  emptySlot: "Choose a recording", emptyHelp: "Use the selector above to add a view here.",
  noCamera: "No camera selected", review: "Open detailed review", clipTime: "Clip time",
  observed: "Observed vehicles", entries: "Zone entries", exits: "Zone exits", unknown: "Unknown",
  modelNote: "Model observations, not free parking spaces. No site-wide totals are inferred.",
  privateBadge: "Private recording", syntheticBadge: "Synthetic test", noReference: "Not human-verified",
  tools: "What would you like to do?", toolsIntro: "The same tools, without leaving your workspace.",
  monitoringHelp: "Find a plate, inspect entries and exits, and review visits from imported event logs.",
  billingHelp: "Preview a fee for a completed visit or for explicitly entered times.",
  capacityHelp: "Calculate mapped availability while keeping unobservable spaces unknown.",
  analysisHelp: "Drop a recording, define its zones, and inspect actual detector output.",
  about: "About the demo and your data", attribution: "Footage attribution",
  aboutPrivacy: "Private video and plate data stay on this machine. The wall does not connect live cameras, run inference, recognize plates or create billing records.",
  aboutEvidence: "Recorded clips retain their source attribution and model provenance. Reference review is still required for accuracy claims. Public presentation clearance is not granted by this local demo.",
  presetInvalid: "The saved layout is invalid. The default grid is shown; reset or change the layout to replace it.",
  presetUnavailable: "Browser storage is unavailable. Layout changes work for this visit but cannot be remembered.",
  privateLoading: "Loading private recording choices...",
  privateEmpty: "No completed private analyses are available. Add a recording in Analyze & review first.",
  privacyCleared: "Private views cleared. Only demo choices are remembered.",
};

export type DashboardKey = keyof typeof en;
const ro: Record<DashboardKey, string> = {
  workspace: "Spatiu pentru operator", local: "Spatiu local", noLive: "Nu sunt conectate camere live",
  skip: "Sari la continut", addRecording: "Adauga filmare", languageUnavailable: "Controlul limbii nu este disponibil",
  recorded: "Demo inregistrat", recordedNote: "Demonstratie cu filmari, nu transmisie live.",
  recordedHelp: "Clipurile demo arata momente diferite ale aceleiasi camere, nu imagini simultane. Ecranul nu afirma ocuparea actuala a parcarii.",
  layout: "Aranjarea grilei", single: "O singura imagine", four: "Grila 2 x 2", nine: "Grila 3 x 3",
  playAll: "Porneste redarea", pauseAll: "Opreste redarea", options: "Optiunile grilei",
  playRecording: "Porneste filmarea", pauseRecording: "Opreste filmarea", source: "Sursa filmarii",
  overlays: "Afiseaza detectiile", loop: "Repeta clipurile",
  private: "Afiseaza filmarile private analizate", privateHelp: "Doar pentru aceasta vizita. Filmarile private nu sunt selectate automat si nu sunt salvate in aranjarea browserului.",
  refresh: "Actualizeaza filmarile", reset: "Reseteaza grila", catalogue: "filmari disponibile",
  emptyDemo: "Filmarile demo nu au fost pregatite aici. Adauga si analizeaza o filmare sau pregateste demonstratia MEVA conform README.",
  failedDemo: "Filmarile demo nu au putut fi incarcate. Nu am substituit alte filmari.",
  loading: "Se verifica filmarea", ready: "Redare inregistrare", paused: "Redare oprita", ended: "Filmarea s-a incheiat",
  blocked: "Apasa Redare pentru a incepe", failed: "Filmarea nu este disponibila", missing: "Filmarea salvata nu este disponibila",
  slot: "Imagine", choose: "Camera / filmare", none: "Imagine goala",
  emptySlot: "Alege o filmare", emptyHelp: "Foloseste selectorul de mai sus pentru a adauga o imagine.",
  noCamera: "Nicio camera selectata", review: "Deschide verificarea detaliata", clipTime: "Timpul clipului",
  observed: "Vehicule observate", entries: "Intrari in zona", exits: "Iesiri din zona", unknown: "Necunoscut",
  modelNote: "Observatii ale modelului, nu locuri libere. Nu deducem totaluri pentru intreaga parcare.",
  privateBadge: "Filmarea privata", syntheticBadge: "Test sintetic", noReference: "Fara verificare umana",
  tools: "Ce doresti sa faci?", toolsIntro: "Aceleasi unelte, in acelasi spatiu de lucru.",
  monitoringHelp: "Cauta un numar, inspecteaza intrarile si iesirile si verifica vizitele din jurnale importate.",
  billingHelp: "Estimeaza tariful unei vizite incheiate sau pentru momente introduse explicit.",
  capacityHelp: "Calculeaza disponibilitatea locurilor cartografiate pastrand locurile necunoscute.",
  analysisHelp: "Adauga o filmare, defineste zonele si inspecteaza rezultatele reale ale detectorului.",
  about: "Despre demo si datele tale", attribution: "Atribuirea filmarii",
  aboutPrivacy: "Filmarile si numerele private raman pe acest calculator. Grila nu conecteaza camere live, nu ruleaza inferenta, nu citeste numere si nu creeaza facturi.",
  aboutEvidence: "Clipurile isi pastreaza atribuirea si provenienta modelului. Acuratetea necesita verificare umana. Demonstratia locala nu acorda permisiune de prezentare publica.",
  presetInvalid: "Aranjarea salvata este invalida. Afisam grila implicita; reseteaza sau modifica grila pentru a o inlocui.",
  presetUnavailable: "Stocarea browserului nu este disponibila. Modificarile functioneaza doar pentru aceasta vizita.",
  privateLoading: "Se incarca lista filmarilor private...",
  privateEmpty: "Nu exista analize private incheiate. Adauga mai intai o filmare in Analiza si verificare.",
  privacyCleared: "Imaginile private au fost eliminate. Retinem doar alegerile demo.",
};

export function dashboardText(key: DashboardKey): string {
  return language() === "ro" ? ro[key] : en[key];
}

function isKey(key: string): key is DashboardKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function translateDashboard(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-dashboard]")) {
    const key = node.dataset.dashboard;
    if (!key || !isKey(key)) throw new Error(`Unknown dashboard translation: ${key}`);
    node.textContent = dashboardText(key);
  }
}

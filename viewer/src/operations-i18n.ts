import type { Language } from "./types";

const en = {
  monitoring: "Monitoring", billing: "Billing", capacity: "Capacity", evidence: "Evidence",
  analysis: "Analyze & review", analysisIntro: "Private recorded-video analysis.",
  modes: "Working mode", brand: "PARKING / OPERATOR WORKSPACE", language: "Language",
  monitoringTitle: "Vehicle visits, not guesses.",
  monitoringIntro: "Find a plate's history or inspect recorded entries and exits in a UTC time window.",
  billingTitle: "Parking fee preview",
  billingIntro: "An explicit tariff and valid times. No payments, invoices or physical barrier control.",
  capacityTitle: "Mapped-space capacity",
  capacityIntro: "Keep unknown spaces unknown. Vehicle counts are not a parking-space inventory.",
  localOnly: "Local operator prototype. No authentication or automatic retention policy: do not deploy publicly or expose real plate records.",
  noOCR: "Imported event records only. No plate-recognition model is connected; clip tracking IDs are not licence plates.",
  synthetic: "SYNTHETIC TEST EVENTS - generated identifiers and timestamps, not camera observations or evidence of ANPR accuracy.",
  source: "Private event source", chooseSource: "Choose a source", refresh: "Refresh sources",
  example: "Open explicit synthetic example", noSources: "No plate events have been imported.",
  importHint: "Import an authorized JSON log with parking monitor-import --input data\\your-events.json. No synthetic data is substituted automatically.",
  plate: "Plate (exact match, optional)", country: "Jurisdiction (optional)", view: "Query",
  visits: "Plate / visit history", entries: "Entries during period", exits: "Exits during period",
  present: "Visits overlapping period", active: "Active / unclosed visits", review: "Needs review",
  auditView: "Reviewed / ignored observations",
  from: "From (UTC, inclusive)", to: "To (UTC, exclusive)", search: "Search",
  rangeHint: "Entry and exit filters use event time. Overlap includes visits that started earlier. An unclosed visit is not proof the car is still present.",
  loading: "Loading...", records: "Matching records", asOf: "As of",
  noMatches: "No matching records. This is not a claim about whole-site occupancy.",
  record: "Record", plateColumn: "Plate", jurisdiction: "Jurisdiction", startEvent: "Start / event time",
  exitTime: "Exit time", duration: "Duration", status: "Status / issues", actions: "Actions",
  entry: "Entry event", exit: "Exit event", visit: "Visit",
  confirmed: "Confirmed input", needs_review: "Needs review", ignored: "Ignored", completed: "Completed",
  open: "Unclosed", unknown: "Unknown", soFar: "so far, based on an unclosed record",
  eventDetails: "Review event", calculate: "Fee preview", previous: "Previous", next: "Next",
  reviewTitle: "Inspect and resolve the source event", original: "Original imported observation",
  current: "Current resolution", timestamp: "Timestamp (ISO-8601 with offset)", direction: "Direction",
  in: "Entry", out: "Exit", resolution: "Resolution", reason: "Reason (required)",
  checked: "I inspected the source record. This is a local operator assertion, not independent ANPR validation.",
  saveReview: "Save correction", cancel: "Close", saved: "Correction saved. Visits were rebuilt from the event history.",
  discardReview: "Discard the unsaved event correction?",
  audit: "Local review audit", noAudit: "No local corrections recorded.", sourceLabel: "Source label",
  unreadable_plate: "Plate or jurisdiction unreadable",
  unreviewed_event: "Unreviewed observation",
  duplicate_entry: "Repeated entry without a matching exit",
  unmatched_exit: "Exit has no matching entry",
  simultaneous_events: "Simultaneous events: ordering is ambiguous",
  future_timestamp: "Timestamp is later than the query snapshot",
  manual: "Manual calculation preview", recordedVisit: "Recorded visit",
  manualInstead: "Use manual times instead", entered: "Entry time (UTC)", exited: "Exit time (UTC)",
  currency: "Currency", chooseCurrency: "Choose currency", price: "Price per interval (2 decimals)",
  interval: "Interval length (minutes)", free: "Free minutes deducted from the visit",
  tariffRule: "Every started interval after the free minutes is charged. No daily caps, tax rules or automatic charges are applied.",
  quote: "Calculate preview", total: "Preview total", intervals: "Charged intervals",
  billable: "Billable time", notInvoice: "Calculation preview only - not an invoice or payment.",
  completeOnly: "Only completed, unambiguous visits are eligible. Missing or disputed events cannot create a charge.",
  invalidPrice: "Enter a nonnegative price with at most two decimals; no thousands separators.",
  bothDates: "Provide both UTC boundaries or leave both empty.",
  mapped: "Total mapped spaces", occupied: "Observed occupied spaces", unknownSpaces: "Unknown / unobservable spaces",
  capacityCalculate: "Calculate mapped availability", available: "Available mapped spaces",
  capacityBasis: "Operator inputs only - not an automatic camera capacity estimate. Unmapped whole-site capacity remains unknown.",
  inventoryHint: "Do not copy vehicle counts into these fields: moving vehicles and marked parking spaces are different quantities.",
  cameraContext: "Real camera context", cameraHint: "The existing MEVA replay measures zone vehicle presence, not available bays.",
  clip: "Recorded segment", cameraTime: "Snapshot time", observedVehicles: "Observed zone vehicles",
  cameraCapacity: "Camera-derived available capacity", openEvidence: "Inspect footage and overlays",
  startApi: "Start the local API with uv run --no-sync parking serve.",
  error: "Operation failed", eventCount: "Imported event records",
  source_kind_synthetic: "Synthetic example", source_kind_authorized_log: "Authorized operator log",
  source_kind_anpr_log: "Imported upstream ANPR log (not this app's OCR)",
} as const;

export type OpKey = keyof typeof en;
const ro: Record<OpKey, string> = {
  monitoring: "Monitorizare", billing: "Tarifare", capacity: "Capacitate", evidence: "Dovezi",
  analysis: "Analiza si verificare", analysisIntro: "Analiza privata a filmarilor.",
  modes: "Mod de lucru", brand: "PARCARE / SPATIU DE LUCRU", language: "Limba",
  monitoringTitle: "Vizite ale vehiculelor, nu presupuneri.",
  monitoringIntro: "Cauta istoricul unui numar sau intrarile si iesirile inregistrate intr-un interval UTC.",
  billingTitle: "Previzualizarea tarifului", billingIntro: "Tarif explicit si momente valide. Fara plati, facturi sau controlul barierei.",
  capacityTitle: "Capacitatea locurilor cartografiate", capacityIntro: "Pastreaza locurile necunoscute ca necunoscute. Vehiculele nu sunt un inventar de locuri.",
  localOnly: "Prototip local pentru operator. Fara autentificare sau stergere automata: nu publica si nu expune numere reale.",
  noOCR: "Doar evenimente importate. Nu este conectat un model de citire a numerelor; ID-urile din clip nu sunt numere de inmatriculare.",
  synthetic: "EVENIMENTE SINTETICE DE TEST - identificatori si momente generate, nu observatii ale camerei sau dovezi de acuratete ANPR.",
  source: "Sursa privata de evenimente", chooseSource: "Alege o sursa", refresh: "Actualizeaza sursele",
  example: "Deschide exemplul sintetic explicit", noSources: "Nu au fost importate evenimente cu numere.",
  importHint: "Importa un jurnal autorizat cu parking monitor-import --input data\\your-events.json. Datele sintetice nu sunt substituite automat.",
  plate: "Numar (potrivire exacta, optional)", country: "Jurisdictie (optional)", view: "Interogare",
  visits: "Istoricul numarului / vizitelor", entries: "Intrari in interval", exits: "Iesiri in interval",
  present: "Vizite suprapuse intervalului", active: "Vizite active / neincheiate", review: "Necesita verificare",
  auditView: "Observatii corectate / ignorate",
  from: "De la (UTC, inclusiv)", to: "Pana la (UTC, exclusiv)", search: "Cauta",
  rangeHint: "Filtrele folosesc momentul evenimentului. Suprapunerea include vizite incepute anterior. O vizita neincheiata nu dovedeste prezenta vehiculului.",
  loading: "Se incarca...", records: "Inregistrari gasite", asOf: "La momentul",
  noMatches: "Nicio inregistrare gasita. Nu reprezinta ocuparea intregii parcari.",
  record: "Inregistrare", plateColumn: "Numar", jurisdiction: "Jurisdictie", startEvent: "Inceput / eveniment",
  exitTime: "Iesire", duration: "Durata", status: "Stare / probleme", actions: "Actiuni",
  entry: "Eveniment de intrare", exit: "Eveniment de iesire", visit: "Vizita",
  confirmed: "Date confirmate la sursa", needs_review: "Necesita verificare", ignored: "Ignorat", completed: "Incheiata",
  open: "Neincheiata", unknown: "Necunoscut", soFar: "pana acum, pe baza unei vizite neincheiate",
  eventDetails: "Verifica evenimentul", calculate: "Previzualizare tarif", previous: "Anterior", next: "Urmator",
  reviewTitle: "Inspecteaza si corecteaza evenimentul", original: "Observatia importata initial",
  current: "Rezolutia curenta", timestamp: "Moment (ISO-8601 cu fus orar)", direction: "Directie",
  in: "Intrare", out: "Iesire", resolution: "Rezolutie", reason: "Motiv (obligatoriu)",
  checked: "Am inspectat inregistrarea sursa. Este o declaratie locala a operatorului, nu validare ANPR independenta.",
  saveReview: "Salveaza corectia", cancel: "Inchide", saved: "Corectie salvata. Vizitele au fost reconstruite.",
  discardReview: "Renunti la corectia nesalvata?",
  audit: "Istoric local al corectiilor", noAudit: "Nu exista corectii locale.", sourceLabel: "Eticheta sursei",
  unreadable_plate: "Numar sau jurisdictie ilizibila", unreviewed_event: "Observatie neverificata",
  duplicate_entry: "Intrare repetata fara iesire", unmatched_exit: "Iesire fara intrare asociata",
  simultaneous_events: "Evenimente simultane: ordine ambigua", future_timestamp: "Moment ulterior interogarii",
  manual: "Previzualizare manuala", recordedVisit: "Vizita inregistrata", manualInstead: "Foloseste momente manuale",
  entered: "Intrare (UTC)", exited: "Iesire (UTC)", currency: "Moneda", chooseCurrency: "Alege moneda",
  price: "Pret per interval (2 zecimale)", interval: "Lungimea intervalului (minute)",
  free: "Minute gratuite scazute din vizita",
  tariffRule: "Fiecare interval inceput dupa minutele gratuite este taxat. Fara plafon zilnic, reguli fiscale sau taxare automata.",
  quote: "Calculeaza previzualizarea", total: "Total estimat", intervals: "Intervale taxabile",
  billable: "Durata taxabila", notInvoice: "Doar previzualizare - nu este factura sau plata.",
  completeOnly: "Doar vizitele incheiate si neambigue pot fi calculate. Evenimentele lipsa sau contestate nu genereaza o taxa.",
  invalidPrice: "Introdu un pret nenegativ cu cel mult doua zecimale, fara separator de mii.",
  bothDates: "Introdu ambele limite UTC sau lasa-le pe ambele goale.",
  mapped: "Total locuri cartografiate", occupied: "Locuri observate ocupate", unknownSpaces: "Locuri necunoscute / nevizibile",
  capacityCalculate: "Calculeaza disponibilitatea", available: "Locuri cartografiate disponibile",
  capacityBasis: "Doar date ale operatorului, nu estimare automata a camerei. Capacitatea totala ramane necunoscuta.",
  inventoryHint: "Nu copia numarul vehiculelor: vehiculele in miscare si locurile marcate sunt marimi diferite.",
  cameraContext: "Context real al camerei", cameraHint: "Filmarea MEVA masoara vehiculele din zona, nu locurile disponibile.",
  clip: "Segment inregistrat", cameraTime: "Moment", observedVehicles: "Vehicule observate in zona",
  cameraCapacity: "Locuri disponibile estimate de camera", openEvidence: "Inspecteaza filmarea si suprapunerile",
  startApi: "Porneste API-ul local cu uv run --no-sync parking serve.",
  error: "Operatie esuata", eventCount: "Evenimente importate",
  source_kind_synthetic: "Exemplu sintetic", source_kind_authorized_log: "Jurnal autorizat al operatorului",
  source_kind_anpr_log: "Jurnal ANPR extern importat (nu OCR-ul acestei aplicatii)",
};

export function language(): Language {
  return document.documentElement.lang === "ro" ? "ro" : "en";
}

export function opText(key: OpKey): string {
  return language() === "ro" ? ro[key] : en[key];
}

function isOpKey(key: string): key is OpKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function translateOperations(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-op]")) {
    const key = node.dataset.op;
    if (!key || !isOpKey(key)) {
      throw new Error(`Unknown operations translation: ${key}`);
    }
    node.textContent = opText(key);
  }
}

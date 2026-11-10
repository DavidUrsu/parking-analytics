import "./style.css";
import "./operations.css";
import "./dashboard.css";
import { language, opText as t, translateOperations } from "./operations-i18n";
import { dashboardText as dt, translateDashboard } from "./dashboard-i18n";

const modes = ["dashboard", "monitoring", "billing", "capacity", "analysis"] as const;
type Mode = typeof modes[number] | "evidence";

const icons = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  monitoring: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 10h2l2-3 3 6 2-3h2"/>',
  billing: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 7h6M9 11h6M9 15h3"/>',
  capacity: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
  analysis: '<path d="m14 4 6 6M4 20l5-1 11-11a2 2 0 0 0-5-5L4 14v6Z"/><path d="M4 8V4h4M16 20h4v-4"/>',
};

function mountShell(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) throw new Error("Missing app root");
  const workspace = document.createElement("div");
  workspace.id = "workspace";
  workspace.innerHTML = `
    <a class="skip-link" href="#app" data-dashboard="skip"></a>
    <aside id="workspace-sidebar">
      <a id="workspace-brand" class="workspace-brand"><span class="brand-mark" aria-hidden="true">P</span><span>PARKING<span class="brand-subtitle" data-dashboard="workspace"></span></span></a>
      <p class="nav-caption" data-dashboard="workspace"></p>
      <nav id="mode-navigation"></nav>
      <div class="sidebar-note"><span class="local-indicator" aria-hidden="true"></span><span data-dashboard="local"></span><small data-dashboard="noLive"></small></div>
    </aside>
    <div class="workspace-content">
      <header class="workspace-topbar">
        <div class="workspace-location"><span data-dashboard="workspace"></span><span aria-hidden="true">/</span><strong id="workspace-section"></strong></div>
        <div class="workspace-top-actions"><a id="workspace-import" class="subtle-link" data-dashboard="addRecording"></a><div id="workspace-language"></div></div>
      </header>
      <div id="workspace-view"></div>
    </div>`;
  app.replaceWith(workspace);
  const view = workspace.querySelector("#workspace-view");
  if (!view) throw new Error("Missing dashboard content container");
  view.append(app);
  app.tabIndex = -1;
}

function renderNavigation(mode: Mode | undefined): void {
  const navigation = document.querySelector<HTMLElement>("#mode-navigation");
  if (!navigation) throw new Error("Missing dashboard navigation");
  navigation.setAttribute("aria-label", t("modes"));
  navigation.replaceChildren();
  for (const value of modes) {
    const link = document.createElement("a");
    const url = new URL(location.href);
    url.search = new URLSearchParams({ mode: value, lang: language() }).toString();
    link.href = url.href; link.dataset.mode = value;
    link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icons[value]}</svg>`;
    const label = document.createElement("span"); label.textContent = t(value); link.append(label);
    if (value === mode || (value === "analysis" && mode === "evidence")) {
      link.className = "selected"; link.setAttribute("aria-current", "page");
    }
    navigation.append(link);
  }
  const brand = document.querySelector<HTMLAnchorElement>("#workspace-brand");
  const upload = document.querySelector<HTMLAnchorElement>("#workspace-import");
  const section = document.querySelector("#workspace-section");
  if (!brand || !upload || !section) throw new Error("Missing dashboard shell controls");
  brand.href = `/?mode=dashboard&lang=${language()}`;
  upload.href = `/?mode=analysis&lang=${language()}`;
  section.textContent = mode ? t(mode === "evidence" ? "analysis" : mode) : "";
  translateDashboard();
}

function fail(error: unknown): void {
  const app = document.querySelector("#app");
  if (!app) throw error;
  let notice = document.querySelector<HTMLElement>("#operations-error");
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "banner error"; notice.setAttribute("role", "alert");
    app.prepend(notice);
  }
  notice.textContent = `${t("error")}: ${error instanceof Error ? error.message : String(error)}`;
  notice.hidden = false;
}

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  document.documentElement.lang = query.get("lang") === "ro" ? "ro" : "en";
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  const requested = query.get("mode") ?? (query.has("bundle") ? "evidence" : "dashboard");
  const mode = requested === "evidence" ? "evidence" : modes.find((value) => value === requested);
  mountShell();
  renderNavigation(mode);
  if (!mode) throw new Error(`Unknown working mode: ${requested}`);
  document.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement) || event.target.id !== "language") return;
    const selected = event.target.value;
    if (selected !== "en" && selected !== "ro") { fail(new Error("Unsupported language")); return; }
    document.documentElement.lang = selected;
    const url = new URL(location.href); url.searchParams.set("lang", selected);
    history.replaceState(null, "", url);
    translateOperations(); renderNavigation(mode);
    document.dispatchEvent(new Event("parking-language"));
    if (mode !== "evidence") document.title = `Parking | ${t(mode)}`;
  });
  if (mode === "dashboard") {
    const { mountDashboard } = await import("./dashboard");
    await mountDashboard();
  } else if (mode === "evidence") {
    await import("./main");
  } else if (mode === "analysis") {
    const { mountAnalysis } = await import("./analysis");
    await mountAnalysis();
  } else if (mode === "monitoring") {
    const { mountMonitoring } = await import("./monitoring");
    await mountMonitoring();
  } else {
    const calculators = await import("./calculators-ui");
    if (mode === "billing") await calculators.mountBilling();
    else await calculators.mountCapacity();
  }
  const languageControl = document.querySelector("#app .language");
  const languageSlot = document.querySelector("#workspace-language");
  if (!languageControl || !languageSlot) throw new Error(dt("languageUnavailable"));
  languageSlot.append(languageControl);
  if (mode !== "evidence") document.title = `Parking | ${t(mode)}`;
}

start().catch(fail);

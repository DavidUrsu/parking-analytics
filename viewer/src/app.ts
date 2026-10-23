import "./style.css";
import "./operations.css";
import { language, opText as t, translateOperations } from "./operations-i18n";

const modes = ["monitoring", "billing", "capacity", "analysis"] as const;
type Mode = typeof modes[number] | "evidence";

function renderNavigation(mode: Mode | undefined): void {
  let navigation = document.querySelector<HTMLElement>("#mode-navigation");
  if (!navigation) {
    navigation = document.createElement("nav");
    navigation.id = "mode-navigation";
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");
    app.before(navigation);
  }
  navigation.setAttribute("aria-label", t("modes"));
  navigation.replaceChildren();
  for (const value of modes) {
    const link = document.createElement("a");
    const url = new URL(location.href);
    url.search = new URLSearchParams({ mode: value, lang: language() }).toString();
    link.href = url.href; link.textContent = t(value); link.dataset.mode = value;
    if (value === mode || (value === "analysis" && mode === "evidence")) {
      link.className = "selected"; link.setAttribute("aria-current", "page");
    }
    navigation.append(link);
  }
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
  const requested = query.get("mode") ?? (query.has("bundle") ? "evidence" : "monitoring");
  const mode = requested === "evidence" ? "evidence" : modes.find((value) => value === requested);
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
  if (mode === "evidence") {
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
  if (mode !== "evidence") document.title = `Parking | ${t(mode)}`;
}

start().catch(fail);

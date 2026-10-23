import { language, opText as t, translateOperations, type OpKey } from "./operations-i18n";
import type { SourceKind } from "./operations-types";

export function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing operations element: ${selector}`);
  return result;
}

export function setText(selector: string, value: string): void {
  element(selector).textContent = value;
}

export function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value; node.textContent = label;
  return node;
}

export function setupPage(title: OpKey, description: OpKey, content: string): void {
  element("#app").innerHTML = `
    <header><div><div class="eyebrow" data-op="brand"></div><h1 data-op="${title}"></h1><p class="intro" data-op="${description}"></p></div>
    <label class="language"><span data-op="language"></span><select id="language"><option value="en">English</option><option value="ro">Rom\u00e2n\u0103</option></select></label></header>
    <div id="operations-error" class="banner error" role="alert" hidden></div>
    <div id="operations-synthetic" class="banner" data-op="synthetic" hidden></div>
    <main>${content}</main><footer data-op="localOnly"></footer>`;
  element<HTMLSelectElement>("#language").value = language();
  translateOperations();
}

export function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setText("#operations-error", `${t("error")}: ${message}`);
  element("#operations-error").hidden = false;
}

export function clearError(): void {
  element("#operations-error").hidden = true;
}

export function syntheticBanner(kind: SourceKind | null): void {
  element("#operations-synthetic").hidden = kind !== "synthetic";
}

export function utcDisplay(value: string | null): string {
  return value === null ? t("unknown") : new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function utcInput(value: string): string {
  return new Date(value).toISOString().slice(0, 19).replace(/:00$/, "");
}

export function inputTimestamp(value: string): string {
  if (!value) throw new Error(t("bothDates"));
  return `${value}Z`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return t("unknown");
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m ${seconds % 60}s`;
}

export function button(label: string, action: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button"; node.textContent = label;
  node.addEventListener("click", action);
  return node;
}

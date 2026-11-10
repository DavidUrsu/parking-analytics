import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "screenshots",
  use: {
    ...base.use,
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  },
});

import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "PARKING_");
  const target = process.env.PARKING_API_URL ?? env.PARKING_API_URL ?? "http://127.0.0.1:8000";
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The private operations API proxy must target a loopback HTTP origin");
  }
  return {
    server: {
      host: "127.0.0.1",
      fs: {
        strict: true,
        allow: [process.cwd()],
        deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/*.{sqlite,sqlite3,db}"],
      },
      proxy: { "/api": { target: url.origin, changeOrigin: true } },
    },
  };
});

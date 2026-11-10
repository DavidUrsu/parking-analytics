import type { ReplayClip } from "./types";

export interface ReplayMedia {
  url: string;
  serverVerified: boolean;
  dispose(): void;
}

export async function loadReplayMedia(
  video: HTMLVideoElement, clip: ReplayClip, bundleURL: URL, signal: AbortSignal,
): Promise<ReplayMedia> {
  const url = new URL(clip.video, bundleURL);
  if (url.origin !== location.origin) throw new Error("Replay media must be same-origin local assets");
  const job = bundleURL.pathname.match(/^\/api\/analysis\/jobs\/([0-9a-f]{32})\/bundle$/)?.[1];
  let resource: ReplayMedia;
  if (job) {
    if (url.pathname !== `/api/analysis/jobs/${job}/media/recording.mp4`) {
      throw new Error("Private replay media does not belong to its completed job");
    }
    const response = await fetch(url, { method: "HEAD", signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Private media request failed (${response.status})`);
    if (response.headers.get("X-Integrity-Check") !== "server-verified"
        || response.headers.get("X-Content-SHA256") !== clip.video_sha256) {
      throw new Error(`Private media SHA-256 mismatch: ${clip.id}`);
    }
    resource = { url: url.href, serverVerified: true, dispose: () => {} };
  } else {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Media request failed (${response.status}): ${clip.video}`);
    if (Number(response.headers.get("Content-Length")) > 64 * 1024 ** 2) {
      throw new Error("Static clip exceeds the 64 MiB buffered-media limit");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 64 * 1024 ** 2) throw new Error("Clip exceeds the media size limit");
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    if (hash !== clip.video_sha256) throw new Error(`Media SHA-256 mismatch: ${clip.id}`);
    signal.throwIfAborted();
    const objectURL = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
    resource = { url: objectURL, serverVerified: false, dispose: () => URL.revokeObjectURL(objectURL) };
  }
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = (): void => { cleanup(); resolve(); };
      const failed = (): void => { cleanup(); reject(new Error("Replay video could not be decoded")); };
      const aborted = (): void => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
      video.addEventListener("loadeddata", loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      video.preload = "auto"; video.src = resource.url; video.load();
    });
    if (video.videoWidth !== clip.width || video.videoHeight !== clip.height
        || Math.abs(video.duration - clip.duration_s) > 0.1) {
      throw new Error("Replay media dimensions/timing do not match its declared observations");
    }
    return resource;
  } catch (error) {
    resource.dispose();
    throw error;
  }
}

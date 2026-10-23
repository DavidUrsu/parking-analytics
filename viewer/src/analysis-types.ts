import type { Bundle } from "./types";

export interface TimestampCandidate {
  key: string;
  raw_value: string;
  parsed_utc: string | null;
  needs_timezone: boolean;
  note: string;
}

export interface UploadedVideo {
  id: string;
  original_name: string;
  content_kind: "recording" | "synthetic_test";
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  duration_s: number;
  nominal_fps: number | null;
  codec: string;
  container_format: string;
  rotation_degrees: number;
  timestamp_candidates: TimestampCandidate[];
  burned_in_timestamp_checked: false;
  imported_at: string;
  source_url: string;
  preview_url: string;
}

export interface RecordingClock {
  start_utc: string;
  original_start: string;
  source: "manual" | "metadata_confirmed";
  metadata_key: string | null;
  playback_rate: 1;
  realtime_assumed: true;
  independently_verified: false;
}

export interface AnalysisJob {
  id: string;
  video_id: string;
  name: string;
  site: Bundle["site"];
  clock: RecordingClock;
  device: "cpu" | "cuda";
  status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
  phase: "queued" | "waiting_resource" | "preparing_media" | "loading_model" | "analyzing" | "finalizing" | "finished";
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_s: number;
  processed_frames: number;
  processed_media_s: number;
  phase_fraction: number | null;
  error: string | null;
  bundle_url: string | null;
  events_url: string | null;
  export_url: string | null;
}

export interface CameraPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  site: Bundle["site"];
  updated_at: string;
}

export interface AnalysisCapabilities {
  kind: "analysis_capabilities";
  max_upload_bytes: number;
  max_duration_s: number;
  max_pixels: number;
  max_run_s: number;
  max_queued: number;
  active_workers: 1;
  model_files_present: boolean;
  inference_packages_present: boolean;
  timestamp_ocr_available: false;
}

export type AnalysisResponse =
  | { kind: "analysis_video"; video: UploadedVideo }
  | { kind: "analysis_videos"; videos: UploadedVideo[] }
  | { kind: "analysis_job"; job: AnalysisJob }
  | { kind: "analysis_jobs"; jobs: AnalysisJob[] }
  | { kind: "analysis_presets"; presets: CameraPreset[] }
  | { kind: "analysis_deleted"; video_id: string }
  | AnalysisCapabilities;

export type Language = "en" | "ro";
export type Method = "baseline" | "candidate";
export type Split = "development" | "held_out";
export type Point = [number, number];
export type LocalText = Record<Language, string>;

export interface Vehicle {
  box: [number, number, number, number];
  label: string;
  score: number;
  track_id: number | null;
}

export interface ZoneCount {
  zone_id: string;
  vehicle_count: number | null;
  state: "observed" | "unknown";
  reason: "detections" | "confirmation_pending" | "no_observation";
  unconfirmed_count: number;
  capacity: null;
  available: null;
}

export interface Observation {
  time_s: number;
  vehicles: Vehicle[];
  zones: ZoneCount[];
}

export interface Crossing {
  time_s: number;
  gate_id: string;
  direction: "in" | "out";
  track_id: number;
}

export interface Analysis {
  samples: Observation[];
  events: Crossing[];
}

export interface ReferenceSnapshot {
  time_s: number;
  zone_counts: Record<string, number | null>;
  notes: string;
}

export interface ReferenceEvent {
  time_s: number;
  gate_id: string;
  direction: "in" | "out";
  notes: string;
}

export interface ReferenceClip {
  clip_id: string;
  snapshots: ReferenceSnapshot[];
  events: ReferenceEvent[];
}

export interface Reference {
  schema_version: "1.0";
  protocol_version: string;
  config_sha256: string;
  review_status: "provisional" | "reviewed";
  origin: string;
  events_complete: boolean;
  clips: ReferenceClip[];
}

export interface CountMetrics {
  reference_samples: number;
  comparable_samples: number;
  unknown_reference_samples: number;
  abstentions: number;
  exact_matches: number;
  coverage: number | null;
  mean_absolute_error: number | null;
  signed_bias: number | null;
  exact_match_rate: number | null;
}

export interface EventMetrics {
  predicted_events: number;
  reference_events: number;
  scoreable: boolean;
  true_positive: number | null;
  false_positive: number | null;
  false_negative: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  signed_count_error: number | null;
}

export interface Metrics {
  occupancy: CountMetrics;
  events: EventMetrics;
  event_groups: Record<string, EventMetrics>;
}

export interface ReplayClip {
  id: string;
  name: LocalText;
  split: Split;
  source: {
    url: string;
    file: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    duration_s: number;
  };
  source_start_s: number;
  source_clock: "media_pts" | "meva_r13_cfr";
  source_start_frame: number | null;
  source_pts_irregularities: number;
  crop: [number, number, number, number];
  width: number;
  height: number;
  duration_s: number;
  video: string;
  video_sha256: string;
  baseline: Analysis;
  candidate: Analysis;
  review_moments: {
    time_s: number;
    kind: "low_confidence" | "reference_disagreement" | "confirmed_error";
    method: Method;
    details: string;
  }[];
}

export interface Bundle {
  schema_version: "1.0";
  synthetic: boolean;
  site: {
    id: string;
    name: LocalText;
    description: LocalText;
    zones: { id: string; name: LocalText; polygon: Point[]; capacity: null }[];
    gates: { id: string; name: LocalText; start: Point; end: Point; inward_side: number }[];
  };
  protocol: {
    version: string;
    occupancy_mode: "observed_vehicle_count";
    reference_interval_s: number;
    event_tolerance_s: number;
    notes: string;
  };
  analysis_fps: number;
  stale_after_s: number;
  run: {
    command: string[];
    code_revision: string | null;
    config_sha256: string;
    model_id: string;
    model_revision: string;
    model_sha256: string;
    device: "cpu" | "cuda" | "synthetic";
    hardware: string;
    versions: Record<string, string>;
    elapsed_seconds: number;
    seed: number;
  };
  attribution: {
    title: string;
    creator: string;
    source_url: string;
    license: string;
    license_url: string | null;
    modifications: string;
    staged_scenarios: boolean;
    public_presentation_cleared: false;
  };
  clips: ReplayClip[];
  reference: Reference | null;
  evaluation: {
    reference_status: "provisional" | "reviewed";
    reference_sha256: string;
    events_complete: boolean;
    event_tolerance_s: number;
    by_clip: Record<string, Record<Method, Metrics>>;
    by_split: Partial<Record<Split, Record<Method, Metrics>>>;
    limitations: string[];
  } | null;
}

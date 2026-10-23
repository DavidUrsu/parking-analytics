export type SourceKind = "authorized_log" | "anpr_log" | "synthetic";
export type ReviewState = "confirmed" | "needs_review" | "ignored";
export type View = "visits" | "entries" | "exits" | "present" | "active" | "review" | "audit";
export type Issue = "unreadable_plate" | "unreviewed_event" | "duplicate_entry"
  | "unmatched_exit" | "simultaneous_events" | "future_timestamp";

export interface OperatorSite {
  id: string;
  name: string;
  source_kind: SourceKind;
  event_count: number;
  first_event_at: string | null;
  last_event_at: string | null;
}

export interface PlateEvent {
  event_id: string;
  occurred_at: string;
  direction: "in" | "out";
  plate: string | null;
  country_code: string | null;
  review_state: ReviewState;
  confidence: number | null;
  camera_id: string | null;
}

export interface EventRecord extends PlateEvent {
  record_type: "event";
  source_label: string;
  issues: Issue[];
  review_count: number;
}

export interface VisitRecord {
  record_type: "visit";
  visit_id: string;
  plate: string;
  country_code: string;
  entered_at: string;
  exited_at: string | null;
  entry_event_id: string;
  exit_event_id: string | null;
  status: "active" | "completed" | "needs_review";
  duration_seconds: number | null;
  elapsed_seconds: number | null;
  issues: Issue[];
  event_ids: string[];
}

export interface SitesResponse {
  kind: "sites";
  sites: OperatorSite[];
}

export interface ImportResponse {
  kind: "import";
  site: OperatorSite;
  imported: number;
  duplicates: number;
}

export interface MonitoringResponse {
  kind: "monitoring";
  site: OperatorSite;
  as_of: string;
  view: View;
  total: number;
  offset: number;
  limit: number;
  records: (EventRecord | VisitRecord)[];
}

export interface EventResponse {
  kind: "event";
  site: OperatorSite;
  original: PlateEvent;
  current: PlateEvent;
  current_hash: string;
  source_label: string;
  audit: {
    changed_at: string;
    reason: string;
    before: PlateEvent;
    after: PlateEvent;
  }[];
}

export interface VisitResponse {
  kind: "visit";
  site: OperatorSite;
  visit: VisitRecord;
}

export interface BillingPolicy {
  currency: "RON" | "EUR" | "USD";
  price_minor: number;
  interval_minutes: number;
  free_minutes: number;
}

export interface QuoteResponse {
  kind: "quote";
  basis: "manual_preview" | "completed_visit";
  source_kind: SourceKind | null;
  visit_id: string | null;
  entered_at: string;
  exited_at: string;
  duration_seconds: number;
  billable_seconds: number;
  charged_intervals: number;
  policy: BillingPolicy;
  total_minor: number;
  is_invoice: false;
}

export interface CapacityResponse {
  kind: "capacity";
  basis: "operator_inputs";
  mapped_spaces: number;
  occupied_spaces: number;
  unknown_spaces: number;
  available_mapped_spaces: number;
  whole_site_capacity: null;
}

export type OperationsResponse = SitesResponse | ImportResponse | MonitoringResponse
  | EventResponse | VisitResponse | QuoteResponse | CapacityResponse;

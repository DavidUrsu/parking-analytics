import Ajv2020 from "ajv/dist/2020";
import schema from "./bundle.schema.json";
import type { Analysis, Bundle, Observation } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<Bundle>(schema);
const validateSite = ajv.compile<Bundle["site"]>({
  $defs: schema.$defs, $ref: "#/$defs/Site",
});

export function parseSite(value: unknown): Bundle["site"] {
  if (!validateSite(value)) {
    throw new Error(`Invalid camera geometry: ${validateSite.errors?.slice(0, 3).map(
      (error) => `${error.instancePath || "/"}: ${error.message}`,
    ).join("; ")}`);
  }
  for (const group of [value.zones, value.gates]) {
    if (new Set(group.map((item) => item.id)).size !== group.length || group.length > 8) {
      throw new Error("Use unique shape IDs and at most eight zones/boundaries.");
    }
  }
  if (value.zones.some((zone) => zone.polygon.length > 24)) {
    throw new Error("A zone supports at most 24 vertices.");
  }
  return value;
}

export function parseBundle(value: unknown): Bundle {
  if (!validate(value)) {
    const details = validate.errors?.slice(0, 4).map(
      (error) => `${error.instancePath || "/"}: ${error.message}`,
    ).join("; ");
    throw new Error(`Invalid replay contract: ${details}`);
  }
  const zones = new Set(value.site.zones.map((zone) => zone.id));
  const gates = new Set(value.site.gates.map((gate) => gate.id));
  const clips = new Map(value.clips.map((clip) => [clip.id, clip]));
  if (zones.size !== value.site.zones.length || gates.size !== value.site.gates.length
      || clips.size !== value.clips.length || (!value.synthetic && value.run.device === "synthetic")) {
    throw new Error("Replay identifiers or synthetic-evidence metadata are inconsistent");
  }
  for (const clip of value.clips) {
    for (const analysis of [clip.baseline, clip.candidate]) {
      let previous = -1;
      for (const sample of analysis.samples) {
        const ids = sample.vehicles.flatMap((vehicle) => vehicle.track_id === null ? [] : [vehicle.track_id]);
        if (sample.time_s <= previous || sample.time_s >= clip.duration_s
            || new Set(ids).size !== ids.length
            || sample.zones.length !== zones.size
            || new Set(sample.zones.map((zone) => zone.zone_id)).size !== zones.size) {
          throw new Error("Replay timestamps, track IDs or zone observations are inconsistent");
        }
        for (const zone of sample.zones) {
          if (!zones.has(zone.zone_id) || (zone.state === "unknown") !== (zone.vehicle_count === null)
              || (zone.state === "unknown" && zone.reason === "detections")
              || (zone.vehicle_count !== null && zone.unconfirmed_count > zone.vehicle_count)) {
            throw new Error("Unknown occupancy must not be represented as a known count");
          }
        }
        if (sample.vehicles.some((vehicle) => vehicle.box[0] >= vehicle.box[2]
            || vehicle.box[1] >= vehicle.box[3])) {
          throw new Error("Replay contains a nonpositive vehicle box");
        }
        previous = sample.time_s;
      }
      previous = -1;
      for (const event of analysis.events) {
        if (!gates.has(event.gate_id) || event.time_s >= clip.duration_s || event.time_s < previous) {
          throw new Error("Replay crossing has an invalid time or boundary");
        }
        previous = event.time_s;
      }
    }
    if (clip.review_moments.some((moment) => moment.time_s >= clip.duration_s)) {
      throw new Error("Review moment falls outside its clip");
    }
  }
  if (value.reference) {
    if (value.reference.config_sha256 !== value.run.config_sha256
        || value.reference.protocol_version !== value.protocol.version
        || (value.reference.review_status === "reviewed" && !value.reference.events_complete)) {
      throw new Error("Reference configuration or human-review metadata is inconsistent");
    }
    for (const reference of value.reference.clips) {
      const clip = clips.get(reference.clip_id);
      if (!clip) throw new Error("Reference describes an unknown clip");
      let previous = -1;
      for (const snapshot of reference.snapshots) {
        if (snapshot.time_s <= previous || snapshot.time_s >= clip.duration_s
            || Object.keys(snapshot.zone_counts).length !== zones.size
            || Object.keys(snapshot.zone_counts).some((id) => !zones.has(id))) {
          throw new Error("Reference snapshot has an invalid timestamp or zone set");
        }
        previous = snapshot.time_s;
      }
      if (reference.events.some((event) => !gates.has(event.gate_id) || event.time_s >= clip.duration_s)) {
        throw new Error("Reference crossing has an invalid timestamp or boundary");
      }
    }
  }
  if (value.evaluation && (!value.reference
      || value.evaluation.reference_status !== value.reference.review_status
      || value.evaluation.events_complete !== value.reference.events_complete)) {
    throw new Error("Evaluation and reference review state disagree");
  }
  return value;
}

export function sampleAt(analysis: Analysis, time: number, maxAge: number): Observation | null {
  let low = 0;
  let high = analysis.samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const sample = analysis.samples[middle];
    if (!sample) throw new Error("Missing observation in validated replay");
    if (sample.time_s <= time) low = middle + 1;
    else high = middle;
  }
  const sample = analysis.samples[low - 1];
  return sample && time - sample.time_s <= maxAge ? sample : null;
}

export function countsAt(analysis: Analysis, time: number): { in: number; out: number } {
  const counts = { in: 0, out: 0 };
  for (const event of analysis.events) {
    if (event.time_s > time) break;
    counts[event.direction]++;
  }
  return counts;
}

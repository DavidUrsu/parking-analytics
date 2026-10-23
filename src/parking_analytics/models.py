from __future__ import annotations

import hashlib
from itertools import pairwise
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

Unit = Annotated[float, Field(ge=0, le=1)]
Seconds = Annotated[float, Field(ge=0)]
Count = Annotated[int, Field(ge=0)]
Identifier = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]*$")]
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Point = Annotated[tuple[Unit, Unit], Field(strict=False)]
Box = tuple[Unit, Unit, Unit, Unit]
Split = Literal["development", "held_out"]
Method = Literal["baseline", "candidate"]
Direction = Literal["in", "out"]


class Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        allow_inf_nan=False,
        hide_input_in_errors=True,
        json_schema_serialization_defaults_required=True,
    )

    def digest(self) -> str:
        return hashlib.sha256(self.model_dump_json().encode("utf-8")).hexdigest()


class Text(Model):
    en: str = Field(min_length=1)
    ro: str = Field(min_length=1)


def segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    def orientation(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    first, second = orientation(a, b, c), orientation(a, b, d)
    third, fourth = orientation(c, d, a), orientation(c, d, b)
    if first * second < 0 and third * fourth < 0:
        return True
    for point, start, end, value in (
        (c, a, b, first),
        (d, a, b, second),
        (a, c, d, third),
        (b, c, d, fourth),
    ):
        if abs(value) < 1e-10 and (
            min(start[0], end[0]) <= point[0] <= max(start[0], end[0])
            and min(start[1], end[1]) <= point[1] <= max(start[1], end[1])
        ):
            return True
    return False


class Zone(Model):
    id: Identifier
    name: Text
    polygon: list[Point] = Field(min_length=3)
    capacity: None = None

    @model_validator(mode="after")
    def valid_polygon(self) -> Self:
        points = self.polygon
        area = sum(
            a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1], strict=True)
        )
        if len(set(points)) != len(points) or abs(area) < 1e-8:
            raise ValueError("Zone polygon must have distinct vertices and nonzero area")
        edges = list(zip(points, points[1:] + points[:1], strict=True))
        for index, (a, b) in enumerate(edges):
            for other, (c, d) in enumerate(edges[index + 1 :], start=index + 1):
                if other == index + 1 or (index == 0 and other == len(edges) - 1):
                    continue
                if segments_intersect(a, b, c, d):
                    raise ValueError("Zone polygon edges must not intersect")
        return self


class Gate(Model):
    id: Identifier
    name: Text
    start: Point
    end: Point
    inward_side: Literal[-1, 1]

    @model_validator(mode="after")
    def nonzero_gate(self) -> Self:
        if self.start == self.end:
            raise ValueError("A boundary must be a nonzero finite segment")
        return self


class Site(Model):
    id: Identifier
    name: Text
    description: Text
    zones: list[Zone] = Field(min_length=1)
    gates: list[Gate] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_ids(self) -> Self:
        for items in (self.zones, self.gates):
            if len({item.id for item in items}) != len(items):
                raise ValueError("Zone and boundary identifiers must be unique")
        return self


class Source(Model):
    url: str = Field(pattern=r"^(https://[^\s]+|/api/analysis/videos/[0-9a-f]{32}/source)$")
    file: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    bytes: int = Field(gt=0)
    sha256: Digest
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    duration_s: float = Field(gt=0)


class Segment(Model):
    id: Identifier
    name: Text
    split: Split
    source: Source
    start_s: Seconds
    end_s: Seconds

    @model_validator(mode="after")
    def valid_range(self) -> Self:
        if not self.start_s < self.end_s <= self.source.duration_s + 0.001:
            raise ValueError("Segment range must be nonempty and within the source")
        return self


class DetectorConfig(Model):
    id: str
    revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    license: Literal["Apache-2.0"]
    weights_sha256: Digest
    threshold: float = Field(gt=0, lt=1)
    vehicle_nms_iou: float = Field(gt=0, lt=1)
    vehicle_labels: list[Literal["car", "motorcycle", "bus", "truck"]] = Field(min_length=1)


class Protocol(Model):
    version: str
    occupancy_mode: Literal["observed_vehicle_count"]
    reference_interval_s: float = Field(gt=0)
    event_tolerance_s: float = Field(gt=0)
    notes: str


class Config(Model):
    schema_version: Literal["1.0"]
    site: Site
    crop: tuple[Count, Count, Count, Count]
    source_clock: Literal["media_pts", "meva_r13_cfr"] = "media_pts"
    export_size: tuple[int, int]
    analysis_fps: int = Field(gt=0, le=30)
    stale_after_s: float = Field(gt=0)
    crossing_band: float = Field(ge=0, lt=0.1)
    max_track_gap_s: float = Field(gt=0)
    baseline_iou_threshold: float = Field(gt=0, lt=1)
    model: DetectorConfig
    protocol: Protocol
    max_download_bytes: int = Field(gt=0, le=5 * 1024**3)
    max_run_seconds: int = Field(gt=0, le=1800)
    clips: list[Segment] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_geometry_and_splits(self) -> Self:
        left, top, right, bottom = self.crop
        if left >= right or top >= bottom:
            raise ValueError("Crop must have positive width and height")
        if any(size <= 0 or size > 3840 or size % 2 for size in self.export_size):
            raise ValueError("Export dimensions must be positive even numbers at most 3840")
        if len({clip.id for clip in self.clips}) != len(self.clips):
            raise ValueError("Clip identifiers must be unique")
        for index, clip in enumerate(self.clips):
            if self.source_clock == "meva_r13_cfr":
                if not clip.source.url.startswith(
                    "https://mevadata-public-01.s3.amazonaws.com/drops-123-r13/"
                ) or not clip.source.file.endswith(".r13.avi"):
                    raise ValueError(
                        "MEVA's frame-index clock is only for its verified r13 release"
                    )
                if any(
                    abs(value * 30 - round(value * 30)) > 1e-6
                    for value in (clip.start_s, clip.end_s)
                ):
                    raise ValueError(
                        "MEVA r13 selections must align with its documented 30 fps clock"
                    )
            if right > clip.source.width or bottom > clip.source.height:
                raise ValueError("Crop extends beyond a source frame")
            for other in self.clips[:index]:
                if clip.source.sha256 == other.source.sha256 and (
                    max(clip.start_s, other.start_s) < min(clip.end_s, other.end_s)
                ):
                    raise ValueError("Development/evaluation segments must not overlap")
        return self


class Vehicle(Model):
    box: Box
    label: Literal["car", "motorcycle", "bus", "truck"]
    score: Unit
    track_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def positive_box(self) -> Self:
        if self.box[0] >= self.box[2] or self.box[1] >= self.box[3]:
            raise ValueError("Bounding boxes must have positive area")
        return self


class ZoneCount(Model):
    zone_id: Identifier
    vehicle_count: Count | None
    state: Literal["observed", "unknown"]
    reason: Literal["detections", "confirmation_pending", "no_observation"]
    unconfirmed_count: Count = 0
    capacity: None = None
    available: None = None

    @model_validator(mode="after")
    def state_matches_count(self) -> Self:
        if (self.state == "unknown") != (self.vehicle_count is None):
            raise ValueError("Unknown observations must have null counts and vice versa")
        if self.state == "unknown" and self.reason == "detections":
            raise ValueError("Unknown observations need an explicit reason")
        if self.vehicle_count is not None and self.unconfirmed_count > self.vehicle_count:
            raise ValueError("Unconfirmed IDs cannot exceed observed vehicles")
        return self


class Observation(Model):
    time_s: Seconds
    vehicles: list[Vehicle]
    zones: list[ZoneCount] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_observations(self) -> Self:
        ids = [vehicle.track_id for vehicle in self.vehicles if vehicle.track_id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("A track may have only one observation per frame")
        if len({zone.zone_id for zone in self.zones}) != len(self.zones):
            raise ValueError("Duplicate zone observations")
        return self


class Event(Model):
    time_s: Seconds
    gate_id: Identifier
    direction: Direction
    track_id: int = Field(ge=1)


class Analysis(Model):
    samples: list[Observation] = Field(min_length=1)
    events: list[Event]

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        times = [sample.time_s for sample in self.samples]
        if any(a >= b for a, b in pairwise(times)):
            raise ValueError("Observation timestamps must be strictly increasing")
        if any(a.time_s > b.time_s for a, b in pairwise(self.events)):
            raise ValueError("Events must be ordered by media time")
        return self


class ReferenceSnapshot(Model):
    time_s: Seconds
    zone_counts: dict[Identifier, Count | None]
    notes: str = ""


class ReferenceEvent(Model):
    time_s: Seconds
    gate_id: Identifier
    direction: Direction
    notes: str = ""


class ReferenceClip(Model):
    clip_id: Identifier
    snapshots: list[ReferenceSnapshot]
    events: list[ReferenceEvent]


class Reference(Model):
    schema_version: Literal["1.0"]
    protocol_version: str
    config_sha256: Digest
    review_status: Literal["provisional", "reviewed"]
    origin: str = Field(min_length=1)
    events_complete: bool
    clips: list[ReferenceClip] = Field(min_length=1)

    @model_validator(mode="after")
    def consistent_review(self) -> Self:
        if self.review_status == "reviewed" and not self.events_complete:
            raise ValueError("Human review must also confirm crossing annotation completeness")
        if len({clip.clip_id for clip in self.clips}) != len(self.clips):
            raise ValueError("Reference clips must be unique")
        for clip in self.clips:
            times = [sample.time_s for sample in clip.snapshots]
            if any(a >= b for a, b in pairwise(times)):
                raise ValueError("Reference snapshots must be unique and time-ordered")
        return self


class CountMetrics(Model):
    reference_samples: Count
    comparable_samples: Count
    unknown_reference_samples: Count
    abstentions: Count
    exact_matches: Count
    coverage: Unit | None
    mean_absolute_error: float | None = Field(ge=0)
    signed_bias: float | None
    exact_match_rate: Unit | None


class EventMetrics(Model):
    predicted_events: Count
    reference_events: Count
    scoreable: bool
    true_positive: Count | None
    false_positive: Count | None
    false_negative: Count | None
    precision: Unit | None
    recall: Unit | None
    f1: Unit | None
    signed_count_error: int | None


class MethodMetrics(Model):
    occupancy: CountMetrics
    events: EventMetrics
    event_groups: dict[str, EventMetrics]


class Evaluation(Model):
    reference_status: Literal["provisional", "reviewed"]
    reference_sha256: Digest
    events_complete: bool
    event_tolerance_s: float = Field(gt=0)
    by_clip: dict[Identifier, dict[Method, MethodMetrics]]
    by_split: dict[Split, dict[Method, MethodMetrics]]
    limitations: list[str]


class ReviewMoment(Model):
    time_s: Seconds
    kind: Literal["reference_disagreement", "confirmed_error", "low_confidence"]
    method: Method
    details: str


class ReplayClip(Model):
    id: Identifier
    name: Text
    split: Split
    source: Source
    source_start_s: Seconds
    source_clock: Literal["media_pts", "meva_r13_cfr"] = "media_pts"
    source_start_frame: Count | None = None
    source_pts_irregularities: Count = 0
    crop: tuple[Count, Count, Count, Count]
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    duration_s: float = Field(gt=0)
    video: str = Field(pattern=r"^media/[a-z][a-z0-9_-]*\.mp4$")
    video_sha256: Digest
    baseline: Analysis
    candidate: Analysis
    review_moments: list[ReviewMoment]


class Run(Model):
    command: list[str]
    code_revision: str | None
    config_sha256: Digest
    model_id: str
    model_revision: str
    model_sha256: Digest
    device: Literal["cpu", "cuda", "synthetic"]
    hardware: str
    versions: dict[str, str]
    elapsed_seconds: Seconds
    seed: int


class Attribution(Model):
    title: str
    creator: str
    source_url: str
    license: str
    license_url: str | None
    modifications: str
    staged_scenarios: bool
    public_presentation_cleared: Literal[False]


class Bundle(Model):
    schema_version: Literal["1.0"]
    synthetic: bool
    site: Site
    protocol: Protocol
    analysis_fps: int = Field(gt=0)
    stale_after_s: float = Field(gt=0)
    run: Run
    attribution: Attribution
    clips: list[ReplayClip] = Field(min_length=1)
    reference: Reference | None
    evaluation: Evaluation | None

    @model_validator(mode="after")
    def consistent_bundle(self) -> Self:
        clip_ids = {clip.id for clip in self.clips}
        zone_ids = {zone.id for zone in self.site.zones}
        gate_ids = {gate.id for gate in self.site.gates}
        if len(clip_ids) != len(self.clips):
            raise ValueError("Replay clip identifiers must be unique")
        if self.run.device == "synthetic" and not self.synthetic:
            raise ValueError("Synthetic evidence must be explicitly identified")
        for clip in self.clips:
            for analysis in (clip.baseline, clip.candidate):
                for sample in analysis.samples:
                    if sample.time_s >= clip.duration_s:
                        raise ValueError("Observation is outside its media range")
                    if {zone.zone_id for zone in sample.zones} != zone_ids:
                        raise ValueError("Each observation must describe every configured zone")
                for event in analysis.events:
                    if event.gate_id not in gate_ids or event.time_s >= clip.duration_s:
                        raise ValueError("Event has an unknown boundary or invalid media time")
            if any(moment.time_s >= clip.duration_s for moment in clip.review_moments):
                raise ValueError("Review moment is outside its media range")
        if self.reference is not None:
            if self.reference.config_sha256 != self.run.config_sha256:
                raise ValueError("Reference labels belong to a different configuration")
            if self.reference.protocol_version != self.protocol.version:
                raise ValueError("Reference protocol does not match this run")
            lookup = {clip.id: clip for clip in self.clips}
            for reference in self.reference.clips:
                if reference.clip_id not in lookup:
                    raise ValueError("Reference has an unknown clip")
                duration = lookup[reference.clip_id].duration_s
                for snapshot in reference.snapshots:
                    if snapshot.time_s >= duration or set(snapshot.zone_counts) != zone_ids:
                        raise ValueError("Reference snapshot has an invalid time or zone set")
                for event in reference.events:
                    if event.time_s >= duration or event.gate_id not in gate_ids:
                        raise ValueError("Reference crossing has an invalid time or boundary")
        if self.evaluation is not None:
            if self.reference is None:
                raise ValueError("Evaluation requires its actual reference")
            if self.evaluation.reference_status != self.reference.review_status:
                raise ValueError("Evaluation review status disagrees with its reference")
            if self.evaluation.reference_sha256 != self.reference.digest():
                raise ValueError("Evaluation is stale: reference content has changed")
            if self.evaluation.events_complete != self.reference.events_complete:
                raise ValueError("Evaluation completeness disagrees with its reference")
        return self

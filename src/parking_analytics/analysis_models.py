from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, TypeAdapter, field_validator, model_validator

from parking_analytics.models import Digest, Model, Site
from parking_analytics.operations_models import UtcTime, utc_datetime

MAX_UPLOAD_BYTES = 512 * 1024**2
MAX_DURATION_SECONDS = 600
MAX_PIXELS = 1920 * 1080
MAX_RUN_SECONDS = 1800
MAX_QUEUED_JOBS = 5
OpaqueId = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
JobState = Literal["queued", "running", "cancelling", "cancelled", "succeeded", "failed"]
JobPhase = Literal[
    "queued",
    "waiting_resource",
    "preparing_media",
    "loading_model",
    "analyzing",
    "finalizing",
    "finished",
]
TERMINAL_STATES = {"cancelled", "succeeded", "failed"}


class TimestampCandidate(Model):
    key: str
    raw_value: str
    parsed_utc: UtcTime | None
    needs_timezone: bool
    note: str


class UploadedVideo(Model):
    id: OpaqueId
    original_name: str
    content_kind: Literal["recording", "synthetic_test"]
    bytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)
    sha256: Digest
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    duration_s: float = Field(gt=0, le=MAX_DURATION_SECONDS)
    nominal_fps: float | None
    codec: str
    container_format: str
    rotation_degrees: int
    timestamp_candidates: list[TimestampCandidate]
    burned_in_timestamp_checked: Literal[False] = False
    imported_at: UtcTime
    source_url: str
    preview_url: str


class RecordingClock(Model):
    start_utc: UtcTime
    original_start: str
    source: Literal["manual", "metadata_confirmed"]
    metadata_key: str | None
    playback_rate: Literal[1.0] = 1.0
    realtime_assumed: Literal[True] = True
    independently_verified: Literal[False] = False


class JobRequest(Model):
    video_id: OpaqueId
    name: str = Field(min_length=1, max_length=120)
    site: Site
    recording_start: str = Field(min_length=1, max_length=80)
    clock_source: Literal["manual", "metadata_confirmed"]
    metadata_key: str | None = Field(default=None, max_length=120)
    realtime_confirmed: Literal[True]
    fixed_camera_confirmed: Literal[True]
    device: Literal["cpu", "cuda"] = "cpu"

    @field_validator("recording_start")
    @classmethod
    def valid_start(cls, value: str) -> str:
        utc_datetime(value)
        return value

    @model_validator(mode="after")
    def bounded_geometry(self) -> Self:
        if len(self.site.zones) > 8 or len(self.site.gates) > 8:
            raise ValueError("This workspace supports at most eight zones and eight boundaries")
        if any(len(zone.polygon) > 24 for zone in self.site.zones):
            raise ValueError("A zone may have at most 24 vertices")
        if self.clock_source == "metadata_confirmed" and not self.metadata_key:
            raise ValueError("Select the metadata candidate that was checked")
        if self.clock_source == "manual" and self.metadata_key is not None:
            raise ValueError("Manual recording time must not claim a metadata source")
        return self


class AnalysisJob(Model):
    id: OpaqueId
    video_id: OpaqueId
    name: str
    site: Site
    clock: RecordingClock
    device: Literal["cpu", "cuda"]
    status: JobState
    phase: JobPhase
    created_at: UtcTime
    updated_at: UtcTime
    started_at: UtcTime | None
    finished_at: UtcTime | None
    duration_s: float = Field(gt=0)
    processed_frames: int = Field(ge=0)
    processed_media_s: float = Field(ge=0)
    phase_fraction: float | None = Field(ge=0, le=1)
    error: str | None
    bundle_url: str | None
    events_url: str | None
    export_url: str | None


class CameraPreset(Model):
    id: OpaqueId
    name: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    site: Site
    updated_at: UtcTime


class PresetRequest(Model):
    name: str = Field(min_length=1, max_length=120)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    site: Site

    @model_validator(mode="after")
    def bounded_geometry(self) -> Self:
        if len(self.site.zones) > 8 or len(self.site.gates) > 8:
            raise ValueError("At most eight zones and eight boundaries are supported")
        if any(len(zone.polygon) > 24 for zone in self.site.zones):
            raise ValueError("A zone may have at most 24 vertices")
        return self


class VideoResponse(Model):
    kind: Literal["analysis_video"] = "analysis_video"
    video: UploadedVideo


class VideosResponse(Model):
    kind: Literal["analysis_videos"] = "analysis_videos"
    videos: list[UploadedVideo]


class JobResponse(Model):
    kind: Literal["analysis_job"] = "analysis_job"
    job: AnalysisJob


class JobsResponse(Model):
    kind: Literal["analysis_jobs"] = "analysis_jobs"
    jobs: list[AnalysisJob]


class PresetsResponse(Model):
    kind: Literal["analysis_presets"] = "analysis_presets"
    presets: list[CameraPreset]


class CapabilitiesResponse(Model):
    kind: Literal["analysis_capabilities"] = "analysis_capabilities"
    max_upload_bytes: int = MAX_UPLOAD_BYTES
    max_duration_s: int = MAX_DURATION_SECONDS
    max_pixels: int = MAX_PIXELS
    max_run_s: int = MAX_RUN_SECONDS
    max_queued: int = MAX_QUEUED_JOBS
    active_workers: Literal[1] = 1
    model_files_present: bool
    inference_packages_present: bool
    timestamp_ocr_available: Literal[False] = False


class DeletedResponse(Model):
    kind: Literal["analysis_deleted"] = "analysis_deleted"
    video_id: OpaqueId


AnalysisResponse = (
    VideoResponse
    | VideosResponse
    | JobResponse
    | JobsResponse
    | PresetsResponse
    | CapabilitiesResponse
    | DeletedResponse
)
ANALYSIS_ADAPTER = TypeAdapter(AnalysisResponse)

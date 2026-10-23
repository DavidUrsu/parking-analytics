from __future__ import annotations

import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from parking_analytics.analysis_models import (
    MAX_QUEUED_JOBS,
    TERMINAL_STATES,
    AnalysisJob,
    CameraPreset,
    JobRequest,
    PresetRequest,
    RecordingClock,
    UploadedVideo,
)
from parking_analytics.monitoring_store import (
    ConflictError,
    MissingRecordError,
    database,
    inside_viewer,
    private_database_path,
    timestamp,
)
from parking_analytics.operations_models import utc_datetime


def media_root(path: Path) -> Path:
    path = private_database_path(path)
    root = path.parent / f"{path.stem}-media"
    if inside_viewer(root):
        raise ValueError("Analysis storage must stay outside served assets")
    return root


def video_directory(path: Path, video_id: str) -> Path:
    return private_directory(path, "videos", video_id)


def job_directory(path: Path, job_id: str) -> Path:
    return private_directory(path, "jobs", job_id)


def private_directory(path: Path, category: str, identifier: str) -> Path:
    if category not in ("videos", "jobs") or not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise ValueError("Invalid private media identifier")
    base = media_root(path).resolve()
    root = base / category
    target = root / identifier
    if target.is_symlink() or not root.resolve().is_relative_to(base):
        raise ValueError("Unexpected symbolic media directory")
    resolved = target.resolve()
    if resolved.parent != root.resolve() or resolved.name != identifier:
        raise ValueError("Invalid private media path")
    return resolved


def save_video(path: Path, video: UploadedVideo) -> None:
    with database(path, write=True) as connection:
        connection.execute(
            "INSERT INTO analysis_videos(id,payload) VALUES(?,?)",
            (video.id, video.model_dump_json()),
        )


def get_video(path: Path, video_id: str) -> UploadedVideo:
    with database(path) as connection:
        row = connection.execute(
            "SELECT payload FROM analysis_videos WHERE id=?", (video_id,)
        ).fetchone()
    if row is None:
        raise MissingRecordError("Private video was not found")
    return UploadedVideo.model_validate_json(row["payload"])


def list_videos(path: Path) -> list[UploadedVideo]:
    with database(path) as connection:
        rows = connection.execute(
            "SELECT payload FROM analysis_videos ORDER BY rowid DESC"
        ).fetchall()
    return [UploadedVideo.model_validate_json(row["payload"]) for row in rows]


def get_job(path: Path, job_id: str) -> AnalysisJob:
    with database(path) as connection:
        row = connection.execute(
            "SELECT payload FROM analysis_jobs WHERE id=?", (job_id,)
        ).fetchone()
    if row is None:
        raise MissingRecordError("Analysis job was not found")
    return AnalysisJob.model_validate_json(row["payload"])


def list_jobs(path: Path) -> list[AnalysisJob]:
    with database(path) as connection:
        rows = connection.execute(
            "SELECT payload FROM analysis_jobs ORDER BY created_at DESC,id DESC LIMIT 100"
        ).fetchall()
    return [AnalysisJob.model_validate_json(row["payload"]) for row in rows]


def create_job(path: Path, request: JobRequest) -> AnalysisJob:
    video = get_video(path, request.video_id)
    start = utc_datetime(request.recording_start)
    if request.clock_source == "metadata_confirmed":
        candidate = next(
            (item for item in video.timestamp_candidates if item.key == request.metadata_key), None
        )
        if candidate is None:
            raise ValueError("Selected recording-time metadata was not found")
        if candidate.parsed_utc is None:
            raise ValueError(
                "Selected metadata has no complete timezone-aware date/time; use manual start"
            )
        if candidate.parsed_utc != start:
            raise ValueError(
                "Metadata-derived time differs; choose manual time for an adjusted start"
            )
    now = datetime.now(UTC)
    job = AnalysisJob(
        id=uuid4().hex,
        video_id=video.id,
        name=request.name,
        site=request.site,
        clock=RecordingClock(
            start_utc=start,
            original_start=request.recording_start,
            source=request.clock_source,
            metadata_key=request.metadata_key,
        ),
        device=request.device,
        status="queued",
        phase="queued",
        created_at=now,
        updated_at=now,
        started_at=None,
        finished_at=None,
        duration_s=video.duration_s,
        processed_frames=0,
        processed_media_s=0.0,
        phase_fraction=None,
        error=None,
        bundle_url=None,
        events_url=None,
        export_url=None,
    )
    with database(path, write=True) as connection:
        if (
            connection.execute("SELECT 1 FROM analysis_videos WHERE id=?", (video.id,)).fetchone()
            is None
        ):
            raise MissingRecordError("Video was removed before the job was queued")
        waiting = connection.execute(
            "SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('queued','running','cancelling')"
        ).fetchone()[0]
        if waiting >= MAX_QUEUED_JOBS:
            raise ConflictError("The bounded analysis queue is full; wait or cancel a job")
        connection.execute(
            "INSERT INTO analysis_jobs(id,video_id,status,created_at,payload) VALUES(?,?,?,?,?)",
            (job.id, job.video_id, job.status, timestamp(job.created_at), job.model_dump_json()),
        )
    return job


def update_job(path: Path, job_id: str, **changes) -> AnalysisJob:
    with database(path, write=True) as connection:
        row = connection.execute(
            "SELECT payload FROM analysis_jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            raise MissingRecordError("Analysis job was not found")
        current = AnalysisJob.model_validate_json(row["payload"])
        if current.status in TERMINAL_STATES:
            return current
        if current.status == "cancelling" and changes.get("status") == "running":
            changes.pop("status")
        if current.status == "cancelling" and changes.get("status") == "succeeded":
            changes |= {
                "status": "cancelled",
                "phase": "finished",
                "finished_at": datetime.now(UTC),
                "error": "Cancelled during finalization; partial results are not published",
                "bundle_url": None,
                "events_url": None,
                "export_url": None,
            }
        changes["updated_at"] = datetime.now(UTC)
        updated = current.model_copy(update=changes)
        updated = AnalysisJob.model_validate_json(updated.model_dump_json())
        connection.execute(
            "UPDATE analysis_jobs SET status=?,payload=? WHERE id=?",
            (updated.status, updated.model_dump_json(), job_id),
        )
    return updated


def claim_next_job(path: Path) -> AnalysisJob | None:
    with database(path, write=True) as connection:
        if connection.execute(
            "SELECT 1 FROM analysis_jobs WHERE status IN ('running','cancelling') LIMIT 1"
        ).fetchone():
            return None
        row = connection.execute(
            "SELECT payload FROM analysis_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        current = AnalysisJob.model_validate_json(row["payload"])
        now = datetime.now(UTC)
        active = current.model_copy(
            update={
                "status": "running",
                "phase": "waiting_resource",
                "started_at": now,
                "updated_at": now,
            }
        )
        connection.execute(
            "UPDATE analysis_jobs SET status=?,payload=? WHERE id=?",
            (active.status, active.model_dump_json(), active.id),
        )
    return active


def cancel_job(path: Path, job_id: str) -> AnalysisJob:
    with database(path, write=True) as connection:
        row = connection.execute(
            "SELECT payload FROM analysis_jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            raise MissingRecordError("Analysis job was not found")
        current = AnalysisJob.model_validate_json(row["payload"])
        if current.status in TERMINAL_STATES:
            return current
        now = datetime.now(UTC)
        changes = {"updated_at": now, "status": "cancelling"}
        if current.status == "queued":
            changes |= {
                "status": "cancelled",
                "phase": "finished",
                "finished_at": now,
                "error": "Cancelled before processing",
            }
        updated = current.model_copy(update=changes)
        connection.execute(
            "UPDATE analysis_jobs SET status=?,payload=? WHERE id=?",
            (updated.status, updated.model_dump_json(), job_id),
        )
    return updated


def recover_interrupted_jobs(path: Path) -> None:
    with database(path) as connection:
        ids = [
            row[0]
            for row in connection.execute(
                "SELECT id FROM analysis_jobs WHERE status IN ('running','cancelling')"
            )
        ]
    for job_id in ids:
        update_job(
            path,
            job_id,
            status="failed",
            phase="finished",
            finished_at=datetime.now(UTC),
            error="Processing was interrupted by a server restart; submit a new job",
        )


def list_presets(path: Path) -> list[CameraPreset]:
    with database(path) as connection:
        rows = connection.execute(
            "SELECT payload FROM analysis_presets ORDER BY name,id"
        ).fetchall()
    return [CameraPreset.model_validate_json(row["payload"]) for row in rows]


def save_preset(path: Path, request: PresetRequest) -> CameraPreset:
    preset = CameraPreset(
        id=uuid4().hex,
        name=request.name,
        width=request.width,
        height=request.height,
        site=request.site,
        updated_at=datetime.now(UTC),
    )
    with database(path, write=True) as connection:
        connection.execute(
            "INSERT INTO analysis_presets(id,name,payload) VALUES(?,?,?)",
            (preset.id, preset.name, preset.model_dump_json()),
        )
    return preset


def delete_video(path: Path, video_id: str) -> None:
    get_video(path, video_id)
    with database(path, write=True) as connection:
        rows = connection.execute(
            "SELECT id,status FROM analysis_jobs WHERE video_id=?", (video_id,)
        ).fetchall()
        if any(row["status"] not in TERMINAL_STATES for row in rows):
            raise ConflictError("Cancel or finish related jobs before deleting a video")
        directories = [job_directory(path, row["id"]) for row in rows]
        directories.append(video_directory(path, video_id))
        for folder in directories:
            if folder.exists() and folder.is_symlink():
                raise ValueError("Refusing to delete an unexpected symbolic media directory")
        for folder in directories:
            if folder.exists():
                # Database-owned IDs are constrained to their private media root.
                shutil.rmtree(folder)
        connection.execute("DELETE FROM analysis_jobs WHERE video_id=?", (video_id,))
        connection.execute("DELETE FROM analysis_videos WHERE id=?", (video_id,))

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import unquote
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi import Path as ApiPath
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from parking_analytics.analysis_manager import AnalysisManager, capabilities
from parking_analytics.analysis_media import probe_upload
from parking_analytics.analysis_models import (
    MAX_UPLOAD_BYTES,
    CapabilitiesResponse,
    DeletedResponse,
    JobRequest,
    JobResponse,
    JobsResponse,
    PresetRequest,
    PresetsResponse,
    VideoResponse,
    VideosResponse,
)
from parking_analytics.analysis_store import (
    cancel_job,
    create_job,
    delete_video,
    get_job,
    get_video,
    job_directory,
    list_jobs,
    list_presets,
    list_videos,
    save_preset,
    save_video,
    video_directory,
)
from parking_analytics.io import read_model
from parking_analytics.models import Bundle
from parking_analytics.monitoring_store import ConflictError

ResourceId = Annotated[str, ApiPath(pattern=r"^[0-9a-f]{32}$")]


def analysis_router(database_path: Path, manager: AnalysisManager) -> APIRouter:
    router = APIRouter(prefix="/api/analysis")

    @router.get("/capabilities", response_model=CapabilitiesResponse)
    def limits():
        return capabilities()

    @router.get("/videos", response_model=VideosResponse)
    def videos():
        return VideosResponse(videos=list_videos(database_path))

    @router.post("/videos", response_model=VideoResponse)
    async def upload(
        request: Request,
        permission: Annotated[str | None, Header(alias="X-Analysis-Permission")] = None,
        filename: Annotated[str | None, Header(alias="X-Upload-Name")] = None,
        content_kind: Annotated[
            Literal["recording", "synthetic_test"], Header(alias="X-Analysis-Content-Kind")
        ] = "recording",
    ):
        if permission != "confirmed":
            raise HTTPException(422, "Confirm authorization before importing a private recording")
        if filename is None:
            raise HTTPException(422, "Supply the recording filename")
        name = unquote(filename, errors="strict")
        if not 1 <= len(name) <= 160 or any(ord(character) < 32 for character in name):
            raise HTTPException(
                422, "Use a filename of 1-160 characters without control characters"
            )
        if request.headers.get("content-length"):
            try:
                advertised = int(request.headers["content-length"])
            except ValueError as error:
                raise HTTPException(400, "Invalid upload length") from error
            if not 0 < advertised <= MAX_UPLOAD_BYTES:
                raise HTTPException(413, "Recording must be nonempty and at most 512 MiB")
        identifier = uuid4().hex
        directory = video_directory(database_path, identifier)
        directory.mkdir(parents=True, exist_ok=False)
        partial = directory / "source.part"
        source = directory / "source.bin"
        preview = directory / "preview.jpg"
        accepted = False
        try:
            size = 0
            with partial.open("xb") as output:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "Recording exceeds the 512 MiB limit")
                    await run_in_threadpool(output.write, chunk)
            partial.replace(source)
            video = await run_in_threadpool(
                probe_upload, source, identifier, name, content_kind, preview
            )
            save_video(database_path, video)
            accepted = True
            return VideoResponse(video=video)
        except ClientDisconnect as error:
            raise HTTPException(
                400, "Upload was interrupted; no recording was registered"
            ) from error
        finally:
            if not accepted:
                for path in (partial, source, preview):
                    path.unlink(missing_ok=True)
                directory.rmdir()

    @router.get("/videos/{video_id}/preview")
    def preview(video_id: ResourceId):
        get_video(database_path, video_id)
        return FileResponse(
            video_directory(database_path, video_id) / "preview.jpg", media_type="image/jpeg"
        )

    @router.api_route("/videos/{video_id}/source", methods=["GET", "HEAD"])
    def source(video_id: ResourceId):
        video = get_video(database_path, video_id)
        mime = (
            "video/mp4"
            if re.search(r"mov|mp4", video.container_format)
            else ("video/x-msvideo" if video.container_format == "avi" else "video/webm")
        )
        return FileResponse(
            video_directory(database_path, video_id) / "source.bin",
            media_type=mime,
            filename=video.original_name,
            content_disposition_type="inline",
        )

    @router.post("/videos/{video_id}/delete", response_model=DeletedResponse)
    def remove_video(video_id: ResourceId):
        related = [job.id for job in list_jobs(database_path) if job.video_id == video_id]
        delete_video(database_path, video_id)
        for job_id in related:
            manager.integrity_cache.pop(job_id, None)
        return DeletedResponse(video_id=video_id)

    @router.get("/presets", response_model=PresetsResponse)
    def presets():
        return PresetsResponse(presets=list_presets(database_path))

    @router.post("/presets", response_model=PresetsResponse)
    def preset(request: PresetRequest):
        save_preset(database_path, request)
        return PresetsResponse(presets=list_presets(database_path))

    @router.get("/jobs", response_model=JobsResponse)
    def jobs():
        return JobsResponse(jobs=list_jobs(database_path))

    @router.post("/jobs", response_model=JobResponse)
    def submit(request: JobRequest):
        ready = capabilities()
        if not ready.model_files_present or not ready.inference_packages_present:
            raise ConflictError(
                "Install inference extras and run parking fetch before starting analysis"
            )
        job = create_job(database_path, request)
        manager.wake.set()
        return JobResponse(job=job)

    @router.get("/jobs/{job_id}", response_model=JobResponse)
    def job(job_id: ResourceId):
        return JobResponse(job=get_job(database_path, job_id))

    @router.post("/jobs/{job_id}/cancel", response_model=JobResponse)
    def cancel(job_id: ResourceId):
        result = cancel_job(database_path, job_id)
        manager.wake.set()
        return JobResponse(job=result)

    def completed_file(job_id: str, name: str) -> Path:
        result = get_job(database_path, job_id)
        if result.status != "succeeded":
            raise ConflictError("Partial, failed or cancelled analysis is not a completed result")
        path = job_directory(database_path, job_id) / name
        if not path.is_file():
            raise ConflictError("Completed result file is missing")
        return path

    @router.get("/jobs/{job_id}/bundle", response_model=Bundle)
    def bundle(job_id: ResourceId):
        return read_model(completed_file(job_id, "bundle.json"), Bundle)

    @router.api_route("/jobs/{job_id}/media/recording.mp4", methods=["GET", "HEAD"])
    def replay_media(job_id: ResourceId):
        path, digest = manager.verified_result_media(job_id)
        return FileResponse(
            path,
            media_type="video/mp4",
            headers={"X-Content-SHA256": digest, "X-Integrity-Check": "server-verified"},
        )

    @router.get("/jobs/{job_id}/events.csv")
    def event_export(job_id: ResourceId):
        return FileResponse(
            completed_file(job_id, "events.csv"),
            media_type="text/csv",
            filename=f"private-analysis-{job_id}.csv",
        )

    @router.get("/jobs/{job_id}/result.json")
    def result_export(job_id: ResourceId):
        return FileResponse(
            completed_file(job_id, "result.json"),
            media_type="application/json",
            filename=f"private-analysis-{job_id}.json",
        )

    return router

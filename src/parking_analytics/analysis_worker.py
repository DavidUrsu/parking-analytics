from __future__ import annotations

import argparse
import csv
import os
import sys
import threading
import time
from datetime import timedelta
from pathlib import Path

import av

from parking_analytics.analysis_lock import AnalysisLock
from parking_analytics.analysis_media import prepare_private_video
from parking_analytics.analysis_models import MAX_RUN_SECONDS
from parking_analytics.analysis_store import (
    get_job,
    get_video,
    job_directory,
    update_job,
    video_directory,
)
from parking_analytics.io import read_model, sha256, verify_source, write_json
from parking_analytics.models import Attribution, Bundle, Config, ReplayClip, Segment, Source
from parking_analytics.monitoring_store import ROOT
from parking_analytics.pipeline import Detector, analyze_media, run_provenance


class JobCancelled(RuntimeError):
    pass


def run_job(database_path: Path, job_id: str) -> None:
    started = time.monotonic()
    deadline = started + MAX_RUN_SECONDS
    last_check = 0.0
    last_report = 0.0
    job = get_job(database_path, job_id)
    video = get_video(database_path, job.video_id)
    directory = job_directory(database_path, job_id)
    directory.mkdir(parents=True, exist_ok=True)

    def checkpoint() -> None:
        nonlocal last_check
        now = time.monotonic()
        if now >= deadline:
            raise TimeoutError("Analysis reached its hard 30-minute limit")
        if now - last_check >= 0.2:
            status = get_job(database_path, job_id).status
            if status != "running":
                raise JobCancelled("Analysis was cancelled or interrupted")
            last_check = now

    def progress(phase: str, frames: int, elapsed: float) -> None:
        nonlocal last_report
        checkpoint()
        if time.monotonic() - last_report >= 0.5:
            current = get_job(database_path, job_id)
            update_job(
                database_path,
                job_id,
                phase=phase,
                processed_frames=frames,
                processed_media_s=elapsed,
                phase_fraction=min(1.0, elapsed / current.duration_s),
            )
            last_report = time.monotonic()

    execution = AnalysisLock(ROOT / ".cache" / "vehicle-analysis.lock")
    try:
        while not execution.acquire():
            checkpoint()
            time.sleep(0.2)
        checkpoint()
        original = video_directory(database_path, video.id) / "source.bin"
        verify_source(original, video.bytes, video.sha256)
        media = directory / "media" / "recording.mp4"
        update_job(database_path, job_id, phase="preparing_media", phase_fraction=None)
        width, height, duration = prepare_private_video(
            original,
            media,
            video,
            checkpoint,
            lambda count, elapsed: progress("preparing_media", count, elapsed),
        )
        update_job(
            database_path,
            job_id,
            duration_s=duration,
            phase="loading_model",
            processed_frames=0,
            processed_media_s=0.0,
            phase_fraction=None,
        )
        template = read_model(ROOT / "configs" / "meva-g328.json", Config)
        source = Source(
            url=video.source_url,
            file=f"upload-{video.id}.bin",
            bytes=video.bytes,
            sha256=video.sha256,
            width=video.width,
            height=video.height,
            duration_s=duration,
        )
        segment = Segment(
            id="recording",
            name={"en": job.name, "ro": job.name},
            split="development",
            source=source,
            start_s=0.0,
            end_s=duration,
        )
        config = template.model_copy(
            update={
                "site": job.site,
                "source_clock": "media_pts",
                "crop": (0, 0, video.width, video.height),
                "export_size": (width, height),
                "clips": [segment],
                "protocol": template.protocol.model_copy(
                    update={
                        "version": "private-upload-v1",
                        "notes": (
                            "Operator-defined fixed-camera zones/boundaries. Frozen RT-DETR-R18, "
                            "shared vehicle NMS and ByteTrack/IoU comparison; no quality claim or "
                            "ground truth. Recording UTC is a confirmed first-frame time plus "
                            "media seconds under an explicit 1x assumption."
                        ),
                    }
                ),
            }
        )
        config = Config.model_validate_json(config.model_dump_json())
        checkpoint()
        detector = Detector(config, ROOT / "models" / "rtdetr-r18", job.device)
        checkpoint()
        update_job(
            database_path,
            job_id,
            phase="analyzing",
            processed_frames=0,
            processed_media_s=0.0,
            phase_fraction=0.0,
        )
        baseline, candidate, moments = analyze_media(
            config,
            media,
            duration,
            detector,
            deadline,
            checkpoint=checkpoint,
            progress=lambda count, elapsed: progress("analyzing", count, elapsed),
        )
        checkpoint()
        update_job(database_path, job_id, phase="finalizing", phase_fraction=None)
        bundle = Bundle(
            schema_version="1.0",
            synthetic=video.content_kind == "synthetic_test",
            site=job.site,
            protocol=config.protocol,
            analysis_fps=config.analysis_fps,
            stale_after_s=config.stale_after_s,
            run=run_provenance(config, detector, started),
            attribution=Attribution(
                title=f"Private upload: {video.original_name}",
                creator="Operator-authorized local input",
                source_url=video.source_url,
                license="Private analysis permission; no redistribution clearance",
                license_url=None,
                modifications=(
                    f"Orientation normalization ({video.rotation_degrees} degrees), resizing, "
                    "H.264 transcoding, audio omitted; separate model overlays. "
                    "Recording UTC uses the operator-confirmed first-frame time "
                    "and the 1x assumption."
                ),
                staged_scenarios=video.content_kind == "synthetic_test",
                public_presentation_cleared=False,
            ),
            clips=[
                ReplayClip(
                    id="recording",
                    name=segment.name,
                    split="development",
                    source=source,
                    source_start_s=0.0,
                    source_clock="media_pts",
                    crop=config.crop,
                    width=width,
                    height=height,
                    duration_s=duration,
                    video="media/recording.mp4",
                    video_sha256=sha256(media),
                    baseline=baseline,
                    candidate=candidate,
                    review_moments=moments,
                )
            ],
            reference=None,
            evaluation=None,
        )
        bundle = Bundle.model_validate_json(bundle.model_dump_json())
        write_json(directory / "bundle.json", bundle)
        with (directory / "events.csv").open("x", newline="", encoding="utf-8") as output:
            writer = csv.writer(output)
            writer.writerow(
                [
                    "job_id",
                    "method",
                    "clip_time_s",
                    "event_utc",
                    "gate_id",
                    "direction",
                    "clip_track_id",
                    "clock_basis",
                    "playback_rate_assumed",
                ]
            )
            for method, result in (("baseline", baseline), ("candidate", candidate)):
                for event in result.events:
                    at = job.clock.start_utc + timedelta(seconds=event.time_s)
                    writer.writerow(
                        [
                            job_id,
                            method,
                            event.time_s,
                            at.isoformat(),
                            event.gate_id,
                            event.direction,
                            event.track_id,
                            job.clock.source,
                            "1.0",
                        ]
                    )
        write_json(
            directory / "result.json",
            {
                "schema_version": "1.0",
                "job_id": job_id,
                "recording_clock": job.clock.model_dump(mode="json"),
                "input_video": video.model_dump(mode="json"),
                "bundle": bundle.model_dump(mode="json"),
            },
        )
        checkpoint()
        update_job(
            database_path,
            job_id,
            processed_frames=len(candidate.samples),
            processed_media_s=duration,
            phase_fraction=1.0,
        )
    finally:
        execution.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()
    watchdog = threading.Timer(MAX_RUN_SECONDS, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    try:
        run_job(args.database, args.job_id)
    except JobCancelled as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(3) from error
    except (ValueError, OSError, RuntimeError, TimeoutError, av.FFmpegError) as error:
        print(f"Analysis failed: {error}", file=sys.stderr)
        raise SystemExit(2) from error
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    main()

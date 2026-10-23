from __future__ import annotations

import importlib.util
import logging
import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from parking_analytics.analysis_lock import AnalysisLock
from parking_analytics.analysis_models import MAX_RUN_SECONDS, AnalysisJob, CapabilitiesResponse
from parking_analytics.analysis_store import (
    claim_next_job,
    get_job,
    job_directory,
    media_root,
    recover_interrupted_jobs,
    update_job,
)
from parking_analytics.cli import validate_assets
from parking_analytics.io import read_model, sha256
from parking_analytics.models import Bundle
from parking_analytics.monitoring_store import ROOT, ConflictError

logger = logging.getLogger(__name__)
POLL_SECONDS = 0.2
CANCEL_GRACE_SECONDS = 3.0


def capabilities() -> CapabilitiesResponse:
    model = ROOT / "models" / "rtdetr-r18"
    return CapabilitiesResponse(
        model_files_present=all(
            (model / name).is_file()
            for name in (
                "model.safetensors",
                "config.json",
                "preprocessor_config.json",
                "README.md",
            )
        ),
        inference_packages_present=all(
            importlib.util.find_spec(name) is not None
            for name in ("torch", "torchvision", "transformers", "supervision")
        ),
    )


def terminate_worker(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


class AnalysisManager:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.thread: threading.Thread | None = None
        self.lock: AnalysisLock | None = None
        self.process: subprocess.Popen | None = None
        self.integrity_cache: dict[str, tuple[int, int, int, str]] = {}

    def verified_result_media(self, job_id: str) -> tuple[Path, str]:
        job = get_job(self.path, job_id)
        if job.status != "succeeded":
            raise ConflictError("Analysis media is available only after a successful complete job")
        directory = job_directory(self.path, job_id)
        media = directory / "media" / "recording.mp4"
        manifest = directory / "bundle.json"
        try:
            stat = media.stat()
            manifest_time = manifest.stat().st_mtime_ns
        except OSError as error:
            raise ConflictError(
                "Private replay media/manifest is missing or unreadable; "
                "restore it or rerun analysis"
            ) from error
        cached = self.integrity_cache.get(job_id)
        if cached is not None and cached[:3] == (stat.st_size, stat.st_mtime_ns, manifest_time):
            return media, cached[3]
        bundle = read_model(manifest, Bundle)
        expected = bundle.clips[0].video_sha256
        if sha256(media) != expected:
            raise ConflictError(
                "Private replay checksum mismatch; media will not be presented as valid"
            )
        self.integrity_cache[job_id] = (stat.st_size, stat.st_mtime_ns, manifest_time, expected)
        return media, expected

    def start(self) -> None:
        self.lock = AnalysisLock(media_root(self.path) / "manager.lock")
        if not self.lock.acquire():
            self.lock.close()
            self.lock = None
            raise ConflictError("Another operations server owns this analysis database")
        try:
            recover_interrupted_jobs(self.path)
            self.thread = threading.Thread(target=self._run, name="parking-analysis", daemon=True)
            self.thread.start()
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            self.lock.close()
            self.lock = None
            raise

    def stop(self) -> None:
        self.stopping.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(timeout=10)
            if self.thread.is_alive():
                if self.process is not None:
                    terminate_worker(self.process)
                self.thread.join(timeout=5)
            if self.thread.is_alive():
                logger.error("Analysis scheduler did not stop within its bounded shutdown")
        if self.lock is not None:
            self.lock.close()
            self.lock = None

    def _run(self) -> None:
        while not self.stopping.is_set():
            job = None
            try:
                job = claim_next_job(self.path)
                if job is None:
                    self.wake.wait(timeout=0.5)
                    self.wake.clear()
                    continue
                self._process(job)
            except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
                if job is not None:
                    try:
                        update_job(
                            self.path,
                            job.id,
                            status="failed",
                            phase="finished",
                            finished_at=datetime.now(UTC),
                            error=f"Scheduler failed: {error}",
                        )
                    except (OSError, ValueError, RuntimeError, sqlite3.Error):
                        logger.exception("Analysis failure could not be persisted")
                logger.exception("Analysis scheduler failed; no result was marked successful")
                self.wake.wait(timeout=1)
                self.wake.clear()

    def _process(self, job: AnalysisJob) -> None:
        directory = job_directory(self.path, job.id)
        directory.mkdir(parents=True, exist_ok=True)
        log = directory / "worker.log"
        started = time.monotonic()
        cancelled_at: float | None = None
        timed_out = False
        try:
            env = os.environ | {
                "HF_HOME": str(ROOT / "models" / "hub"),
                "HF_HUB_OFFLINE": "1",
                "MPLCONFIGDIR": str(ROOT / ".cache" / "matplotlib"),
                "PYTHONUNBUFFERED": "1",
            }
            with log.open("xb") as output:
                self.process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "parking_analytics.analysis_worker",
                        "--database",
                        str(self.path),
                        "--job-id",
                        job.id,
                    ],
                    cwd=ROOT,
                    env=env,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
                while self.process.poll() is None:
                    current = get_job(self.path, job.id)
                    stopping = self.stopping.is_set()
                    cancelled = current.status in ("cancelling", "cancelled", "failed") or stopping
                    if cancelled and cancelled_at is None:
                        cancelled_at = time.monotonic()
                    if time.monotonic() - started >= MAX_RUN_SECONDS:
                        timed_out = True
                        terminate_worker(self.process)
                        break
                    if (
                        cancelled_at is not None
                        and time.monotonic() - cancelled_at >= CANCEL_GRACE_SECONDS
                    ):
                        terminate_worker(self.process)
                        break
                    time.sleep(POLL_SECONDS)
                code = self.process.wait(timeout=3)
            current = get_job(self.path, job.id)
            if timed_out:
                update_job(
                    self.path,
                    job.id,
                    status="failed",
                    phase="finished",
                    finished_at=datetime.now(UTC),
                    error="Analysis exceeded the hard 30-minute budget",
                )
            elif cancelled_at is not None or current.status in ("cancelling", "cancelled"):
                update_job(
                    self.path,
                    job.id,
                    status="cancelled",
                    phase="finished",
                    finished_at=datetime.now(UTC),
                    error="Cancelled; partial results are not published",
                )
            elif code == 0:
                bundle = read_model(directory / "bundle.json", Bundle)
                validate_assets(bundle, directory)
                if (
                    not (directory / "events.csv").is_file()
                    or not (directory / "result.json").is_file()
                ):
                    raise ValueError("Worker did not produce a complete export")
                update_job(
                    self.path,
                    job.id,
                    status="succeeded",
                    phase="finished",
                    finished_at=datetime.now(UTC),
                    error=None,
                    phase_fraction=1.0,
                    bundle_url=f"/api/analysis/jobs/{job.id}/bundle",
                    events_url=f"/api/analysis/jobs/{job.id}/events.csv",
                    export_url=f"/api/analysis/jobs/{job.id}/result.json",
                )
            else:
                details = log.read_text(encoding="utf-8", errors="replace")[-1600:]
                update_job(
                    self.path,
                    job.id,
                    status="failed",
                    phase="finished",
                    finished_at=datetime.now(UTC),
                    error=details or f"Worker exited with status {code}",
                )
        except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
            if self.process is not None:
                terminate_worker(self.process)
            update_job(
                self.path,
                job.id,
                status="failed",
                phase="finished",
                finished_at=datetime.now(UTC),
                error=f"Analysis failed: {error}",
            )
            logger.error("Analysis job %s failed; see its private worker log", job.id)
        finally:
            self.process = None

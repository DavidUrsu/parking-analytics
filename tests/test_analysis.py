import csv
import json
import shutil
import sqlite3
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import av
import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from parking_analytics.analysis_lock import AnalysisLock
from parking_analytics.analysis_media import (
    prepare_private_video,
    probe_upload,
    timestamp_candidates,
    validate_container_signature,
)
from parking_analytics.analysis_models import (
    ANALYSIS_ADAPTER,
    CapabilitiesResponse,
    JobRequest,
    PresetRequest,
)
from parking_analytics.analysis_store import (
    cancel_job,
    claim_next_job,
    create_job,
    delete_video,
    get_job,
    get_video,
    job_directory,
    list_presets,
    save_preset,
    save_video,
    update_job,
    video_directory,
)
from parking_analytics.models import Site
from parking_analytics.monitoring_store import (
    APPLICATION_ID,
    ConflictError,
    initialize_database,
    list_sites,
    private_database_path,
)


def make_video(path: Path, *, times=None, creation_time=None):
    times = times or [index / 10 for index in range(20)]
    with av.open(str(path), "w") as output:
        if creation_time:
            output.metadata["creation_time"] = creation_time
        stream = output.add_stream("libx264", rate=10)
        stream.width, stream.height, stream.pix_fmt = 320, 180, "yuv420p"
        stream.codec_context.time_base = Fraction(1, 1_000_000)
        for index, at in enumerate(times):
            image = Image.new("RGB", (320, 180), "#203040")
            ImageDraw.Draw(image).rectangle((20 + index, 50, 60 + index, 80), fill="yellow")
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = round(at * 1_000_000), Fraction(1, 1_000_000)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


@pytest.fixture
def private_video(tmp_path, smoke):
    path = tmp_path / "analysis.sqlite3"
    initialize_database(path)
    identifier = uuid4().hex
    directory = video_directory(path, identifier)
    directory.mkdir(parents=True)
    source = directory / "source.bin"
    with av.open(str(source), "w", format="mp4") as output:
        output.metadata["creation_time"] = "2026-01-15T08:00:00Z"
        stream = output.add_stream("libx264", rate=10)
        stream.width, stream.height, stream.pix_fmt = 320, 180, "yuv420p"
        for index in range(20):
            frame = av.VideoFrame.from_image(Image.new("RGB", (320, 180), "#26394b"))
            frame.pts, frame.time_base = index, Fraction(1, 10)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    video = probe_upload(
        source, identifier, "synthetic-private.mp4", "synthetic_test", directory / "preview.jpg"
    )
    save_video(path, video)
    site = smoke[0].site
    return path, video, site


def request_for(video, geometry, **changes):
    payload = {
        "video_id": video.id,
        "name": "Synthetic source-clock test",
        "site": geometry.model_dump(mode="json"),
        "recording_start": "2026-01-15T10:00:00+02:00",
        "clock_source": "manual",
        "metadata_key": None,
        "realtime_confirmed": True,
        "fixed_camera_confirmed": True,
        "device": "cpu",
    } | changes
    return JobRequest.model_validate_json(json.dumps(payload))


def test_metadata_dates_are_candidates_not_capture_certificates():
    candidates = timestamp_candidates(
        [
            (
                "container",
                {
                    "creation_time": "2026-01-15T10:00:00+02:00",
                    "date": "2026-01-15T10:00:00",
                    "timecode": "10:00:00:00",
                    "location": "PRIVATE GPS MUST NOT BE COPIED",
                },
            )
        ]
    )
    assert len(candidates) == 3
    assert candidates[0].parsed_utc == datetime(2026, 1, 15, 8, tzinfo=UTC)
    assert not candidates[0].needs_timezone
    assert candidates[1].parsed_utc is None and candidates[1].needs_timezone
    assert candidates[2].parsed_utc is None
    assert all("PRIVATE GPS" not in candidate.model_dump_json() for candidate in candidates)


def test_probe_reports_real_clock_candidates_and_no_burned_in_ocr(private_video):
    _, video, _ = private_video
    assert video.width == 320 and video.height == 180
    assert video.duration_s == pytest.approx(2)
    assert video.timestamp_candidates[0].parsed_utc == datetime(2026, 1, 15, 8, tzinfo=UTC)
    assert video.burned_in_timestamp_checked is False
    assert video.source_url.endswith(f"{video.id}/source")


def test_manual_time_offset_and_explicit_realtime_confirmation(private_video):
    path, video, site = private_video
    job = create_job(path, request_for(video, site))
    assert job.clock.start_utc == datetime(2026, 1, 15, 8, tzinfo=UTC)
    assert job.clock.original_start.endswith("+02:00")
    assert job.clock.playback_rate == 1.0 and not job.clock.independently_verified
    for update in [
        {"recording_start": "2026-01-15T10:00:00"},
        {"realtime_confirmed": False},
        {"fixed_camera_confirmed": False},
        {"recording_start": ""},
    ]:
        with pytest.raises(ValidationError):
            request_for(video, site, **update)
    at = job.clock.start_utc + timedelta(seconds=2.25)
    assert at.isoformat() == "2026-01-15T08:00:02.250000+00:00"


def test_metadata_time_must_be_explicitly_confirmed_and_match(private_video, monkeypatch):
    path, video, site = private_video
    key = video.timestamp_candidates[0].key
    job = create_job(
        path, request_for(video, site, clock_source="metadata_confirmed", metadata_key=key)
    )
    assert job.clock.source == "metadata_confirmed"
    with pytest.raises(ValueError, match="differs"):
        create_job(
            path,
            request_for(
                video,
                site,
                clock_source="metadata_confirmed",
                metadata_key=key,
                recording_start="2026-01-15T11:00:00+02:00",
            ),
        )
    with pytest.raises(ValueError, match="not found"):
        create_job(
            path,
            request_for(video, site, clock_source="metadata_confirmed", metadata_key="unknown"),
        )
    ambiguous = timestamp_candidates([("container", {"date": "2026-01-15T10:00:00"})])[0]
    monkeypatch.setattr(
        "parking_analytics.analysis_store.get_video",
        lambda *_: video.model_copy(update={"timestamp_candidates": [ambiguous]}),
    )
    with pytest.raises(ValueError, match="use manual"):
        create_job(
            path,
            request_for(video, site, clock_source="metadata_confirmed", metadata_key=ambiguous.key),
        )


def test_queue_cancel_and_partial_results_are_not_success(private_video):
    path, video, site = private_video
    first = create_job(path, request_for(video, site))
    second = create_job(path, request_for(video, site))
    assert claim_next_job(path).id == first.id
    assert claim_next_job(path) is None
    assert cancel_job(path, second.id).status == "cancelled"
    assert cancel_job(path, first.id).status == "cancelling"
    assert update_job(path, first.id, status="running").status == "cancelling"
    assert get_job(path, first.id).bundle_url is None
    with pytest.raises(ConflictError):
        delete_video(path, video.id)
    update_job(
        path,
        first.id,
        status="cancelled",
        phase="finished",
        finished_at=datetime.now(UTC),
        error="test cancellation",
    )
    delete_video(path, video.id)
    with pytest.raises(ValueError, match="not found"):
        get_video(path, video.id)


def test_queue_is_bounded_and_presets_preserve_geometry(private_video):
    path, video, site = private_video
    for _ in range(5):
        create_job(path, request_for(video, site))
    with pytest.raises(ConflictError, match="full"):
        create_job(path, request_for(video, site))
    preset = save_preset(
        path, PresetRequest(name="Fixed test camera", width=320, height=180, site=site)
    )
    assert list_presets(path)[0] == preset


def test_unsafe_geometry_and_non_numeric_coordinates_are_rejected(private_video):
    _, video, site = private_video
    data = site.model_dump(mode="json")
    data["zones"][0]["polygon"] = [
        [0.1, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
        [0.9, 0.1],
        [0.5, 0.95],
    ]
    with pytest.raises(ValidationError):
        Site.model_validate_json(json.dumps(data))
    data = site.model_dump(mode="json")
    data["zones"][0]["polygon"][0][0] = "0.5"
    with pytest.raises(ValidationError):
        request_for(video, site, site=data)


def test_video_normalization_preserves_variable_presentation_times(tmp_path):
    path = tmp_path / "variable.mp4"
    times = [0.0, 0.04, 0.17, 0.21, 0.8, 0.93]
    make_video(path, times=times)
    identifier = uuid4().hex
    video = probe_upload(path, identifier, "variable.mp4", "synthetic_test", tmp_path / "frame.jpg")
    progress = []
    output = tmp_path / "prepared.mp4"
    width, height, duration = prepare_private_video(
        path, output, video, lambda: None, lambda count, at: progress.append((count, at))
    )
    assert (width, height) == (320, 180) and duration > 0.93
    with av.open(str(output)) as encoded:
        actual = [float(frame.pts * frame.time_base) for frame in encoded.decode(video=0)]
    assert actual == pytest.approx(times, abs=0.00001)
    assert progress[-1][0] == len(times)


def test_unsupported_playlist_and_empty_file_are_not_opened_as_videos(tmp_path):
    path = tmp_path / "recording.mp4"
    path.write_bytes(b"#EXTM3U\nhttps://example.invalid/private")
    with pytest.raises(ValueError, match="playlist"):
        validate_container_signature(path)
    path.write_bytes(b"")
    with pytest.raises(ValueError, match="empty"):
        probe_upload(path, uuid4().hex, "empty.mp4", "recording", tmp_path / "preview.jpg")


def test_os_analysis_lock_prevents_parallel_owners(tmp_path):
    first, second = AnalysisLock(tmp_path / "worker.lock"), AnalysisLock(tmp_path / "worker.lock")
    try:
        assert first.acquire()
        assert not second.acquire()
        first.close()
        assert second.acquire()
    finally:
        if not first.file.closed:
            first.close()
        second.close()


def test_schema_v1_migration_preserves_operator_data_and_makes_private_backup(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE sites(id TEXT PRIMARY KEY,name TEXT NOT NULL,source_kind TEXT NOT NULL);
            CREATE TABLE events(
                site_id TEXT,event_id TEXT,original_payload TEXT,original_hash TEXT,
                effective_payload TEXT,source_label TEXT,occurred_at TEXT,
                PRIMARY KEY(site_id,event_id));
            CREATE TABLE review_audit(
                id INTEGER PRIMARY KEY,site_id TEXT,event_id TEXT,changed_at TEXT,
                reason TEXT,before_payload TEXT,after_payload TEXT);
            INSERT INTO sites VALUES('legacy','Preserved synthetic namespace','synthetic');
        """)
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        connection.execute("PRAGMA user_version = 1")
    initialize_database(path)
    assert list_sites(path)[0].id == "legacy"
    assert len(list(tmp_path.glob("legacy-v1-backup-*.sqlite3"))) == 1
    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM analysis_jobs").fetchone()[0] == 0
    initialize_database(path)
    assert len(list(tmp_path.glob("legacy-v1-backup-*.sqlite3"))) == 1


def test_private_media_paths_cannot_escape_the_owned_root(private_video):
    path, _, _ = private_video
    with pytest.raises(ValueError):
        video_directory(path, "../escape")
    with pytest.raises(ValueError):
        job_directory(path, "0" * 32 + "/../other")
    assert not private_database_path(path).is_relative_to(Path(__file__).parent / "viewer")


def test_analysis_schema_matches_the_python_producer():
    root = Path(__file__).resolve().parents[1]
    schema = json.loads((root / "viewer" / "src" / "analysis.schema.json").read_text())
    assert schema == ANALYSIS_ADAPTER.json_schema(mode="serialization")


def test_cancel_during_finalization_cannot_publish_success(private_video):
    path, video, site = private_video
    job = create_job(path, request_for(video, site))
    claim_next_job(path)
    cancel_job(path, job.id)
    result = update_job(
        path,
        job.id,
        status="succeeded",
        bundle_url="must-not-be-exposed",
        events_url="must-not-be-exposed",
        export_url="must-not-be-exposed",
    )
    assert result.status == "cancelled"
    assert result.bundle_url is result.events_url is result.export_url is None
    assert "finalization" in result.error


def test_manager_releases_ownership_when_startup_fails(private_video, monkeypatch):
    from parking_analytics.analysis_manager import AnalysisManager

    path, _, _ = private_video
    manager = AnalysisManager(path)

    def fail(_):
        raise RuntimeError("controlled recovery failure")

    monkeypatch.setattr("parking_analytics.analysis_manager.recover_interrupted_jobs", fail)
    with pytest.raises(RuntimeError, match="controlled"):
        manager.start()
    assert manager.lock is None
    with_owner = AnalysisLock(path.parent / f"{path.stem}-media" / "manager.lock")
    try:
        assert with_owner.acquire()
    finally:
        with_owner.close()


@pytest.mark.parametrize("outcome", ["cancel", "timeout", "missing-results"])
def test_scheduler_never_turns_cancellation_or_incomplete_workers_into_success(
    private_video, monkeypatch, outcome
):
    from parking_analytics.analysis_manager import AnalysisManager

    path, video, site = private_video
    job = create_job(path, request_for(video, site))
    active = claim_next_job(path)
    ticks = iter(range(0, 100_000, 2 if outcome == "cancel" else 1801))

    class ControlledProcess:
        returncode = None
        terminated = False

        def __init__(self, *args, **kwargs):
            if outcome == "missing-results":
                self.returncode = 0
            elif outcome == "cancel":
                cancel_job(path, job.id)

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True
            self.returncode = -15

        def wait(self, timeout):
            assert self.returncode is not None
            return self.returncode

    monkeypatch.setattr("parking_analytics.analysis_manager.subprocess.Popen", ControlledProcess)
    monkeypatch.setattr(
        "parking_analytics.analysis_manager.time",
        SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None),
    )
    AnalysisManager(path)._process(active)
    result = get_job(path, job.id)
    assert result.status == ("cancelled" if outcome == "cancel" else "failed")
    assert result.bundle_url is result.events_url is result.export_url is None
    assert result.error
    if outcome == "timeout":
        assert "30-minute" in result.error


@pytest.fixture
def analysis_api(private_video, monkeypatch):
    pytest.importorskip("fastapi", reason="Optional app dependencies are not installed")
    pytest.importorskip("httpx", reason="Optional API test dependency is not installed")
    from fastapi.testclient import TestClient

    from parking_analytics.analysis_manager import AnalysisManager
    from parking_analytics.api import create_app

    # API unit tests control the scheduler; the browser smoke runs the real worker.
    monkeypatch.setattr(AnalysisManager, "start", lambda _: None)
    path, video, site = private_video
    app = create_app(path, frontend_origin="http://127.0.0.1:4175", serve_frontend=False)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, path, video, site


def test_private_upload_authorization_limits_metadata_and_media(analysis_api):
    client, path, video, _ = analysis_api
    body = (video_directory(path, video.id) / "source.bin").read_bytes()
    headers = {
        "Content-Type": "application/octet-stream",
        "X-Upload-Name": "private-test.mp4",
        "X-Analysis-Content-Kind": "synthetic_test",
    }
    assert client.post("/api/analysis/videos", content=body, headers=headers).status_code == 422
    headers["X-Analysis-Permission"] = "confirmed"
    invalid = client.post("/api/analysis/videos", content=b"not a video", headers=headers)
    assert invalid.status_code == 422
    too_big = client.post(
        "/api/analysis/videos",
        content=b"x",
        headers=headers | {"Content-Length": str(512 * 1024**2 + 1)},
    )
    assert too_big.status_code == 413
    hostile = client.post(
        "/api/analysis/videos",
        content=body,
        headers=headers | {"Origin": "https://example.invalid"},
    )
    assert hostile.status_code == 403
    response = client.post("/api/analysis/videos", content=body, headers=headers)
    assert response.status_code == 200, response.text
    uploaded = response.json()["video"]
    assert uploaded["timestamp_candidates"][0]["parsed_utc"] == "2026-01-15T08:00:00Z"
    assert not uploaded["burned_in_timestamp_checked"]
    for url in (uploaded["preview_url"], uploaded["source_url"], "/api/analysis/videos"):
        result = client.get(url)
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
    assert client.get("/api/sites").json()["sites"] == []
    assert (video_directory(path, uploaded["id"]) / "source.bin").is_file()


def test_analysis_api_requires_explicit_aware_clock_and_ready_model(analysis_api, monkeypatch):
    client, _, video, site = analysis_api
    payload = request_for(video, site).model_dump(mode="json")
    not_ready = CapabilitiesResponse(model_files_present=False, inference_packages_present=False)
    monkeypatch.setattr("parking_analytics.analysis_routes.capabilities", lambda: not_ready)
    assert client.post("/api/analysis/jobs", json=payload).status_code == 409
    ready = CapabilitiesResponse(model_files_present=True, inference_packages_present=True)
    monkeypatch.setattr("parking_analytics.analysis_routes.capabilities", lambda: ready)
    for changes in (
        {"recording_start": "2026-01-15T10:00:00"},
        {"recording_start": ""},
        {"realtime_confirmed": False},
        {"fixed_camera_confirmed": False},
    ):
        assert client.post("/api/analysis/jobs", json=payload | changes).status_code == 422
    response = client.post("/api/analysis/jobs", json=payload)
    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["clock"]["start_utc"] == "2026-01-15T08:00:00Z"
    assert job["clock"]["source"] == "manual"
    assert job["status"] == "queued" and job["bundle_url"] is None
    cancelled = client.post(f"/api/analysis/jobs/{job['id']}/cancel", json={})
    assert cancelled.json()["job"]["status"] == "cancelled"
    assert client.get(f"/api/analysis/jobs/{job['id']}/bundle").status_code == 409
    removed = client.post(f"/api/analysis/videos/{video.id}/delete", json={})
    assert removed.status_code == 200
    assert client.get(video.preview_url).status_code == 404


def test_private_result_streams_ranges_and_rejects_tampered_media(analysis_api, smoke):
    from parking_analytics.io import write_json

    client, path, video, site = analysis_api
    bundle, smoke_directory = smoke
    job = create_job(path, request_for(video, site))
    assert client.get(f"/api/analysis/jobs/{job.id}/events.csv").status_code == 409
    directory = job_directory(path, job.id)
    media = directory / "media" / "recording.mp4"
    media.parent.mkdir(parents=True)
    shutil.copyfile(smoke_directory / bundle.clips[0].video, media)
    clip = bundle.clips[0].model_copy(update={"video": "media/recording.mp4"})
    write_json(directory / "bundle.json", bundle.model_copy(update={"clips": [clip]}))
    write_json(directory / "result.json", {"test_fixture": "explicit synthetic, not model output"})
    (directory / "events.csv").write_text("clip_time_s,event_utc\n", encoding="utf-8")
    update_job(path, job.id, status="succeeded")
    url = f"/api/analysis/jobs/{job.id}/media/recording.mp4"
    response = client.head(url)
    assert response.status_code == 200
    assert response.headers["x-content-sha256"] == clip.video_sha256
    assert response.headers["x-integrity-check"] == "server-verified"
    assert response.headers["cache-control"] == "no-store"
    response = client.get(url, headers={"Range": "bytes=0-15"})
    assert response.status_code == 206 and len(response.content) == 16
    assert client.get(f"/api/analysis/jobs/{job.id}/result.json").status_code == 200
    media.write_bytes(b"changed media")
    assert client.head(url).status_code == 409


def test_private_recordings_cannot_be_copied_to_public_static_exports(smoke, tmp_path):
    from parking_analytics.cli import export_bundle
    from parking_analytics.io import write_json

    bundle, _ = smoke
    bundle = bundle.model_copy(
        update={
            "attribution": bundle.attribution.model_copy(
                update={"source_url": f"/api/analysis/videos/{uuid4().hex}/source"}
            )
        }
    )
    source = tmp_path / "private.json"
    write_json(source, bundle)
    with pytest.raises(ValueError, match="Private uploads"):
        export_bundle(source, tmp_path / "public-export")
    assert not (tmp_path / "public-export").exists()


@pytest.mark.parametrize("clock_source", ["manual", "metadata_confirmed"])
def test_worker_exports_event_utc_from_recording_start_not_import_time(
    private_video, smoke, monkeypatch, clock_source
):
    from parking_analytics.analysis_worker import run_job

    path, video, site = private_video
    request = request_for(
        video,
        site,
        clock_source=clock_source,
        metadata_key=None if clock_source == "manual" else video.timestamp_candidates[0].key,
    )
    job = create_job(path, request)
    claim_next_job(path)
    fixture = smoke[0]
    clip = fixture.clips[0]

    def controlled_analysis(config, media, duration, detector, deadline, **kwargs):
        results = [
            analysis.model_copy(
                update={
                    "samples": [sample for sample in analysis.samples if sample.time_s < duration],
                    "events": [event for event in analysis.events if event.time_s < duration],
                }
            )
            for analysis in (clip.baseline, clip.candidate)
        ]
        return *results, []

    monkeypatch.setattr("parking_analytics.analysis_worker.Detector", lambda *args: None)
    monkeypatch.setattr("parking_analytics.analysis_worker.analyze_media", controlled_analysis)
    monkeypatch.setattr(
        "parking_analytics.analysis_worker.run_provenance",
        lambda config, *args: fixture.run.model_copy(
            update={
                "config_sha256": config.digest(),
                "command": ["pytest", "controlled-clock-test"],
            }
        ),
    )
    run_job(path, job.id)
    directory = job_directory(path, job.id)
    with (directory / "events.csv").open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    assert rows and {row["method"] for row in rows} == {"candidate", "baseline"}
    for row in rows:
        expected = datetime(2026, 1, 15, 8, tzinfo=UTC) + timedelta(
            seconds=float(row["clip_time_s"])
        )
        assert datetime.fromisoformat(row["event_utc"]) == expected
        assert row["clock_basis"] == clock_source and row["playback_rate_assumed"] == "1.0"
        assert datetime.fromisoformat(row["event_utc"]) < video.imported_at
    export = json.loads((directory / "result.json").read_text())
    assert export["recording_clock"]["start_utc"] == "2026-01-15T08:00:00Z"
    assert export["bundle"]["run"]["device"] == "synthetic"

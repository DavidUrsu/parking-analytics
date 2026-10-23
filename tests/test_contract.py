import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from parking_analytics.cli import export_bundle, validate_assets
from parking_analytics.io import read_model, write_json
from parking_analytics.models import Bundle, Config, Reference, Vehicle, ZoneCount

ROOT = Path(__file__).resolve().parents[1]


def test_checked_in_schema_matches_the_python_producer():
    schema = json.loads((ROOT / "viewer" / "src" / "bundle.schema.json").read_text())
    assert schema == Bundle.model_json_schema(mode="serialization")


def test_frozen_real_protocol_and_reference_agree():
    config = read_model(ROOT / "configs" / "meva-g328.json", Config)
    reference = read_model(ROOT / "reference" / "meva-g328.json", Reference)
    assert config.digest() == reference.config_sha256
    assert reference.review_status == "provisional" and not reference.events_complete
    assert {clip.split for clip in config.clips} == {"development", "held_out"}


def test_invalid_numbers_capacity_states_and_boxes_are_rejected():
    with pytest.raises(ValidationError):
        Vehicle(box=(0.1, 0.1, 0.2, 0.2), score=float("nan"), label="car")
    with pytest.raises(ValidationError):
        Vehicle(box=(0.2, 0.1, 0.1, 0.2), score=0.8, label="car")
    with pytest.raises(ValidationError):
        ZoneCount(zone_id="zone", vehicle_count=2, state="unknown", reason="no_observation")
    with pytest.raises(ValidationError):
        ZoneCount(
            zone_id="zone", vehicle_count=2, state="observed", reason="detections", capacity=10
        )


def test_nonoverlapping_ranges_and_crop_are_enforced():
    raw = json.loads((ROOT / "configs" / "meva-g328.json").read_text())
    raw["clips"][1]["source"] = raw["clips"][0]["source"]
    raw["clips"][1]["start_s"] = 70
    raw["clips"][1]["end_s"] = 100
    with pytest.raises(ValidationError, match="overlap"):
        Config.model_validate_json(json.dumps(raw))
    raw["clips"][1]["start_s"] = 400
    with pytest.raises(ValidationError):
        Config.model_validate_json(json.dumps(raw))


def test_stale_evaluation_and_out_of_range_events_are_rejected(smoke):
    bundle, _ = smoke
    raw = json.loads(bundle.model_dump_json())
    raw["reference"]["clips"][0]["snapshots"][0]["zone_counts"]["zone"] = 100
    with pytest.raises(ValidationError, match="stale"):
        Bundle.model_validate_json(json.dumps(raw))
    raw = json.loads(bundle.model_dump_json())
    raw["clips"][0]["candidate"]["events"][0]["time_s"] = 100
    with pytest.raises(ValidationError, match="invalid media time"):
        Bundle.model_validate_json(json.dumps(raw))
    raw = json.loads(bundle.model_dump_json())
    raw["schema_version"] = "999"
    with pytest.raises(ValidationError):
        Bundle.model_validate_json(json.dumps(raw))


def test_export_checks_real_media_and_preserves_existing_files(smoke, tmp_path):
    bundle, directory = smoke
    target = tmp_path / "replay"
    export_bundle(directory / "bundle.json", target)
    assert read_model(target / "bundle.json", Bundle).synthetic
    validate_assets(bundle, target)
    with pytest.raises(FileExistsError):
        export_bundle(directory / "bundle.json", target)
    media = target / "media" / "fixture.mp4"
    media.write_bytes(b"damaged")
    with pytest.raises(ValueError, match="hash mismatch"):
        validate_assets(bundle, target)


def test_cli_refuses_to_mark_an_unreviewed_reference_verified(smoke, tmp_path):
    bundle, directory = smoke
    reference = tmp_path / "reference.json"
    output = tmp_path / "verified.json"
    assert bundle.reference is not None
    write_json(reference, bundle.reference)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "parking_analytics.cli",
            "evaluate",
            "--bundle",
            str(directory / "bundle.json"),
            "--reference",
            str(reference),
            "--output",
            str(output),
            "--require-reviewed",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "Human reference review is pending" in result.stderr
    assert not output.exists()

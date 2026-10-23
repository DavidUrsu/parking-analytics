from __future__ import annotations

import hashlib
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image, ImageDraw

from parking_analytics.evaluation import evaluate
from parking_analytics.geometry import CrossingCounter, zone_counts
from parking_analytics.io import read_model, sha256, write_json
from parking_analytics.models import (
    Analysis,
    Attribution,
    Bundle,
    Gate,
    Observation,
    Protocol,
    Reference,
    ReferenceClip,
    ReferenceEvent,
    ReferenceSnapshot,
    ReplayClip,
    Run,
    Site,
    Source,
    Text,
    Vehicle,
    Zone,
)


def create_smoke(output_dir: Path, *, replace: bool = False) -> Bundle:
    existing = output_dir / "bundle.json"
    if output_dir.exists():
        if not replace or not existing.is_file():
            raise FileExistsError(
                "Choose a new smoke directory or explicitly replace a synthetic one"
            )
        previous = read_model(existing, Bundle)
        if not previous.synthetic or [clip.id for clip in previous.clips] != ["fixture"]:
            raise ValueError("Replacement is allowed only for this generator's synthetic fixture")
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "media" / "fixture.mp4"
    path.parent.mkdir(exist_ok=True)
    site = Site(
        id="synthetic",
        name=Text(en="Synthetic smoke fixture", ro="Exemplu de test sintetic"),
        description=Text(
            en="Generated rectangles only. Not parking footage or evidence of model quality.",
            ro="Dreptunghiuri generate, nu filmare reala sau dovada a calitatii modelului.",
        ),
        zones=[
            Zone(
                id="zone",
                name=Text(en="Test zone", ro="Zona de test"),
                polygon=[(0.5, 0.2), (0.9, 0.2), (0.9, 0.9), (0.5, 0.9)],
            )
        ],
        gates=[
            Gate(
                id="gate",
                name=Text(en="Test boundary", ro="Limita de test"),
                start=(0.5, 0.9),
                end=(0.5, 0.2),
                inward_side=1,
            )
        ],
    )

    def vehicle(t: float) -> Vehicle:
        x = 0.25 + t / 6
        return Vehicle(box=(x - 0.05, 0.5, x + 0.05, 0.7), label="car", score=1.0, track_id=1)

    with av.open(str(path), "w") as output:
        stream = output.add_stream("libx264", rate=30)
        stream.width, stream.height, stream.pix_fmt = 400, 240, "yuv420p"
        for index in range(90):
            image = Image.new("RGB", (400, 240), "#1b2937")
            drawing = ImageDraw.Draw(image)
            drawing.text((12, 12), "SYNTHETIC TEST - NO MODEL", fill="white")
            box = vehicle(index / 30).box
            drawing.rectangle(
                [box[0] * 400, box[1] * 240, box[2] * 400, box[3] * 240], fill="#e5b85b"
            )
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = index, Fraction(1, 30)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    samples, events = [], []
    counter = CrossingCounter(site.gates, 0.008, 1.0)
    for index in range(15):
        elapsed = index / 5
        vehicles = [vehicle(elapsed)]
        samples.append(
            Observation(
                time_s=elapsed,
                vehicles=vehicles,
                zones=zone_counts(vehicles, site.zones),
            )
        )
        events.extend(counter.update(vehicles, elapsed))
    analysis = Analysis(samples=samples, events=events)
    digest = hashlib.sha256(b"synthetic-fixture-v1").hexdigest()
    reference = Reference(
        schema_version="1.0",
        protocol_version="synthetic-v1",
        config_sha256=digest,
        review_status="provisional",
        origin="Deterministically generated test truth, not human-verified parking annotations.",
        events_complete=True,
        clips=[
            ReferenceClip(
                clip_id="fixture",
                snapshots=[
                    ReferenceSnapshot(time_s=t, zone_counts={"zone": 0 if t < 1.5 else 1})
                    for t in (0.0, 1.0, 2.0)
                ],
                events=[ReferenceEvent(time_s=1.5, gate_id="gate", direction="in")],
            )
        ],
    )
    bundle = Bundle(
        schema_version="1.0",
        synthetic=True,
        site=site,
        protocol=Protocol(
            version="synthetic-v1",
            occupancy_mode="observed_vehicle_count",
            reference_interval_s=1.0,
            event_tolerance_s=1.0,
            notes="Known-answer synthetic test. Do not present as model-quality evidence.",
        ),
        analysis_fps=5,
        stale_after_s=0.6,
        run=Run(
            command=["parking", "smoke"],
            code_revision=None,
            config_sha256=digest,
            model_id="none: generated rectangles",
            model_revision="none",
            model_sha256=digest,
            device="synthetic",
            hardware="not a benchmark",
            versions={},
            elapsed_seconds=0.0,
            seed=0,
        ),
        attribution=Attribution(
            title="Synthetic rectangles, not camera footage",
            creator="Parking analytics contributors",
            source_url="https://example.invalid/synthetic",
            license="MIT (generated test shapes)",
            license_url="https://opensource.org/license/mit",
            modifications="Generated test video and scripted boxes; no detector was run.",
            staged_scenarios=True,
            public_presentation_cleared=False,
        ),
        clips=[
            ReplayClip(
                id="fixture",
                name=Text(en="Synthetic test clip", ro="Clip de test sintetic"),
                split="held_out",
                source=Source(
                    url="https://example.invalid/synthetic.mp4",
                    file="synthetic.mp4",
                    bytes=path.stat().st_size,
                    sha256=sha256(path),
                    width=400,
                    height=240,
                    duration_s=3.0,
                ),
                source_start_s=0.0,
                crop=(0, 0, 400, 240),
                width=400,
                height=240,
                duration_s=3.0,
                video="media/fixture.mp4",
                video_sha256=sha256(path),
                baseline=analysis,
                candidate=analysis,
                review_moments=[],
            )
        ],
        reference=reference,
        evaluation=None,
    )
    bundle = evaluate(bundle, reference)
    write_json(existing, bundle, overwrite=replace)
    return bundle

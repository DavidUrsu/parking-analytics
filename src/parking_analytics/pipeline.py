from __future__ import annotations

import hashlib
import importlib.metadata
import platform
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
from PIL import Image

from parking_analytics.geometry import (
    ConsecutiveTracker,
    CrossingCounter,
    anchor,
    inside,
    zone_counts,
)
from parking_analytics.io import MODEL_FILES, sha256, verify_source, write_json
from parking_analytics.models import (
    Analysis,
    Attribution,
    Bundle,
    Config,
    Observation,
    ReplayClip,
    ReviewMoment,
    Run,
    Vehicle,
)
from parking_analytics.video import deadline_check, export_video, sampled_frames


def suppress_duplicate_vehicles(vehicles: list[Vehicle], iou_threshold: float) -> list[Vehicle]:
    if not vehicles:
        return []
    import torch
    from torchvision.ops import nms

    boxes = torch.tensor([vehicle.box for vehicle in vehicles], dtype=torch.float32)
    scores = torch.tensor([vehicle.score for vehicle in vehicles], dtype=torch.float32)
    return [vehicles[index] for index in nms(boxes, scores, iou_threshold).tolist()]


class Detector:
    def __init__(self, config: Config, model_dir: Path, device: str) -> None:
        try:
            import torch
            from transformers import RTDetrForObjectDetection, RTDetrImageProcessor
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "Install inference dependencies: uv sync --extra inference"
            ) from error
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA requested but unavailable; check the driver or choose --device cpu"
            )
        weights = model_dir / "model.safetensors"
        verify_source(weights, 80904152, config.model.weights_sha256)
        for filename, (size, blob) in MODEL_FILES.items():
            path = model_dir / filename
            if not path.is_file() or path.stat().st_size != size:
                raise ValueError(f"Missing/changed model artifact: {path}; run 'parking fetch'")
            data = path.read_bytes()
            actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if actual != blob:
                raise ValueError(f"Pinned model artifact changed: {path}")
        self.torch = torch
        self.device = device
        self.config = config
        torch.manual_seed(0)
        np.random.seed(0)
        torch.set_num_threads(4)
        self.processor = RTDetrImageProcessor.from_pretrained(model_dir, local_files_only=True)
        self.model = (
            RTDetrForObjectDetection.from_pretrained(
                model_dir, local_files_only=True, use_safetensors=True
            )
            .to(device)
            .eval()
        )
        self.hardware = torch.cuda.get_device_name(0) if device == "cuda" else platform.processor()

    def detect(self, image: Image.Image) -> list[Vehicle]:
        torch = self.torch
        inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            outputs = self.model(**inputs)
        result = self.processor.post_process_object_detection(
            outputs,
            target_sizes=torch.tensor([(image.height, image.width)], device=self.device),
            threshold=self.config.model.threshold,
        )[0]
        vehicles = []
        for score, label_id, box in zip(
            result["scores"].detach().cpu().tolist(),
            result["labels"].detach().cpu().tolist(),
            result["boxes"].detach().cpu().tolist(),
            strict=True,
        ):
            label = self.model.config.id2label[label_id]
            if label not in self.config.model.vehicle_labels:
                continue
            normalized = tuple(
                max(0.0, min(1.0, value / scale))
                for value, scale in zip(
                    box, (image.width, image.height, image.width, image.height), strict=True
                )
            )
            vehicles.append(Vehicle(box=normalized, label=label, score=float(score)))
        return suppress_duplicate_vehicles(vehicles, self.config.model.vehicle_nms_iou)


class ByteTracker:
    def __init__(self, fps: int) -> None:
        try:
            import supervision as sv
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "Install inference dependencies: uv sync --extra inference"
            ) from error
        self.sv = sv
        self.tracker = sv.ByteTrack(
            track_activation_threshold=0.35,
            lost_track_buffer=30,
            minimum_matching_threshold=0.8,
            frame_rate=fps,
            minimum_consecutive_frames=2,
        )

    def update(self, vehicles: list[Vehicle], width: int, height: int) -> list[Vehicle]:
        scale = np.array([width, height, width, height])
        detections = self.sv.Detections(
            xyxy=np.array([vehicle.box for vehicle in vehicles], dtype=float).reshape(-1, 4)
            * scale,
            confidence=np.array([vehicle.score for vehicle in vehicles], dtype=float),
            class_id=np.zeros(len(vehicles), dtype=int),
            data={"source_index": np.arange(len(vehicles), dtype=int)},
        )
        tracked = self.tracker.update_with_detections(detections)
        result = list(vehicles)
        if len(tracked):
            if tracked.tracker_id is None or "source_index" not in tracked.data:
                raise RuntimeError("Tracker returned observations without their IDs/source indices")
            for index, track_id in zip(
                tracked.data["source_index"], tracked.tracker_id, strict=True
            ):
                if int(track_id) < 1:
                    raise RuntimeError("Tracker returned a nonpositive clip-local ID")
                result[int(index)] = result[int(index)].model_copy(
                    update={"track_id": int(track_id)}
                )
        return result


def attribution() -> Attribution:
    return Attribution(
        title="Multiview Extended Video with Activities (MEVA), KF1 r13",
        creator="Kitware Inc. and the Intelligence Advanced Research Projects Activity (IARPA)",
        source_url="https://mevadata.org/",
        license="CC BY 4.0",
        license_url="https://creativecommons.org/licenses/by/4.0/",
        modifications=(
            "Selected segments, fixed crop, resizing, H.264 transcoding, "
            "audio omitted, separate overlays."
        ),
        staged_scenarios=True,
        public_presentation_cleared=False,
    )


def analyze_media(
    config: Config,
    video_path: Path,
    duration: float,
    detector: Detector,
    deadline: float,
    *,
    checkpoint: Callable[[], None] | None = None,
    progress: Callable[[int, float], None] | None = None,
) -> tuple[Analysis, Analysis, list[ReviewMoment]]:
    baseline_tracker = ConsecutiveTracker(config.baseline_iou_threshold, 1.5 / config.analysis_fps)
    candidate_tracker = ByteTracker(config.analysis_fps)
    baseline_counter = CrossingCounter(config.site.gates, 0.0, 1.5 / config.analysis_fps)
    candidate_counter = CrossingCounter(
        config.site.gates, config.crossing_band, config.max_track_gap_s
    )
    baseline_samples, candidate_samples = [], []
    baseline_events, candidate_events = [], []
    moments = []
    last_uncertainty = -10.0
    for elapsed, image in sampled_frames(video_path, duration, config.analysis_fps, deadline):
        if checkpoint is not None:
            checkpoint()
        vehicles = detector.detect(image)
        deadline_check(deadline)
        if checkpoint is not None:
            checkpoint()
        baseline = baseline_tracker.update(vehicles, elapsed)
        candidate = candidate_tracker.update(vehicles, image.width, image.height)
        baseline_samples.append(
            Observation(
                time_s=elapsed, vehicles=baseline, zones=zone_counts(baseline, config.site.zones)
            )
        )
        candidate_samples.append(
            Observation(
                time_s=elapsed, vehicles=candidate, zones=zone_counts(candidate, config.site.zones)
            )
        )
        baseline_events.extend(baseline_counter.update(baseline, elapsed))
        candidate_events.extend(candidate_counter.update(candidate, elapsed))
        uncertain = [
            vehicle
            for vehicle in candidate
            if vehicle.score < 0.4
            and any(inside(anchor(vehicle), zone.polygon) for zone in config.site.zones)
        ]
        if uncertain and elapsed - last_uncertainty >= 3:
            lowest = min(uncertain, key=lambda vehicle: vehicle.score)
            moments.append(
                ReviewMoment(
                    time_s=elapsed,
                    kind="low_confidence",
                    method="candidate",
                    details=(
                        f"{lowest.label}: model score {lowest.score:.3f}; "
                        "not a calibrated probability"
                    ),
                )
            )
            last_uncertainty = elapsed
        if progress is not None:
            progress(len(candidate_samples), elapsed)
    return (
        Analysis(
            samples=baseline_samples, events=sorted(baseline_events, key=lambda event: event.time_s)
        ),
        Analysis(
            samples=candidate_samples,
            events=sorted(candidate_events, key=lambda event: event.time_s),
        ),
        moments,
    )


def run_provenance(config: Config, detector: Detector, started: float) -> Run:
    revision = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"], capture_output=True, text=True, check=False
    )
    return Run(
        command=sys.argv,
        code_revision=revision.stdout.strip() if revision.returncode == 0 else None,
        config_sha256=config.digest(),
        model_id=config.model.id,
        model_revision=config.model.revision,
        model_sha256=config.model.weights_sha256,
        device=detector.device,
        hardware=detector.hardware,
        versions={
            name: importlib.metadata.version(name)
            for name in (
                "av",
                "numpy",
                "pydantic",
                "scipy",
                "torch",
                "torchvision",
                "transformers",
                "supervision",
            )
        }
        | {"python": platform.python_version()},
        elapsed_seconds=time.monotonic() - started,
        seed=0,
    )


def process(
    config: Config, data_dir: Path, model_dir: Path, output_dir: Path, device: str
) -> Bundle:
    if output_dir.exists():
        raise FileExistsError(f"Choose a new output directory; refusing to overwrite {output_dir}")
    started = time.monotonic()
    deadline = started + config.max_run_seconds
    detector = Detector(config, model_dir, device)
    output_dir.mkdir(parents=True)
    clips = []
    for segment in config.clips:
        deadline_check(deadline)
        video_path = output_dir / "media" / f"{segment.id}.mp4"
        width, height, duration, irregularities = export_video(
            segment, config, data_dir / segment.source.file, video_path, deadline
        )
        baseline, candidate, moments = analyze_media(
            config, video_path, duration, detector, deadline
        )
        clips.append(
            ReplayClip(
                id=segment.id,
                name=segment.name,
                split=segment.split,
                source=segment.source,
                source_start_s=segment.start_s,
                source_clock=config.source_clock,
                source_start_frame=round(segment.start_s * 30)
                if config.source_clock == "meva_r13_cfr"
                else None,
                source_pts_irregularities=irregularities,
                crop=config.crop,
                width=width,
                height=height,
                duration_s=duration,
                video=f"media/{segment.id}.mp4",
                video_sha256=sha256(video_path),
                baseline=baseline,
                candidate=candidate,
                review_moments=moments,
            )
        )
        print(
            f"{segment.id}: {len(candidate.samples)} actual observations, "
            f"{len(candidate.events)} candidate / {len(baseline.events)} baseline crossings"
        )
    run = run_provenance(config, detector, started)
    if run.code_revision is None:
        print(
            "No committed Git revision is available; run provenance records this explicitly.",
            file=sys.stderr,
        )
    bundle = Bundle(
        schema_version="1.0",
        synthetic=False,
        site=config.site,
        protocol=config.protocol,
        analysis_fps=config.analysis_fps,
        stale_after_s=config.stale_after_s,
        run=run,
        attribution=attribution(),
        clips=clips,
        reference=None,
        evaluation=None,
    )
    write_json(output_dir / "bundle.json", bundle)
    return bundle

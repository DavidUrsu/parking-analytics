from __future__ import annotations

import sys
import time
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image

from parking_analytics.io import verify_source
from parking_analytics.models import Config, Segment


def deadline_check(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise TimeoutError("Processing run reached its approved runtime limit")


def frames(path: Path, start_s: float, end_s: float, *, source_clock: str = "media_pts"):
    with av.open(str(path)) as container:
        if not container.streams.video:
            raise ValueError(f"No video stream: {path}")
        stream = container.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base)
        if source_clock == "meva_r13_cfr":
            if not path.name.endswith(".r13.avi") or stream.average_rate != 30:
                raise ValueError("MEVA r13 frame-index normalization requires a 30 fps r13 AVI")
            print(
                f"{path.name}: explicit MEVA r13 frame-index / 30 clock; not raw AVI PTS",
                file=sys.stderr,
            )
        elif source_clock == "media_pts":
            container.seek(int((origin + start_s) * av.time_base), backward=True)
        else:
            raise ValueError(f"Unsupported source clock: {source_clock}")
        previous = -1.0
        for index, frame in enumerate(container.decode(stream)):
            if source_clock == "meva_r13_cfr":
                elapsed = index / 30
            elif frame.pts is None:
                raise ValueError(f"Video has an untimestamped frame: {path}")
            else:
                elapsed = float(frame.pts * frame.time_base) - origin
            if elapsed + 1e-7 < start_s:
                continue
            if elapsed >= end_s - 1e-7:
                break
            if elapsed <= previous:
                raise ValueError(f"Non-monotonic media timestamps: {path}")
            previous = elapsed
            yield elapsed - start_s, frame


def export_video(
    segment: Segment, config: Config, source_path: Path, output_path: Path, deadline: float
) -> tuple[int, int, float, int]:
    verify_source(source_path, segment.source.bytes, segment.source.sha256)
    if output_path.exists():
        raise FileExistsError(f"Refusing to replace existing media: {output_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    partial = output_path.with_suffix(".partial.mp4")
    if partial.exists():
        raise FileExistsError(f"Inspect existing partial export: {partial}")
    with av.open(str(source_path)) as source:
        video = source.streams.video[0]
        rate = video.average_rate
        if rate is None or rate <= 0:
            raise ValueError(f"Missing video frame rate: {source_path}")
        if (video.width, video.height) != (segment.source.width, segment.source.height):
            raise ValueError("Source dimensions differ from the source manifest")
    width, height = config.export_size
    count = 0
    previous_pts = -1
    previous_raw_pts = None
    irregularities = 0
    try:
        with av.open(str(partial), "w", format="mp4", options={"movflags": "+faststart"}) as output:
            stream = output.add_stream("libx264", rate=rate)
            stream.width, stream.height = width, height
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "23", "preset": "fast"}
            clock = Fraction(rate.denominator, rate.numerator)
            for elapsed, source_frame in frames(
                source_path, segment.start_s, segment.end_s, source_clock=config.source_clock
            ):
                deadline_check(deadline)
                raw_pts = source_frame.pts
                if raw_pts is None or (
                    previous_raw_pts is not None and raw_pts <= previous_raw_pts
                ):
                    irregularities += 1
                previous_raw_pts = raw_pts
                image = (
                    source_frame.to_image()
                    .crop(config.crop)
                    .resize((width, height), Image.Resampling.LANCZOS)
                )
                frame = av.VideoFrame.from_image(image)
                frame.pts = round(elapsed / float(clock))
                frame.time_base = clock
                if frame.pts <= previous_pts:
                    raise ValueError("Source timestamps cannot be represented at the export rate")
                previous_pts = frame.pts
                for packet in stream.encode(frame):
                    output.mux(packet)
                count += 1
            if count == 0:
                raise ValueError(f"No frames in selected segment: {segment.id}")
            for packet in stream.encode():
                output.mux(packet)
        partial.replace(output_path)
    finally:
        partial.unlink(missing_ok=True)
    with av.open(str(output_path)) as encoded:
        duration = float(encoded.duration / av.time_base)
    expected = segment.end_s - segment.start_s
    if abs(duration - expected) > 2 / float(rate):
        raise ValueError(f"Export duration differs from source selection: {duration} vs {expected}")
    return width, height, duration, irregularities


def sampled_frames(path: Path, duration_s: float, fps: int, deadline: float):
    target = 0.0
    for elapsed, frame in frames(path, 0.0, duration_s):
        deadline_check(deadline)
        if elapsed + 1e-7 < target:
            continue
        yield elapsed, frame.to_image()
        target = (int((elapsed + 1e-7) * fps) + 1) / fps

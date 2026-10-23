from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image

from parking_analytics.analysis_models import (
    MAX_DURATION_SECONDS,
    MAX_PIXELS,
    MAX_UPLOAD_BYTES,
    TimestampCandidate,
    UploadedVideo,
)
from parking_analytics.io import sha256
from parking_analytics.operations_models import utc_datetime

TIMESTAMP_KEYS = {
    "creation_time",
    "recording_time",
    "recorded_at",
    "date",
    "datetimeoriginal",
    "date_time_original",
    "com.apple.quicktime.creationdate",
    "timecode",
}
LOCAL_VIDEO_OPTIONS = {"protocol_whitelist": "file,pipe"}


def validate_container_signature(path: Path) -> None:
    with path.open("rb") as source:
        header = source.read(16)
    mp4 = len(header) >= 8 and header[4:8] in {
        b"ftyp",
        b"moov",
        b"mdat",
        b"wide",
        b"free",
        b"skip",
    }
    avi = header[:4] == b"RIFF" and header[8:12] == b"AVI "
    matroska = header[:4] == b"\x1a\x45\xdf\xa3"
    if not (mp4 or avi or matroska):
        raise ValueError("Use an MP4/MOV, AVI or MKV/WebM video, not a playlist or external URL")


def timestamp_candidates(metadata: list[tuple[str, dict[str, str]]]) -> list[TimestampCandidate]:
    candidates = []
    for scope, values in metadata:
        for key, raw in values.items():
            if key.casefold() not in TIMESTAMP_KEYS:
                continue
            if len(raw) > 200:
                continue
            parsed = None
            needs_timezone = True
            try:
                parsed = utc_datetime(raw)
                needs_timezone = False
            except ValueError:
                pass
            candidates.append(
                TimestampCandidate(
                    key=f"{scope}.{key}",
                    raw_value=raw,
                    parsed_utc=parsed,
                    needs_timezone=needs_timezone,
                    note=(
                        "Metadata may describe export/encoding rather than capture. "
                        "Confirm the first-frame time; timecode alone is not a calendar date."
                    ),
                )
            )
    return candidates


def orient_image(frame: av.VideoFrame, rotation: int) -> Image.Image:
    image = frame.to_image()
    if rotation:
        image = image.rotate(rotation, expand=True)
    return image


def probe_upload(
    path: Path, video_id: str, original_name: str, content_kind: str, preview: Path
) -> UploadedVideo:
    size = path.stat().st_size
    if not 0 < size <= MAX_UPLOAD_BYTES:
        raise ValueError("Video exceeds the 512 MiB limit or is empty")
    validate_container_signature(path)
    try:
        with av.open(str(path), options=LOCAL_VIDEO_OPTIONS) as container:
            if not container.streams.video:
                raise ValueError("The file has no video stream")
            stream = container.streams.video[0]
            duration = (
                float(stream.duration * stream.time_base)
                if stream.duration is not None
                else container.duration / av.time_base
                if container.duration is not None
                else None
            )
            if duration is None or not 0 < duration <= MAX_DURATION_SECONDS:
                raise ValueError("A valid duration of at most ten minutes is required")
            if stream.width * stream.height > MAX_PIXELS:
                raise ValueError("Use a video at most 1080p (2,073,600 pixels per frame)")
            fps = float(stream.average_rate) if stream.average_rate else None
            if fps is not None and not 0 < fps <= 120:
                raise ValueError("Unsupported frame-rate metadata; use a recording at most 120 fps")
            first = next(container.decode(stream), None)
            if first is None or first.pts is None:
                raise ValueError("A timestamped, decodable first video frame is required")
            rotation = round(first.rotation)
            if abs(first.rotation - rotation) > 0.01 or rotation % 90:
                raise ValueError("Only right-angle orientation metadata is supported")
            rotation = ((rotation + 180) % 360) - 180
            image = orient_image(first, rotation)
            width, height = image.size
            candidates = timestamp_candidates(
                [("container", dict(container.metadata)), ("video", dict(stream.metadata))]
            )
            image.thumbnail((1280, 1280))
            image.save(preview, format="JPEG", quality=88)
            codec = stream.codec_context.name
            container_format = container.format.name
    except av.FFmpegError as error:
        raise ValueError("The selected file is not a supported decodable video") from error
    return UploadedVideo(
        id=video_id,
        original_name=original_name,
        content_kind=content_kind,
        bytes=size,
        sha256=sha256(path),
        width=width,
        height=height,
        duration_s=duration,
        nominal_fps=fps,
        codec=codec,
        container_format=container_format,
        rotation_degrees=rotation,
        timestamp_candidates=candidates,
        imported_at=datetime.now(UTC),
        source_url=f"/api/analysis/videos/{video_id}/source",
        preview_url=f"/api/analysis/videos/{video_id}/preview",
    )


def prepare_private_video(
    source: Path,
    output: Path,
    video: UploadedVideo,
    checkpoint: Callable[[], None],
    progress: Callable[[int, float], None],
) -> tuple[int, int, float]:
    if output.exists():
        raise FileExistsError("Analysis media already exists; use a new job")
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(".partial.mp4")
    if partial.exists():
        raise FileExistsError("A previous partial analysis file needs inspection")
    ratio = min(1.0, 1280 / max(video.width, video.height))
    width = max(2, int(video.width * ratio) // 2 * 2)
    height = max(2, int(video.height * ratio) // 2 * 2)
    count = 0
    previous = -1
    last_time = 0.0
    report_at = time.monotonic()
    try:
        with (
            av.open(str(source), options=LOCAL_VIDEO_OPTIONS) as original,
            av.open(str(partial), "w", format="mp4", options={"movflags": "+faststart"}) as target,
        ):
            stream = original.streams.video[0]
            rate = stream.average_rate or Fraction(30, 1)
            encoded = target.add_stream("libx264", rate=rate)
            encoded.width, encoded.height, encoded.pix_fmt = width, height, "yuv420p"
            encoded.options = {"crf": "25", "preset": "fast", "bf": "0"}
            clock = Fraction(1, 1_000_000)
            encoded.time_base = clock
            encoded.codec_context.time_base = clock
            origin = None
            pending_packet = None
            last_frame_duration = 0

            def retain_packet(packet: av.Packet) -> None:
                nonlocal pending_packet
                if packet.pts is None:
                    raise ValueError("Encoder produced an untimestamped packet")
                if pending_packet is not None:
                    spacing = packet.pts - pending_packet.pts
                    if spacing <= 0:
                        raise ValueError("Encoder changed presentation order")
                    pending_packet.duration = spacing
                    target.mux(pending_packet)
                pending_packet = packet

            for frame in original.decode(stream):
                checkpoint()
                if frame.pts is None:
                    raise ValueError(
                        "Video contains an untimestamped frame; remux it before analysis"
                    )
                actual = frame.pts * frame.time_base
                if origin is None:
                    origin = actual
                elapsed = float(actual - origin)
                pts = round(elapsed * 1_000_000)
                if pts <= previous:
                    raise ValueError(
                        "Non-monotonic source timestamps; no frame clock will be guessed"
                    )
                if elapsed > MAX_DURATION_SECONDS or frame.width * frame.height > MAX_PIXELS:
                    raise ValueError("Decoded video exceeds the declared analysis limits")
                previous = pts
                image = orient_image(frame, video.rotation_degrees)
                if image.size != (video.width, video.height):
                    raise ValueError(
                        "Frame geometry changed; split the recording into fixed-camera segments"
                    )
                image = image.resize((width, height), Image.Resampling.LANCZOS)
                picture = av.VideoFrame.from_image(image)
                picture.pts, picture.time_base = pts, clock
                for packet in encoded.encode(picture):
                    retain_packet(packet)
                count += 1
                last_time = elapsed
                last_frame_duration = round(float(frame.duration * frame.time_base) * 1_000_000)
                if time.monotonic() - report_at >= 0.5:
                    progress(count, elapsed)
                    report_at = time.monotonic()
            if not count:
                raise ValueError("No decodable frames were found")
            for packet in encoded.encode():
                retain_packet(packet)
            if pending_packet is None:
                raise ValueError("Encoder did not produce playable packets")
            pending_packet.duration = last_frame_duration or max(1, round(1_000_000 / float(rate)))
            target.mux(pending_packet)
        checkpoint()
        with av.open(str(partial)) as result:
            if result.duration is None:
                raise ValueError("Normalized media has no duration")
            duration = result.duration / av.time_base
        if duration <= last_time or duration > MAX_DURATION_SECONDS + 0.1:
            raise ValueError("Normalized duration is inconsistent with its presentation timestamps")
        partial.replace(output)
        progress(count, duration)
        return width, height, duration
    finally:
        partial.unlink(missing_ok=True)

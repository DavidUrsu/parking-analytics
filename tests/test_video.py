from fractions import Fraction

import av
import pytest
from PIL import Image

from parking_analytics.video import frames


def test_explicit_r13_clock_preserves_frames_when_avi_pts_are_not_monotonic(tmp_path):
    path = tmp_path / "synthetic.r13.avi"
    with av.open(str(path), "w") as output:
        stream = output.add_stream("libx264", rate=30)
        stream.width, stream.height, stream.pix_fmt = 96, 64, "yuv420p"
        stream.options = {"bf": "3", "b-adapt": "0", "g": "60"}
        for index in range(30):
            image = Image.new("RGB", (96, 64), (index * 6, 80, 120))
            frame = av.VideoFrame.from_image(image)
            frame.pts, frame.time_base = index, Fraction(1, 30)
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    with pytest.raises(ValueError, match="Non-monotonic"):
        list(frames(path, 0.0, 1.0))
    normalized = list(frames(path, 0.0, 1.0, source_clock="meva_r13_cfr"))
    assert len(normalized) == 30
    assert [time for time, _ in normalized] == pytest.approx([index / 30 for index in range(30)])
    selected = list(frames(path, 0.5, 0.8, source_clock="meva_r13_cfr"))
    assert len(selected) == 9
    assert selected[0][0] == 0.0
    assert selected[-1][0] == pytest.approx(8 / 30)


def test_unknown_clock_is_rejected(smoke):
    _, directory = smoke
    path = directory / "media" / "fixture.mp4"
    with pytest.raises(ValueError, match="Unsupported source clock"):
        list(frames(path, 0.0, 1.0, source_clock="guess"))
    with pytest.raises(ValueError, match="requires a 30 fps r13 AVI"):
        list(frames(path, 0.0, 1.0, source_clock="meva_r13_cfr"))

import pytest

from parking_analytics.models import Vehicle
from parking_analytics.pipeline import ByteTracker, suppress_duplicate_vehicles


def test_bytetrack_preserves_raw_tentative_detections_and_handles_empty_frames():
    pytest.importorskip("supervision", reason="Optional inference dependencies are not installed")
    tracker = ByteTracker(5)
    assert tracker.update([], 400, 240) == []
    vehicle = Vehicle(box=(0.2, 0.2, 0.4, 0.4), label="car", score=0.9)
    results = [tracker.update([vehicle], 400, 240) for _ in range(5)]
    assert all(len(result) == 1 for result in results)
    assert results[-1][0].track_id is not None
    assert results[-1][0].track_id >= 1
    assert tracker.update([], 400, 240) == []


def test_aggregate_vehicle_classes_do_not_count_one_car_and_truck_box_twice():
    pytest.importorskip("torchvision", reason="Optional inference dependencies are not installed")
    vehicles = [
        Vehicle(box=(0.1, 0.1, 0.3, 0.4), label="car", score=0.9),
        Vehicle(box=(0.101, 0.1, 0.301, 0.4), label="truck", score=0.7),
        Vehicle(box=(0.6, 0.1, 0.8, 0.4), label="car", score=0.8),
    ]
    result = suppress_duplicate_vehicles(vehicles, 0.7)
    assert len(result) == 2
    assert result[0].label == "car" and result[0].score == 0.9
    assert result[1].box == vehicles[2].box

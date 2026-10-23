import pytest

from parking_analytics.geometry import ConsecutiveTracker, CrossingCounter, inside, zone_counts
from parking_analytics.models import Gate, Text, Vehicle, Zone


def vehicle(x=0.4, y=0.5, track_id=1):
    return Vehicle(box=(x - 0.02, y - 0.04, x + 0.02, y), label="car", score=0.8, track_id=track_id)


@pytest.fixture
def gate():
    return Gate(
        id="gate",
        name=Text(en="Gate", ro="Limita"),
        start=(0.5, 0.8),
        end=(0.5, 0.2),
        inward_side=1,
    )


def test_finite_crossing_and_real_reentry(gate):
    counter = CrossingCounter([gate], 0.01, 1.0)
    assert counter.update([vehicle(0.4)], 0.0) == []
    events = counter.update([vehicle(0.6)], 0.2)
    assert [(event.direction, event.time_s) for event in events] == [("in", 0.1)]
    assert counter.update([vehicle(0.4)], 0.4)[0].direction == "out"
    assert counter.update([vehicle(0.6)], 0.6)[0].direction == "in"


def test_birth_gap_and_line_extension_do_not_count(gate):
    counter = CrossingCounter([gate], 0.01, 1.0)
    assert counter.update([vehicle(0.6)], 0.0) == []
    assert counter.update([vehicle(0.4)], 2.0) == []
    other = CrossingCounter([gate], 0.01, 1.0)
    other.update([vehicle(0.4, 0.95)], 0.0)
    assert other.update([vehicle(0.6, 0.95)], 0.2) == []


def test_hysteresis_and_exact_boundary_timestamp(gate):
    counter = CrossingCounter([gate], 0.03, 1.0)
    counter.update([vehicle(0.4)], 0.0)
    for index, x in enumerate([0.49, 0.51, 0.49, 0.5], start=1):
        assert counter.update([vehicle(x)], index * 0.2) == []
    event = counter.update([vehicle(0.6)], 1.0)[0]
    assert event.direction == "in"
    assert event.time_s == pytest.approx(0.8)


def test_initialization_on_boundary_is_not_an_entry(gate):
    counter = CrossingCounter([gate], 0.01, 1.0)
    counter.update([vehicle(0.5)], 0.0)
    assert counter.update([vehicle(0.6)], 0.2) == []


def test_shared_boundary_endpoints_do_not_double_count(gate):
    lower = gate.model_copy(update={"id": "lower", "end": (0.5, 0.5)})
    upper = gate.model_copy(update={"id": "upper", "start": (0.5, 0.5)})
    counter = CrossingCounter([lower, upper], 0.01, 1.0)
    counter.update([vehicle(0.4)], 0.0)
    events = counter.update([vehicle(0.6)], 0.2)
    assert len(events) == 1
    assert events[0].gate_id == "upper"


def test_baseline_does_not_bridge_empty_frames_or_long_gaps():
    tracker = ConsecutiveTracker(0.3, 0.3)
    first = tracker.update([vehicle(track_id=None)], 0.0)[0].track_id
    assert tracker.update([vehicle(track_id=None)], 0.2)[0].track_id == first
    tracker.update([], 0.4)
    assert tracker.update([vehicle(track_id=None)], 0.6)[0].track_id != first
    previous = tracker.update([vehicle(track_id=None)], 0.8)[0].track_id
    assert tracker.update([vehicle(track_id=None)], 2.0)[0].track_id != previous


def test_zone_counts_are_not_available_capacity():
    polygon = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
    zone = Zone(id="zone", name=Text(en="Zone", ro="Zona"), polygon=polygon)
    assert inside((0.2, 0.4), polygon)
    assert not inside((0.1, 0.4), polygon)
    observed = zone_counts([vehicle()], [zone])[0]
    assert observed.vehicle_count == 1
    assert observed.capacity is None and observed.available is None
    pending = zone_counts([vehicle(track_id=None)], [zone])[0]
    assert pending.vehicle_count == 1 and pending.unconfirmed_count == 1
    assert pending.available is None and pending.capacity is None
    assert zone_counts([], [zone])[0].available is None

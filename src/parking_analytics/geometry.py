from __future__ import annotations

from dataclasses import dataclass
from math import hypot

import numpy as np
from scipy.optimize import linear_sum_assignment

from parking_analytics.models import Event, Gate, Point, Vehicle, Zone, ZoneCount


def anchor(vehicle: Vehicle) -> Point:
    x1, _, x2, y2 = vehicle.box
    return ((x1 + x2) / 2, y2)


def cross(a: Point, b: Point) -> float:
    return a[0] * b[1] - a[1] * b[0]


def subtract(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1])


def inside(point: Point, polygon: list[Point]) -> bool:
    result = False
    x, y = point
    for a, b in zip(polygon, polygon[1:] + polygon[:1], strict=True):
        offset, edge = subtract(point, a), subtract(b, a)
        if abs(cross(offset, edge)) < 1e-10 and (
            min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1])
        ):
            return True
        if (a[1] > y) != (b[1] > y) and (x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]):
            result = not result
    return result


def zone_counts(vehicles: list[Vehicle], zones: list[Zone]) -> list[ZoneCount]:
    counts = []
    for zone in zones:
        members = [vehicle for vehicle in vehicles if inside(anchor(vehicle), zone.polygon)]
        counts.append(
            ZoneCount(
                zone_id=zone.id,
                vehicle_count=len(members),
                state="observed",
                reason="detections",
                unconfirmed_count=sum(vehicle.track_id is None for vehicle in members),
            )
        )
    return counts


def iou_matrix(first: list[Vehicle], second: list[Vehicle]) -> np.ndarray:
    result = np.zeros((len(first), len(second)))
    for row, a in enumerate(first):
        for col, b in enumerate(second):
            left = max(a.box[0], b.box[0])
            top = max(a.box[1], b.box[1])
            right = min(a.box[2], b.box[2])
            bottom = min(a.box[3], b.box[3])
            intersection = max(0.0, right - left) * max(0.0, bottom - top)
            area_a = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1])
            area_b = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1])
            result[row, col] = intersection / (area_a + area_b - intersection)
    return result


class ConsecutiveTracker:
    def __init__(self, threshold: float, max_gap_s: float) -> None:
        self.threshold = threshold
        self.max_gap_s = max_gap_s
        self.previous: list[Vehicle] = []
        self.previous_time: float | None = None
        self.next_id = 1

    def update(self, vehicles: list[Vehicle], time_s: float) -> list[Vehicle]:
        previous = self.previous
        if self.previous_time is not None and time_s - self.previous_time > self.max_gap_s:
            previous = []
        ids = {}
        if previous and vehicles:
            overlaps = iou_matrix(previous, vehicles)
            rows, cols = linear_sum_assignment(1 - overlaps)
            for row, col in zip(rows, cols, strict=True):
                if overlaps[row, col] >= self.threshold:
                    ids[int(col)] = previous[int(row)].track_id
        tracked = []
        for index, vehicle in enumerate(vehicles):
            track_id = ids.get(index)
            if track_id is None:
                track_id = self.next_id
                self.next_id += 1
            tracked.append(vehicle.model_copy(update={"track_id": track_id}))
        self.previous = tracked
        self.previous_time = time_s
        return tracked


@dataclass
class GateState:
    point: Point
    time_s: float
    stable_side: int
    pending_time: float | None = None
    pending_side: int = 0


class CrossingCounter:
    def __init__(self, gates: list[Gate], band: float, max_gap_s: float) -> None:
        self.gates = gates
        self.band = band
        self.max_gap_s = max_gap_s
        self.states: dict[tuple[str, int], GateState] = {}

    def update(self, vehicles: list[Vehicle], time_s: float) -> list[Event]:
        events = []
        for key in list(self.states):
            if time_s - self.states[key].time_s > self.max_gap_s:
                del self.states[key]
        for vehicle in vehicles:
            if vehicle.track_id is None:
                continue
            point = anchor(vehicle)
            for gate in self.gates:
                key = (gate.id, vehicle.track_id)
                edge = subtract(gate.end, gate.start)
                distance = cross(edge, subtract(point, gate.start)) / hypot(*edge)
                side = 1 if distance > self.band else -1 if distance < -self.band else 0
                state = self.states.get(key)
                if state is None:
                    self.states[key] = GateState(point, time_s, side)
                    continue
                movement = subtract(point, state.point)
                denominator = cross(movement, edge)
                if abs(denominator) > 1e-10:
                    offset = subtract(gate.start, state.point)
                    fraction = cross(offset, edge) / denominator
                    along_gate = cross(offset, movement) / denominator
                    # Half-open segments assign a shared corner to only one boundary.
                    if 0 <= fraction <= 1 and 0 <= along_gate < 1:
                        state.pending_time = state.time_s + fraction * (time_s - state.time_s)
                        state.pending_side = 1 if cross(edge, movement) > 0 else -1
                if side:
                    if state.stable_side and side != state.stable_side:
                        if state.pending_time is not None and state.pending_side == side:
                            events.append(
                                Event(
                                    time_s=round(state.pending_time, 6),
                                    gate_id=gate.id,
                                    direction="in" if side == gate.inward_side else "out",
                                    track_id=vehicle.track_id,
                                )
                            )
                    state.stable_side = side
                    state.pending_time = None
                    state.pending_side = 0
                state.point = point
                state.time_s = time_s
        return sorted(events, key=lambda event: event.time_s)

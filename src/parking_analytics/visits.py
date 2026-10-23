from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import datetime
from itertools import groupby

from parking_analytics.operations_models import IssueCode, PlateEvent, VisitRow


def visit_id(site_id: str, entry_event_id: str) -> str:
    return hashlib.sha256(f"{site_id}\0{entry_event_id}".encode()).hexdigest()[:24]


def make_visit(
    site_id: str,
    entry: PlateEvent,
    exit_event: PlateEvent | None,
    event_ids: list[str],
    flags: set[IssueCode],
    as_of: datetime,
) -> VisitRow:
    if entry.plate is None or entry.country_code is None:
        raise ValueError("A visit must have an identifiable entry record")
    duration = None
    elapsed = None
    if not flags:
        if exit_event is not None:
            duration = int((exit_event.occurred_at - entry.occurred_at).total_seconds())
        else:
            elapsed = int((as_of - entry.occurred_at).total_seconds())
    return VisitRow(
        visit_id=visit_id(site_id, entry.event_id),
        plate=entry.plate,
        country_code=entry.country_code,
        entered_at=entry.occurred_at,
        exited_at=exit_event.occurred_at if exit_event else None,
        entry_event_id=entry.event_id,
        exit_event_id=exit_event.event_id if exit_event else None,
        status="needs_review" if flags else "completed" if exit_event else "active",
        duration_seconds=duration,
        elapsed_seconds=elapsed,
        issues=sorted(flags),
        event_ids=list(event_ids),
    )


def derive_visits(
    site_id: str, events: list[PlateEvent], as_of: datetime
) -> tuple[list[VisitRow], dict[str, list[IssueCode]]]:
    issues: dict[str, set[IssueCode]] = {event.event_id: set() for event in events}
    buckets: dict[tuple[str, str], list[PlateEvent]] = defaultdict(list)
    for event in events:
        if event.review_state == "ignored":
            continue
        if event.occurred_at > as_of:
            issues[event.event_id].add("future_timestamp")
            continue
        if event.plate is None or event.country_code is None:
            issues[event.event_id].add("unreadable_plate")
            continue
        buckets[(event.country_code, event.plate)].append(event)

    visits = []
    for bucket in buckets.values():
        pending: PlateEvent | None = None
        involved: list[str] = []
        flags: set[IssueCode] = set()

        ordered = sorted(bucket, key=lambda event: (event.occurred_at, event.event_id))
        for _, same_time in groupby(ordered, key=lambda event: event.occurred_at):
            simultaneous = list(same_time)
            if len(simultaneous) > 1:
                for event in simultaneous:
                    issues[event.event_id].add("simultaneous_events")
                if pending is not None:
                    flags.add("simultaneous_events")
                    involved.extend(event.event_id for event in simultaneous)
                continue
            event = simultaneous[0]
            if event.review_state != "confirmed":
                issues[event.event_id].add("unreviewed_event")
                if pending is not None:
                    flags.add("unreviewed_event")
                    involved.append(event.event_id)
                continue
            if event.direction == "in":
                if pending is None:
                    pending = event
                    involved = [event.event_id]
                    flags = set()
                else:
                    flags.add("duplicate_entry")
                    issues[event.event_id].add("duplicate_entry")
                    involved.append(event.event_id)
            elif pending is None:
                issues[event.event_id].add("unmatched_exit")
            else:
                involved.append(event.event_id)
                for event_id in involved:
                    issues[event_id].update(flags)
                visits.append(make_visit(site_id, pending, event, involved, flags, as_of))
                pending = None
                involved = []
                flags = set()
        if pending is not None:
            for event_id in involved:
                issues[event_id].update(flags)
            visits.append(make_visit(site_id, pending, None, involved, flags, as_of))
    return visits, {key: sorted(value) for key, value in issues.items()}

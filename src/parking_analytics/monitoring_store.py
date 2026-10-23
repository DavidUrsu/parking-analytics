from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing, contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from parking_analytics.calculators import calculate_fee
from parking_analytics.operations_models import (
    BillingQuote,
    EventCorrection,
    EventDetail,
    EventLookup,
    EventManifest,
    EventRow,
    ImportResult,
    ManualQuoteRequest,
    PlateEvent,
    ReviewAudit,
    SearchRequest,
    SearchResult,
    SiteInfo,
    VisitLookup,
    VisitQuoteRequest,
    VisitRow,
    utc_datetime,
)
from parking_analytics.visits import derive_visits

ROOT = Path(__file__).resolve().parents[2]
APPLICATION_ID = 0x5041524B
SCHEMA_VERSION = 2


class ConflictError(ValueError):
    pass


class MissingRecordError(ValueError):
    pass


def inside_viewer(path: Path) -> bool:
    viewer = (ROOT / "viewer").resolve()
    return Path(os.path.abspath(path)).is_relative_to(viewer) or path.resolve().is_relative_to(
        viewer
    )


def private_database_path(path: Path) -> Path:
    resolved = path.resolve()
    if inside_viewer(path):
        raise ValueError("Plate databases must stay outside the served viewer directory")
    if resolved.suffix not in (".sqlite", ".sqlite3", ".db"):
        raise ValueError("Use a private .sqlite, .sqlite3 or .db file")
    return resolved


def initialize_database(path: Path) -> None:
    path = private_database_path(path)
    existed = path.exists() and path.stat().st_size > 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as connection:
        identity = connection.execute("PRAGMA application_id").fetchone()[0]
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if existed and (identity != APPLICATION_ID or version not in (1, SCHEMA_VERSION)):
            raise ValueError("Refusing to modify an unrelated or unsupported SQLite database")
        if existed and version == SCHEMA_VERSION:
            return
        if existed:
            backup = path.with_name(f"{path.stem}-v1-backup-{uuid4().hex}.sqlite3")
            with closing(sqlite3.connect(backup)) as destination:
                connection.backup(destination)
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                create_analysis_tables(connection)
                connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            return
        with connection:
            connection.executescript("""
                CREATE TABLE sites (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, source_kind TEXT NOT NULL
                );
                CREATE TABLE events (
                    site_id TEXT NOT NULL REFERENCES sites(id),
                    event_id TEXT NOT NULL,
                    original_payload TEXT NOT NULL,
                    original_hash TEXT NOT NULL,
                    effective_payload TEXT NOT NULL,
                    source_label TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    PRIMARY KEY (site_id, event_id)
                );
                CREATE INDEX event_times ON events(site_id, occurred_at);
                CREATE TABLE review_audit (
                    id INTEGER PRIMARY KEY,
                    site_id TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    changed_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    before_payload TEXT NOT NULL,
                    after_payload TEXT NOT NULL,
                    FOREIGN KEY(site_id,event_id) REFERENCES events(site_id,event_id)
                );
            """)
            create_analysis_tables(connection)
            connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def create_analysis_tables(connection: sqlite3.Connection) -> None:
    connection.execute("CREATE TABLE analysis_videos(id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
    connection.execute(
        """CREATE TABLE analysis_jobs(
               id TEXT PRIMARY KEY,
               video_id TEXT NOT NULL REFERENCES analysis_videos(id),
               status TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL
           )"""
    )
    connection.execute(
        "CREATE TABLE analysis_presets("
        "id TEXT PRIMARY KEY,name TEXT NOT NULL,payload TEXT NOT NULL)"
    )
    connection.execute("CREATE INDEX analysis_queue ON analysis_jobs(status,created_at,id)")


@contextmanager
def database(path: Path, *, write: bool = False):
    path = private_database_path(path)
    if not path.is_file():
        raise FileNotFoundError("Operations database is missing; start 'parking serve' first")
    with closing(sqlite3.connect(path, timeout=5)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        if connection.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
            raise ValueError("Unrecognized operations database")
        if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
            raise ValueError("Unsupported operations database schema")
        connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        with connection:
            yield connection


def timestamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def stored_event(payload: str) -> PlateEvent:
    try:
        return PlateEvent.model_validate_json(payload)
    except ValidationError as error:
        raise RuntimeError(
            "Stored event data is invalid; inspect or restore the private database"
        ) from error


def site_info(connection: sqlite3.Connection, site_id: str) -> SiteInfo:
    row = connection.execute(
        """SELECT s.id,s.name,s.source_kind,COUNT(e.event_id) AS event_count,
                  MIN(e.occurred_at) AS first_event_at,MAX(e.occurred_at) AS last_event_at
           FROM sites s LEFT JOIN events e ON s.id=e.site_id WHERE s.id=? GROUP BY s.id""",
        (site_id,),
    ).fetchone()
    if row is None:
        raise MissingRecordError(
            "Site was not found; import an authorized log or open the test example"
        )
    return SiteInfo.model_validate_json(json.dumps(dict(row)))


def list_sites(path: Path) -> list[SiteInfo]:
    with database(path) as connection:
        ids = [row[0] for row in connection.execute("SELECT id FROM sites ORDER BY name,id")]
        return [site_info(connection, site_id) for site_id in ids]


def import_events(path: Path, manifest: EventManifest) -> ImportResult:
    with database(path, write=True) as connection:
        row = connection.execute(
            "SELECT name,source_kind FROM sites WHERE id=?", (manifest.site_id,)
        ).fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO sites(id,name,source_kind) VALUES(?,?,?)",
                (manifest.site_id, manifest.site_name, manifest.source_kind),
            )
        elif row["name"] != manifest.site_name or row["source_kind"] != manifest.source_kind:
            raise ConflictError(
                "Site name/source kind conflicts; real and synthetic sources cannot mix"
            )
        imported = duplicates = 0
        for event in manifest.events:
            existing = connection.execute(
                "SELECT original_hash FROM events WHERE site_id=? AND event_id=?",
                (manifest.site_id, event.event_id),
            ).fetchone()
            if existing is not None:
                if existing["original_hash"] != event.digest():
                    raise ConflictError(
                        f"Event ID {event.event_id} has different original data; import rolled back"
                    )
                duplicates += 1
                continue
            payload = event.model_dump_json()
            connection.execute(
                """INSERT INTO events(
                       site_id,event_id,original_payload,original_hash,effective_payload,
                       source_label,occurred_at
                   ) VALUES(?,?,?,?,?,?,?)""",
                (
                    manifest.site_id,
                    event.event_id,
                    payload,
                    event.digest(),
                    payload,
                    manifest.source_label,
                    timestamp(event.occurred_at),
                ),
            )
            imported += 1
        return ImportResult(
            site=site_info(connection, manifest.site_id), imported=imported, duplicates=duplicates
        )


def source_events(connection: sqlite3.Connection, site_id: str):
    rows = connection.execute(
        """SELECT e.*,COUNT(a.id) AS review_count FROM events e
           LEFT JOIN review_audit a ON e.site_id=a.site_id AND e.event_id=a.event_id
           WHERE e.site_id=? GROUP BY e.site_id,e.event_id ORDER BY e.occurred_at,e.event_id""",
        (site_id,),
    ).fetchall()
    return [(stored_event(row["effective_payload"]), row) for row in rows]


def event_detail(path: Path, lookup: EventLookup) -> EventDetail:
    with database(path) as connection:
        site = site_info(connection, lookup.site_id)
        row = connection.execute(
            "SELECT * FROM events WHERE site_id=? AND event_id=?",
            (lookup.site_id, lookup.event_id),
        ).fetchone()
        if row is None:
            raise MissingRecordError("Event was not found")
        audits = connection.execute(
            """SELECT * FROM review_audit WHERE site_id=? AND event_id=?
               ORDER BY changed_at,id""",
            (lookup.site_id, lookup.event_id),
        ).fetchall()
        return EventDetail(
            site=site,
            original=stored_event(row["original_payload"]),
            current=stored_event(row["effective_payload"]),
            current_hash=stored_event(row["effective_payload"]).digest(),
            source_label=row["source_label"],
            audit=[
                ReviewAudit(
                    changed_at=utc_datetime(audit["changed_at"]),
                    reason=audit["reason"],
                    before=stored_event(audit["before_payload"]),
                    after=stored_event(audit["after_payload"]),
                )
                for audit in audits
            ],
        )


def review_event(path: Path, correction: EventCorrection) -> EventDetail:
    with database(path, write=True) as connection:
        row = connection.execute(
            "SELECT effective_payload FROM events WHERE site_id=? AND event_id=?",
            (correction.site_id, correction.event_id),
        ).fetchone()
        if row is None:
            raise MissingRecordError("Event was not found")
        previous = stored_event(row["effective_payload"])
        if previous.digest() != correction.expected_event_hash:
            raise ConflictError(
                "Event changed since it was opened; reload before applying corrections"
            )
        changes = correction.model_dump(
            exclude={"site_id", "event_id", "reason", "source_checked", "expected_event_hash"}
        )
        updated = PlateEvent.model_validate(previous.model_dump() | changes)
        payload = updated.model_dump_json()
        connection.execute(
            "UPDATE events SET effective_payload=?,occurred_at=? WHERE site_id=? AND event_id=?",
            (payload, timestamp(updated.occurred_at), correction.site_id, correction.event_id),
        )
        connection.execute(
            """INSERT INTO review_audit(
                   site_id,event_id,changed_at,reason,before_payload,after_payload
               ) VALUES(?,?,?,?,?,?)""",
            (
                correction.site_id,
                correction.event_id,
                timestamp(datetime.now(UTC)),
                correction.reason,
                previous.model_dump_json(),
                payload,
            ),
        )
    return event_detail(path, correction)


def search(path: Path, request: SearchRequest, *, as_of: datetime | None = None) -> SearchResult:
    now = utc_datetime(as_of or datetime.now(UTC))
    with database(path) as connection:
        site = site_info(connection, request.site_id)
        sources = source_events(connection, request.site_id)
    events = [event for event, _ in sources]
    visits, issues = derive_visits(request.site_id, events, now)
    window = (
        (request.start, request.end)
        if request.start is not None and request.end is not None
        else None
    )
    all_event_rows = [
        EventRow(
            event_id=event.event_id,
            occurred_at=event.occurred_at,
            direction=event.direction,
            plate=event.plate,
            country_code=event.country_code,
            review_state=event.review_state,
            confidence=event.confidence,
            camera_id=event.camera_id,
            source_label=row["source_label"],
            issues=issues[event.event_id],
            review_count=row["review_count"],
        )
        for event, row in sources
    ]
    event_rows = [row for row in all_event_rows if row.review_state != "ignored"]

    def identity_matches(record: EventRow | VisitRow) -> bool:
        return (request.plate is None or record.plate == request.plate) and (
            request.country_code is None or record.country_code == request.country_code
        )

    def in_window(value: datetime) -> bool:
        return window is None or window[0] <= value < window[1]

    def overlaps(visit: VisitRow) -> bool:
        if window is None:
            return True
        last = visit.exited_at or now
        return visit.entered_at < window[1] and last > window[0]

    records: list[EventRow | VisitRow]
    if request.view in ("entries", "exits"):
        direction = "in" if request.view == "entries" else "out"
        records = [
            row for row in event_rows if row.direction == direction and in_window(row.occurred_at)
        ]
    elif request.view == "review":
        records = [row for row in event_rows if row.issues and in_window(row.occurred_at)]
    elif request.view == "audit":
        records = [
            row
            for row in all_event_rows
            if (row.review_count > 0 or row.review_state == "ignored")
            and in_window(row.occurred_at)
        ]
    elif request.view == "active":
        records = [visit for visit in visits if visit.exited_at is None]
    elif request.view == "present":
        records = [visit for visit in visits if overlaps(visit)]
    else:
        paired_ids = {
            event_id
            for visit in visits
            for event_id in (visit.entry_event_id, visit.exit_event_id)
            if event_id is not None
        }
        records = [visit for visit in visits if overlaps(visit)] + [
            row
            for row in event_rows
            if row.event_id not in paired_ids and in_window(row.occurred_at)
        ]
    records = [record for record in records if identity_matches(record)]
    records.sort(
        key=lambda record: (
            record.occurred_at if isinstance(record, EventRow) else record.entered_at,
            record.event_id if isinstance(record, EventRow) else record.visit_id,
        ),
        reverse=True,
    )
    return SearchResult(
        site=site,
        as_of=now,
        view=request.view,
        total=len(records),
        offset=request.offset,
        limit=request.limit,
        records=records[request.offset : request.offset + request.limit],
    )


def get_visit(path: Path, lookup: VisitLookup) -> tuple[SiteInfo, VisitRow]:
    with database(path) as connection:
        site = site_info(connection, lookup.site_id)
        events = [event for event, _ in source_events(connection, lookup.site_id)]
    visits, _ = derive_visits(lookup.site_id, events, datetime.now(UTC))
    for visit in visits:
        if visit.visit_id == lookup.visit_id:
            return site, visit
    raise MissingRecordError("Visit was not found; it may have changed after event corrections")


def quote_visit(path: Path, request: VisitQuoteRequest) -> BillingQuote:
    site, visit = get_visit(path, request)
    if visit.status != "completed" or visit.exited_at is None:
        raise ConflictError(
            "Only completed, unambiguous visits can be priced; resolve events first"
        )
    result = calculate_fee(
        ManualQuoteRequest(
            entered_at=visit.entered_at, exited_at=visit.exited_at, policy=request.policy
        )
    )
    return result.model_copy(
        update={
            "basis": "completed_visit",
            "source_kind": site.source_kind,
            "visit_id": visit.visit_id,
        }
    )


def example_manifest(site_id: str = "example", *, anchor: datetime | None = None) -> EventManifest:
    now = utc_datetime(anchor or datetime.now(UTC)).replace(microsecond=0)
    specifications = [
        ("one-in", "DEMO001", "in", -180, "confirmed"),
        ("one-out", "DEMO001", "out", -120, "confirmed"),
        ("one-in-again", "DEMO001", "in", -105, "confirmed"),
        ("one-out-again", "DEMO001", "out", -60, "confirmed"),
        ("two-in", "DEMO002", "in", -30, "confirmed"),
        ("orphan-out", "DEMO003", "out", -20, "confirmed"),
        ("unreadable", None, "in", -15, "needs_review"),
        ("duplicate-in-first", "DEMO004", "in", -165, "confirmed"),
        ("duplicate-in-second", "DEMO004", "in", -164, "confirmed"),
        ("duplicate-out", "DEMO004", "out", -105, "confirmed"),
        ("uncertain-in", "DEMO005", "in", -10, "needs_review"),
    ]
    return EventManifest.model_validate(
        {
            "schema_version": "1.0",
            "site_id": site_id,
            "site_name": f"Synthetic operator example ({site_id})",
            "source_label": "Generated test events; no plate-recognition model was run",
            "source_kind": "synthetic",
            "rights_attested": False,
            "events": [
                {
                    "event_id": event_id,
                    "occurred_at": now + timedelta(minutes=minutes),
                    "direction": direction,
                    "plate": plate,
                    "country_code": "RO" if plate else None,
                    "review_state": state,
                    "confidence": None,
                    "camera_id": "generated-example",
                }
                for event_id, plate, direction, minutes, state in specifications
            ],
        }
    )

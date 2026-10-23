import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from parking_analytics.calculators import calculate_capacity, calculate_fee
from parking_analytics.monitoring_store import (
    ROOT,
    ConflictError,
    event_detail,
    example_manifest,
    import_events,
    initialize_database,
    list_sites,
    quote_visit,
    review_event,
    search,
)
from parking_analytics.operations_models import (
    OPERATIONS_ADAPTER,
    BillingPolicy,
    CapacityRequest,
    EventCorrection,
    EventLookup,
    EventManifest,
    ManualQuoteRequest,
    PlateEvent,
    SearchRequest,
    VisitQuoteRequest,
)
from parking_analytics.visits import derive_visits

ANCHOR = datetime(2026, 1, 15, 12, tzinfo=UTC)
POLICY = BillingPolicy(currency="EUR", price_minor=105, interval_minutes=30, free_minutes=15)


def test_operational_response_schema_matches_the_python_models():
    schema = json.loads((ROOT / "viewer" / "src" / "operations.schema.json").read_text())
    assert schema == OPERATIONS_ADAPTER.json_schema(mode="serialization")


@pytest.fixture
def operations_db(tmp_path):
    path = tmp_path / "operator.sqlite3"
    initialize_database(path)
    manifest = example_manifest(anchor=ANCHOR)
    result = import_events(path, manifest)
    assert result.imported == 11
    return path, manifest


def test_exact_plate_history_retains_multiple_visits_and_separates_countries(operations_db):
    path, manifest = operations_db
    result = search(path, SearchRequest(site_id="example", plate="demo-001"), as_of=ANCHOR)
    assert len(result.records) == 2
    assert all(record.status == "completed" for record in result.records)
    assert sorted(record.duration_seconds for record in result.records) == [2700, 3600]
    assert search(path, SearchRequest(site_id="example", plate="DEMO00I"), as_of=ANCHOR).total == 0
    events = [
        manifest.events[0].model_copy(update={"event_id": "ro-in", "country_code": "RO"}),
        manifest.events[1].model_copy(update={"event_id": "de-out", "country_code": "DE"}),
    ]
    visits, issues = derive_visits("example", events, ANCHOR)
    assert len(visits) == 1 and visits[0].status == "active"
    assert issues["de-out"] == ["unmatched_exit"]


def test_entries_exits_and_overlap_have_distinct_half_open_semantics(operations_db):
    path, _ = operations_db
    params = {
        "site_id": "example",
        "plate": "DEMO001",
        "start": ANCHOR - timedelta(hours=2, minutes=30),
        "end": ANCHOR - timedelta(hours=1, minutes=45),
    }
    entries = search(path, SearchRequest(view="entries", **params), as_of=ANCHOR)
    exits = search(path, SearchRequest(view="exits", **params), as_of=ANCHOR)
    present = search(path, SearchRequest(view="present", **params), as_of=ANCHOR)
    assert entries.total == 0
    assert exits.total == 1 and exits.records[0].event_id == "one-out"
    assert present.total == 1 and present.records[0].entry_event_id == "one-in"
    normalized = SearchRequest.model_validate_json(
        '{"site_id":"example","start":"2026-01-15T11:30:00+02:00",'
        '"end":"2026-01-15T12:15:00+02:00"}'
    )
    assert normalized.start == params["start"] and normalized.end == params["end"]


def test_open_and_ambiguous_visits_never_get_a_final_duration_or_fee(operations_db):
    path, _ = operations_db
    active = search(path, SearchRequest(site_id="example", view="active"), as_of=ANCHOR)
    assert active.total == 1
    visit = active.records[0]
    assert visit.plate == "DEMO002" and visit.elapsed_seconds == 1800
    assert visit.exited_at is None and visit.duration_seconds is None
    with pytest.raises(ConflictError, match="completed"):
        quote_visit(
            path, VisitQuoteRequest(site_id="example", visit_id=visit.visit_id, policy=POLICY)
        )
    ambiguous = search(path, SearchRequest(site_id="example", plate="DEMO004"), as_of=ANCHOR)
    candidate = next(row for row in ambiguous.records if row.record_type == "visit")
    assert candidate.status == "needs_review" and candidate.duration_seconds is None
    assert candidate.entered_at == ANCHOR - timedelta(minutes=165)
    with pytest.raises(ConflictError):
        quote_visit(
            path, VisitQuoteRequest(site_id="example", visit_id=candidate.visit_id, policy=POLICY)
        )


def test_orphan_and_unreadable_events_remain_reviewable(operations_db):
    path, _ = operations_db
    review = search(path, SearchRequest(site_id="example", view="review"), as_of=ANCHOR)
    assert review.total == 6
    by_id = {record.event_id: record for record in review.records}
    assert by_id["orphan-out"].issues == ["unmatched_exit"]
    assert by_id["unreadable"].plate is None
    assert "unreadable_plate" in by_id["unreadable"].issues
    assert "unreviewed_event" in by_id["uncertain-in"].issues


def test_review_is_audited_and_reimports_do_not_undo_it(operations_db):
    path, manifest = operations_db
    original = next(event for event in manifest.events if event.event_id == "duplicate-in-second")
    correction = EventCorrection(
        site_id="example",
        event_id=original.event_id,
        expected_event_hash=original.digest(),
        occurred_at=original.occurred_at,
        plate=original.plate,
        country_code=original.country_code,
        direction=original.direction,
        review_state="ignored",
        reason="Synthetic duplicate checked against the generated source",
        source_checked=True,
    )
    detail = review_event(path, correction)
    assert detail.original.review_state == "confirmed" and detail.current.review_state == "ignored"
    assert len(detail.audit) == 1
    duplicate = import_events(path, manifest)
    assert duplicate.imported == 0 and duplicate.duplicates == 11
    restored = event_detail(path, EventLookup(site_id="example", event_id=original.event_id))
    assert restored.current.review_state == "ignored" and len(restored.audit) == 1
    audited = search(path, SearchRequest(site_id="example", view="audit"), as_of=ANCHOR)
    assert audited.total == 1 and audited.records[0].review_state == "ignored"
    with pytest.raises(ConflictError, match="changed"):
        review_event(path, correction)
    visit = next(
        record
        for record in search(
            path, SearchRequest(site_id="example", plate="DEMO004"), as_of=ANCHOR
        ).records
        if record.record_type == "visit"
    )
    assert visit.status == "completed" and visit.duration_seconds == 3600
    quote = quote_visit(
        path, VisitQuoteRequest(site_id="example", visit_id=visit.visit_id, policy=POLICY)
    )
    assert quote.basis == "completed_visit" and quote.source_kind == "synthetic"
    assert quote.total_minor == 210 and not quote.is_invoice


def test_conflicting_import_rolls_back_the_entire_batch(operations_db):
    path, manifest = operations_db
    fresh = manifest.events[0].model_copy(update={"event_id": "new-before-conflict"})
    changed = manifest.events[0].model_copy(
        update={"occurred_at": manifest.events[0].occurred_at + timedelta(seconds=1)}
    )
    with pytest.raises(ConflictError):
        import_events(path, manifest.model_copy(update={"events": [fresh, changed]}))
    assert list_sites(path)[0].event_count == 11
    with pytest.raises(ConflictError, match="cannot mix"):
        import_events(
            path,
            manifest.model_copy(update={"source_kind": "authorized_log", "rights_attested": True}),
        )


def test_out_of_order_batches_reconstruct_visits_without_guessing(operations_db):
    path, _ = operations_db
    common = {
        "schema_version": "1.0",
        "site_id": "late",
        "site_name": "Late synthetic events",
        "source_label": "Generated test",
        "source_kind": "synthetic",
        "rights_attested": False,
    }
    end = PlateEvent(
        event_id="exit",
        occurred_at=ANCHOR - timedelta(hours=1),
        direction="out",
        plate="DEMO900",
        country_code="RO",
        review_state="confirmed",
    )
    start = end.model_copy(
        update={"event_id": "entry", "occurred_at": ANCHOR - timedelta(hours=2), "direction": "in"}
    )
    import_events(path, EventManifest(events=[end], **common))
    assert search(path, SearchRequest(site_id="late", view="review"), as_of=ANCHOR).total == 1
    import_events(path, EventManifest(events=[start], **common))
    result = search(path, SearchRequest(site_id="late"), as_of=ANCHOR)
    assert result.total == 1 and result.records[0].duration_seconds == 3600


def test_same_timestamp_and_uncertain_intermediate_reads_do_not_create_billable_pairs():
    base = PlateEvent(
        event_id="in",
        occurred_at=ANCHOR - timedelta(hours=1),
        direction="in",
        plate="DEMO700",
        country_code="RO",
        review_state="confirmed",
    )
    same_time_exit = base.model_copy(update={"event_id": "out", "direction": "out"})
    visits, issues = derive_visits("test", [base, same_time_exit], ANCHOR)
    assert visits == []
    assert all("simultaneous_events" in flags for flags in issues.values())
    uncertain = base.model_copy(
        update={
            "event_id": "uncertain",
            "occurred_at": base.occurred_at + timedelta(minutes=10),
            "review_state": "needs_review",
        }
    )
    end = base.model_copy(
        update={
            "event_id": "later-out",
            "occurred_at": base.occurred_at + timedelta(minutes=20),
            "direction": "out",
        }
    )
    visits, _ = derive_visits("test", [base, uncertain, end], ANCHOR)
    assert visits[0].status == "needs_review" and visits[0].duration_seconds is None
    future = base.model_copy(
        update={"event_id": "future", "occurred_at": ANCHOR + timedelta(hours=1)}
    )
    visits, issues = derive_visits("test", [future], ANCHOR)
    assert not visits and issues["future"] == ["future_timestamp"]


def test_query_pagination_and_validation(operations_db):
    path, _ = operations_db
    first = search(path, SearchRequest(site_id="example", view="entries", limit=2), as_of=ANCHOR)
    second = search(
        path, SearchRequest(site_id="example", view="entries", limit=2, offset=2), as_of=ANCHOR
    )
    assert first.total == second.total == 7
    assert {row.event_id for row in first.records}.isdisjoint(
        row.event_id for row in second.records
    )
    for raw in [
        '{"site_id":"example","start":"2026-01-01T00:00:00"}',
        '{"site_id":"example","view":"present"}',
        '{"site_id":"example","plate":"AB\'12"}',
        '{"site_id":"example","start":"2026-01-02T00:00:00Z","end":"2026-01-01T00:00:00Z"}',
        '{"site_id":"example","view":"active","start":"2026-01-01T00:00:00Z","end":"2026-01-02T00:00:00Z"}',
    ]:
        with pytest.raises(ValidationError):
            SearchRequest.model_validate_json(raw)


def test_real_import_needs_authorization_and_confirmed_reads_need_a_plate():
    manifest = example_manifest(anchor=ANCHOR).model_dump(mode="json")
    manifest["source_kind"] = "authorized_log"
    with pytest.raises(ValidationError, match="authorization"):
        EventManifest.model_validate_json(json.dumps(manifest))
    with pytest.raises(ValidationError, match="readable"):
        PlateEvent(
            event_id="bad",
            occurred_at=ANCHOR,
            direction="in",
            plate=None,
            country_code="RO",
            review_state="confirmed",
        )


def test_database_is_private_and_unrelated_databases_are_not_modified(tmp_path):
    with pytest.raises(ValueError, match="served viewer"):
        initialize_database(ROOT / "viewer" / "public" / "forbidden.sqlite3")
    path = tmp_path / "unrelated.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE unrelated(value TEXT)")
    before = path.read_bytes()
    with pytest.raises(ValueError, match="unrelated"):
        initialize_database(path)
    assert path.read_bytes() == before


def test_billing_uses_exact_minor_units_explicit_free_time_and_started_intervals():
    request = ManualQuoteRequest(
        entered_at=ANCHOR, exited_at=ANCHOR + timedelta(minutes=75), policy=POLICY
    )
    quote = calculate_fee(request)
    assert quote.duration_seconds == 4500 and quote.billable_seconds == 3600
    assert quote.charged_intervals == 2 and quote.total_minor == 210
    exact = request.model_copy(
        update={
            "exited_at": ANCHOR + timedelta(hours=1),
            "policy": BillingPolicy(
                currency="RON", price_minor=103, interval_minutes=60, free_minutes=0
            ),
        }
    )
    assert calculate_fee(exact).total_minor == 103
    assert (
        calculate_fee(
            exact.model_copy(update={"exited_at": exact.exited_at + timedelta(microseconds=1)})
        ).total_minor
        == 206
    )
    assert calculate_fee(exact.model_copy(update={"exited_at": ANCHOR})).total_minor == 0


def test_billing_respects_offsets_and_rejects_backwards_or_naive_times():
    request = ManualQuoteRequest.model_validate_json(
        '{"entered_at":"2026-03-29T01:30:00+01:00",'
        '"exited_at":"2026-03-29T03:30:00+02:00",'
        '"policy":{"currency":"EUR","price_minor":500,"interval_minutes":60,"free_minutes":0}}'
    )
    assert calculate_fee(request).duration_seconds == 3600
    with pytest.raises(ValidationError):
        ManualQuoteRequest(
            entered_at=ANCHOR, exited_at=ANCHOR - timedelta(seconds=1), policy=POLICY
        )
    with pytest.raises(ValidationError):
        BillingPolicy(currency="EUR", price_minor=1.5, interval_minutes=30, free_minutes=0)


def test_capacity_never_turns_unknown_spaces_into_free_spaces():
    result = calculate_capacity(
        CapacityRequest(mapped_spaces=100, occupied_spaces=60, unknown_spaces=30)
    )
    assert result.available_mapped_spaces == 10 and result.whole_site_capacity is None
    assert result.basis == "operator_inputs"
    assert (
        calculate_capacity(
            CapacityRequest(mapped_spaces=20, occupied_spaces=0, unknown_spaces=20)
        ).available_mapped_spaces
        == 0
    )
    with pytest.raises(ValidationError):
        CapacityRequest(mapped_spaces=10, occupied_spaces=8, unknown_spaces=3)
    with pytest.raises(ValidationError):
        CapacityRequest(mapped_spaces=10, occupied_spaces=0, unknown_spaces=-1)

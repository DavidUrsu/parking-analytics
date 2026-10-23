from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BeforeValidator, Field, TypeAdapter, model_validator

from parking_analytics.models import Digest, Model

SAFE_INTEGER = 9_007_199_254_740_991
SiteId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
EventId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")]
SourceKind = Literal["authorized_log", "anpr_log", "synthetic"]
ReviewState = Literal["confirmed", "needs_review", "ignored"]
View = Literal["visits", "entries", "exits", "present", "active", "review", "audit"]
IssueCode = Literal[
    "unreadable_plate",
    "unreviewed_event",
    "duplicate_entry",
    "unmatched_exit",
    "simultaneous_events",
    "future_timestamp",
]


def utc_datetime(value: object) -> datetime:
    if isinstance(value, str):
        if re.search(r"[.,]\d{7,}", value):
            raise ValueError("Timestamps support at most six fractional decimal places")
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("Use an ISO-8601 timestamp with a timezone offset") from error
    elif isinstance(value, datetime):
        result = value
    else:
        raise ValueError("Timestamp must be an ISO-8601 string with a timezone")
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("Naive timestamps are not allowed; include Z or a timezone offset")
    try:
        return result.astimezone(UTC)
    except (ValueError, OverflowError) as error:
        raise ValueError("Timestamp is outside the supported UTC range") from error


def normalize_plate(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Plate must be text")
    if not re.fullmatch(r"[A-Za-z0-9 -]+", value.strip()):
        raise ValueError("Plate must use ASCII letters/digits, spaces or hyphens")
    normalized = re.sub(r"[ -]", "", value.strip().upper())
    if not re.fullmatch(r"[A-Z0-9]{2,12}", normalized):
        raise ValueError("Use 2-12 ASCII letters/digits, with optional spaces or hyphens")
    return normalized


def normalize_country(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z]{2}", value):
        raise ValueError("Country/jurisdiction must be two letters or null")
    return value.upper()


UtcTime = Annotated[AwareDatetime, BeforeValidator(utc_datetime)]
Plate = Annotated[str | None, BeforeValidator(normalize_plate)]
Country = Annotated[str | None, BeforeValidator(normalize_country)]


class PlateEvent(Model):
    event_id: EventId
    occurred_at: UtcTime
    direction: Literal["in", "out"]
    plate: Plate
    country_code: Country
    review_state: ReviewState
    confidence: float | None = Field(default=None, ge=0, le=1)
    camera_id: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def confirmed_identity(self) -> Self:
        if self.review_state == "confirmed" and (self.plate is None or self.country_code is None):
            raise ValueError("Confirmed events require a readable plate and jurisdiction")
        return self


class EventManifest(Model):
    schema_version: Literal["1.0"]
    site_id: SiteId
    site_name: str = Field(min_length=1, max_length=160)
    source_label: str = Field(min_length=1, max_length=200)
    source_kind: SourceKind
    rights_attested: bool
    events: list[PlateEvent] = Field(min_length=1, max_length=10_000)

    @model_validator(mode="after")
    def valid_source(self) -> Self:
        if self.source_kind != "synthetic" and not self.rights_attested:
            raise ValueError("Real event imports require an explicit authorization attestation")
        if len({event.event_id for event in self.events}) != len(self.events):
            raise ValueError("An import must not contain duplicate event IDs")
        return self


class SiteInfo(Model):
    id: SiteId
    name: str
    source_kind: SourceKind
    event_count: int = Field(ge=0)
    first_event_at: UtcTime | None
    last_event_at: UtcTime | None


class SiteList(Model):
    kind: Literal["sites"] = "sites"
    sites: list[SiteInfo]


class ImportResult(Model):
    kind: Literal["import"] = "import"
    site: SiteInfo
    imported: int = Field(ge=0)
    duplicates: int = Field(ge=0)


class SearchRequest(Model):
    site_id: SiteId
    view: View = "visits"
    plate: Plate = None
    country_code: Country = None
    start: UtcTime | None = None
    end: UtcTime | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=200)

    @model_validator(mode="after")
    def valid_window(self) -> Self:
        if (self.start is None) != (self.end is None):
            raise ValueError("Provide both start and end, or neither")
        if self.start is not None and self.end is not None and self.start >= self.end:
            raise ValueError("Start must be earlier than end")
        if self.view == "present" and self.start is None:
            raise ValueError("Visits overlapping a period require start and end")
        if self.view == "active" and self.start is not None:
            raise ValueError(
                "Active/unclosed visits use the response as_of time, not a date window"
            )
        return self


class EventRow(Model):
    record_type: Literal["event"] = "event"
    event_id: str
    occurred_at: UtcTime
    direction: Literal["in", "out"]
    plate: str | None
    country_code: str | None
    review_state: ReviewState
    confidence: float | None
    camera_id: str | None
    source_label: str
    issues: list[IssueCode]
    review_count: int = Field(ge=0)


class VisitRow(Model):
    record_type: Literal["visit"] = "visit"
    visit_id: str
    plate: str
    country_code: str
    entered_at: UtcTime
    exited_at: UtcTime | None
    entry_event_id: str
    exit_event_id: str | None
    status: Literal["active", "completed", "needs_review"]
    duration_seconds: int | None = Field(ge=0)
    elapsed_seconds: int | None = Field(ge=0)
    issues: list[IssueCode]
    event_ids: list[str]


class SearchResult(Model):
    kind: Literal["monitoring"] = "monitoring"
    site: SiteInfo
    as_of: UtcTime
    view: View
    total: int = Field(ge=0)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1)
    records: list[EventRow | VisitRow]


class EventLookup(Model):
    site_id: SiteId
    event_id: EventId


class EventCorrection(EventLookup):
    expected_event_hash: Digest
    occurred_at: UtcTime
    direction: Literal["in", "out"]
    plate: Plate
    country_code: Country
    review_state: ReviewState
    reason: str = Field(min_length=3, max_length=1000)
    source_checked: Literal[True]

    @model_validator(mode="after")
    def valid_resolution(self) -> Self:
        if self.review_state == "confirmed" and (self.plate is None or self.country_code is None):
            raise ValueError("Confirming a record requires a readable plate and jurisdiction")
        return self


class ReviewAudit(Model):
    changed_at: UtcTime
    reason: str
    before: PlateEvent
    after: PlateEvent


class EventDetail(Model):
    kind: Literal["event"] = "event"
    site: SiteInfo
    original: PlateEvent
    current: PlateEvent
    current_hash: Digest
    source_label: str
    audit: list[ReviewAudit]


class ExampleRequest(Model):
    site_id: SiteId = "example"

    @model_validator(mode="after")
    def reserved_example_name(self) -> Self:
        if self.site_id != "example" and not self.site_id.startswith("example-"):
            raise ValueError("Synthetic example site IDs must be example or start with example-")
        return self


class BillingPolicy(Model):
    currency: Literal["RON", "EUR", "USD"]
    price_minor: int = Field(ge=0, le=1_000_000_000)
    interval_minutes: int = Field(ge=1, le=10_080)
    free_minutes: int = Field(ge=0, le=1_000_000)


class ManualQuoteRequest(Model):
    entered_at: UtcTime
    exited_at: UtcTime
    policy: BillingPolicy

    @model_validator(mode="after")
    def valid_duration(self) -> Self:
        if self.exited_at < self.entered_at:
            raise ValueError("Exit must not precede entry")
        return self


class VisitLookup(Model):
    site_id: SiteId
    visit_id: str = Field(pattern=r"^[0-9a-f]{24}$")


class VisitDetail(Model):
    kind: Literal["visit"] = "visit"
    site: SiteInfo
    visit: VisitRow


class VisitQuoteRequest(VisitLookup):
    policy: BillingPolicy


class BillingQuote(Model):
    kind: Literal["quote"] = "quote"
    basis: Literal["manual_preview", "completed_visit"]
    source_kind: SourceKind | None
    visit_id: str | None
    entered_at: UtcTime
    exited_at: UtcTime
    duration_seconds: int = Field(ge=0)
    billable_seconds: int = Field(ge=0)
    charged_intervals: int = Field(ge=0)
    policy: BillingPolicy
    total_minor: int = Field(ge=0, le=SAFE_INTEGER)
    is_invoice: Literal[False] = False


class CapacityRequest(Model):
    mapped_spaces: int = Field(ge=0, le=1_000_000)
    occupied_spaces: int = Field(ge=0, le=1_000_000)
    unknown_spaces: int = Field(ge=0, le=1_000_000)

    @model_validator(mode="after")
    def consistent_inventory(self) -> Self:
        if self.occupied_spaces + self.unknown_spaces > self.mapped_spaces:
            raise ValueError("Occupied plus unknown spaces cannot exceed the mapped inventory")
        return self


class CapacityResult(Model):
    kind: Literal["capacity"] = "capacity"
    basis: Literal["operator_inputs"] = "operator_inputs"
    mapped_spaces: int = Field(ge=0)
    occupied_spaces: int = Field(ge=0)
    unknown_spaces: int = Field(ge=0)
    available_mapped_spaces: int = Field(ge=0)
    whole_site_capacity: None = None


OperationsResponse = (
    SiteList
    | ImportResult
    | SearchResult
    | EventDetail
    | VisitDetail
    | BillingQuote
    | CapacityResult
)
OPERATIONS_ADAPTER = TypeAdapter(OperationsResponse)

from __future__ import annotations

from parking_analytics.operations_models import (
    SAFE_INTEGER,
    BillingQuote,
    CapacityRequest,
    CapacityResult,
    ManualQuoteRequest,
)


def calculate_fee(request: ManualQuoteRequest) -> BillingQuote:
    duration = request.exited_at - request.entered_at
    microseconds = (
        duration.days * 86_400_000_000 + duration.seconds * 1_000_000 + duration.microseconds
    )
    free = request.policy.free_minutes * 60_000_000
    billable = max(0, microseconds - free)
    interval = request.policy.interval_minutes * 60_000_000
    charged = (billable + interval - 1) // interval
    total = charged * request.policy.price_minor
    if total > SAFE_INTEGER:
        raise ValueError("Calculated amount exceeds the supported exact-money range")
    return BillingQuote(
        basis="manual_preview",
        source_kind=None,
        visit_id=None,
        entered_at=request.entered_at,
        exited_at=request.exited_at,
        duration_seconds=microseconds // 1_000_000,
        billable_seconds=(billable + 999_999) // 1_000_000,
        charged_intervals=charged,
        policy=request.policy,
        total_minor=total,
    )


def calculate_capacity(request: CapacityRequest) -> CapacityResult:
    return CapacityResult(
        mapped_spaces=request.mapped_spaces,
        occupied_spaces=request.occupied_spaces,
        unknown_spaces=request.unknown_spaces,
        available_mapped_spaces=(
            request.mapped_spaces - request.occupied_spaces - request.unknown_spaces
        ),
    )

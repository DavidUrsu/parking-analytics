from __future__ import annotations

from bisect import bisect_right

import numpy as np
from scipy.optimize import linear_sum_assignment

from parking_analytics.models import (
    Analysis,
    Bundle,
    CountMetrics,
    Evaluation,
    Event,
    EventMetrics,
    MethodMetrics,
    Observation,
    Reference,
    ReferenceClip,
    ReferenceEvent,
    ReviewMoment,
)


def observation_at(analysis: Analysis, time_s: float, stale_after_s: float) -> Observation | None:
    index = bisect_right([sample.time_s for sample in analysis.samples], time_s) - 1
    if index < 0:
        return None
    sample = analysis.samples[index]
    return sample if time_s - sample.time_s <= stale_after_s else None


def count_metrics(
    analysis: Analysis, reference: ReferenceClip, stale_after_s: float
) -> CountMetrics:
    errors = []
    unknown_reference = abstentions = matches = total = 0
    for snapshot in reference.snapshots:
        sample = observation_at(analysis, snapshot.time_s, stale_after_s)
        counts = {zone.zone_id: zone.vehicle_count for zone in sample.zones} if sample else {}
        for zone_id, expected in snapshot.zone_counts.items():
            if expected is None:
                unknown_reference += 1
                continue
            total += 1
            predicted = counts.get(zone_id)
            if predicted is None:
                abstentions += 1
            else:
                errors.append(predicted - expected)
                matches += predicted == expected
    return CountMetrics(
        reference_samples=total,
        comparable_samples=len(errors),
        unknown_reference_samples=unknown_reference,
        abstentions=abstentions,
        exact_matches=matches,
        coverage=len(errors) / total if total else None,
        mean_absolute_error=sum(abs(error) for error in errors) / len(errors) if errors else None,
        signed_bias=sum(errors) / len(errors) if errors else None,
        exact_match_rate=matches / total if total else None,
    )


def event_metrics(
    predicted: list[Event],
    reference: list[ReferenceEvent],
    tolerance_s: float,
    complete: bool,
) -> EventMetrics:
    matched = 0
    if complete:
        groups = {(event.gate_id, event.direction) for event in [*predicted, *reference]}
        for gate_id, direction in groups:
            first = [
                event.time_s
                for event in predicted
                if event.gate_id == gate_id and event.direction == direction
            ]
            second = [
                event.time_s
                for event in reference
                if event.gate_id == gate_id and event.direction == direction
            ]
            if first and second:
                differences = np.abs(np.subtract.outer(first, second))
                costs = np.where(differences <= tolerance_s, differences / (tolerance_s + 1), 1e9)
                rows, cols = linear_sum_assignment(costs)
                matched += sum(
                    differences[row, col] <= tolerance_s
                    for row, col in zip(rows, cols, strict=True)
                )
    return event_score(len(predicted), len(reference), int(matched), complete)


def event_score(predicted: int, reference: int, matched: int, complete: bool) -> EventMetrics:
    denominator = predicted + reference
    return EventMetrics(
        predicted_events=predicted,
        reference_events=reference,
        scoreable=complete,
        true_positive=matched if complete else None,
        false_positive=predicted - matched if complete else None,
        false_negative=reference - matched if complete else None,
        precision=matched / predicted if complete and predicted else None,
        recall=matched / reference if complete and reference else None,
        f1=2 * matched / denominator if complete and denominator else None,
        signed_count_error=predicted - reference if complete else None,
    )


def method_metrics(
    analysis: Analysis,
    reference: ReferenceClip,
    tolerance_s: float,
    stale_after_s: float,
    complete: bool,
    gate_ids: list[str],
) -> MethodMetrics:
    groups = {}
    for gate_id in gate_ids:
        for direction in ("in", "out"):
            predicted = [
                event
                for event in analysis.events
                if event.gate_id == gate_id and event.direction == direction
            ]
            expected = [
                event
                for event in reference.events
                if event.gate_id == gate_id and event.direction == direction
            ]
            groups[f"{gate_id}/{direction}"] = event_metrics(
                predicted, expected, tolerance_s, complete
            )
    return MethodMetrics(
        occupancy=count_metrics(analysis, reference, stale_after_s),
        events=event_metrics(analysis.events, reference.events, tolerance_s, complete),
        event_groups=groups,
    )


def combine_methods(methods: list[MethodMetrics]) -> MethodMetrics:
    counts = [method.occupancy for method in methods]
    total = sum(metric.reference_samples for metric in counts)
    comparable = sum(metric.comparable_samples for metric in counts)
    matches = sum(metric.exact_matches for metric in counts)
    occupancy = CountMetrics(
        reference_samples=total,
        comparable_samples=comparable,
        unknown_reference_samples=sum(metric.unknown_reference_samples for metric in counts),
        abstentions=sum(metric.abstentions for metric in counts),
        exact_matches=matches,
        coverage=comparable / total if total else None,
        mean_absolute_error=sum(
            (metric.mean_absolute_error or 0) * metric.comparable_samples for metric in counts
        )
        / comparable
        if comparable
        else None,
        signed_bias=sum((metric.signed_bias or 0) * metric.comparable_samples for metric in counts)
        / comparable
        if comparable
        else None,
        exact_match_rate=matches / total if total else None,
    )

    def combine_events(values: list[EventMetrics]) -> EventMetrics:
        return event_score(
            sum(value.predicted_events for value in values),
            sum(value.reference_events for value in values),
            sum(value.true_positive or 0 for value in values),
            all(value.scoreable for value in values),
        )

    return MethodMetrics(
        occupancy=occupancy,
        events=combine_events([method.events for method in methods]),
        event_groups={
            group: combine_events([method.event_groups[group] for method in methods])
            for group in methods[0].event_groups
        },
    )


def evaluate(bundle: Bundle, reference: Reference) -> Bundle:
    prepared = bundle.model_copy(update={"reference": reference, "evaluation": None})
    prepared = Bundle.model_validate_json(prepared.model_dump_json())
    references = {clip.clip_id: clip for clip in reference.clips}
    if set(references) != {clip.id for clip in bundle.clips}:
        raise ValueError(
            "Reference must describe every clip; missing labels cannot silently disappear"
        )
    by_clip = {}
    clips = []
    for clip in bundle.clips:
        ref = references[clip.id]
        by_clip[clip.id] = {
            method: method_metrics(
                getattr(clip, method),
                ref,
                bundle.protocol.event_tolerance_s,
                bundle.stale_after_s,
                reference.events_complete,
                [gate.id for gate in bundle.site.gates],
            )
            for method in ("baseline", "candidate")
        }
        moments = [moment for moment in clip.review_moments if moment.kind == "low_confidence"]
        for method in ("baseline", "candidate"):
            for snapshot in ref.snapshots:
                sample = observation_at(
                    getattr(clip, method), snapshot.time_s, bundle.stale_after_s
                )
                counts = (
                    {zone.zone_id: zone.vehicle_count for zone in sample.zones} if sample else {}
                )
                for zone_id, expected in snapshot.zone_counts.items():
                    observed = counts.get(zone_id)
                    if expected is not None and observed != expected:
                        moments.append(
                            ReviewMoment(
                                time_s=snapshot.time_s,
                                kind="confirmed_error"
                                if reference.review_status == "reviewed"
                                else "reference_disagreement",
                                method=method,
                                details=f"{zone_id}: reference {expected}, observed {observed}",
                            )
                        )
        clips.append(
            clip.model_copy(
                update={"review_moments": sorted(moments, key=lambda moment: moment.time_s)}
            )
        )
    by_split = {}
    for split in ("development", "held_out"):
        ids = [clip.id for clip in bundle.clips if clip.split == split]
        if ids:
            by_split[split] = {
                method: combine_methods([by_clip[clip_id][method] for clip_id in ids])
                for method in ("baseline", "candidate")
            }
    report = Evaluation(
        reference_status=reference.review_status,
        reference_sha256=reference.digest(),
        events_complete=reference.events_complete,
        event_tolerance_s=bundle.protocol.event_tolerance_s,
        by_clip=by_clip,
        by_split=by_split,
        limitations=[
            "Zone vehicle counts include moving vehicles; capacity and free spaces are unknown.",
            "Same-camera, partly staged footage; small samples do not establish generalization.",
            "Count MAE uses comparable samples; coverage and abstentions are reported separately.",
            "Per-bay classification, detection AP, identity, dwell and queues are not measured.",
        ]
        + (
            ["Reference is provisional, not human-verified."]
            if reference.review_status == "provisional"
            else []
        )
        + (
            ["Crossing labels are incomplete drafts; event precision/recall/F1 are not scored."]
            if not reference.events_complete
            else []
        ),
    )
    result = prepared.model_copy(update={"clips": clips, "evaluation": report})
    return Bundle.model_validate_json(result.model_dump_json())

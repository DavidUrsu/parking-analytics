import pytest

from parking_analytics.evaluation import (
    combine_methods,
    count_metrics,
    evaluate,
    event_metrics,
    method_metrics,
    observation_at,
)
from parking_analytics.models import (
    Analysis,
    Event,
    Observation,
    ReferenceClip,
    ReferenceEvent,
    ReferenceSnapshot,
    ZoneCount,
)


def observation(t, count):
    return Observation(
        time_s=float(t),
        vehicles=[],
        zones=[
            ZoneCount(
                zone_id="zone",
                vehicle_count=count,
                state="observed" if count is not None else "unknown",
                reason="detections" if count is not None else "no_observation",
            )
        ],
    )


def event(t, *, gate="gate", direction="in"):
    return Event(time_s=float(t), gate_id=gate, direction=direction, track_id=1)


def reference_event(t, *, gate="gate", direction="in"):
    return ReferenceEvent(time_s=float(t), gate_id=gate, direction=direction)


def test_abstentions_and_unknown_reference_are_not_hidden():
    analysis = Analysis(
        samples=[observation(0, 1), observation(1, None), observation(2, 4)], events=[]
    )
    reference = ReferenceClip(
        clip_id="fixture",
        snapshots=[
            ReferenceSnapshot(time_s=float(t), zone_counts={"zone": count})
            for t, count in [(0, 1), (1, 2), (2, 2), (3, None)]
        ],
        events=[],
    )
    metric = count_metrics(analysis, reference, 0.6)
    assert metric.reference_samples == 3
    assert metric.comparable_samples == 2
    assert metric.abstentions == 1
    assert metric.unknown_reference_samples == 1
    assert metric.mean_absolute_error == 1
    assert metric.coverage == pytest.approx(2 / 3)
    assert metric.exact_match_rate == pytest.approx(1 / 3)


def test_no_future_or_stale_observations():
    analysis = Analysis(samples=[observation(0, 1), observation(1, 2)], events=[])
    assert observation_at(analysis, -0.1, 0.6) is None
    assert observation_at(analysis, 0.5, 0.6).zones[0].vehicle_count == 1
    assert observation_at(analysis, 0.7, 0.6) is None
    assert observation_at(analysis, 1.0, 0.6).zones[0].vehicle_count == 2


def test_event_matching_maximizes_one_to_one_matches():
    metric = event_metrics(
        [event(0), event(0.9)], [reference_event(0.8), reference_event(1.7)], 1.0, True
    )
    assert metric.true_positive == 2
    assert metric.f1 == 1
    duplicate = event_metrics([event(1), event(1.1)], [reference_event(1.05)], 1.0, True)
    assert duplicate.true_positive == 1
    assert duplicate.false_positive == 1
    assert duplicate.precision == 0.5
    wrong = event_metrics([event(1, direction="out")], [reference_event(1)], 1.0, True)
    assert wrong.true_positive == 0 and wrong.f1 == 0


def test_empty_and_incomplete_events_do_not_get_perfect_scores():
    empty = event_metrics([], [], 1.0, True)
    assert empty.precision is None and empty.recall is None and empty.f1 is None
    missing = event_metrics([], [reference_event(1)], 1.0, True)
    assert missing.precision is None and missing.recall == 0 and missing.f1 == 0
    draft = event_metrics([event(1)], [], 1.0, False)
    assert draft.predicted_events == 1
    assert not draft.scoreable and draft.false_positive is None and draft.f1 is None


def test_split_aggregation_does_not_match_events_across_clips():
    reference = ReferenceClip(clip_id="fixture", snapshots=[], events=[])
    first = method_metrics(
        Analysis(samples=[observation(0, 0)], events=[event(1)]),
        reference,
        1.0,
        0.6,
        True,
        ["gate"],
    )
    second = method_metrics(
        Analysis(samples=[observation(0, 0)], events=[]),
        reference.model_copy(update={"events": [reference_event(1)]}),
        1.0,
        0.6,
        True,
        ["gate"],
    )
    aggregate = combine_methods([first, second])
    assert aggregate.events.true_positive == 0
    assert aggregate.events.false_positive == aggregate.events.false_negative == 1


def test_generated_smoke_is_not_human_verified_evidence(smoke):
    bundle, _ = smoke
    assert bundle.synthetic
    assert bundle.evaluation.reference_status == "provisional"
    assert bundle.evaluation.by_split["held_out"]["candidate"].occupancy.mean_absolute_error == 0
    assert bundle.evaluation.by_split["held_out"]["candidate"].events.f1 == 1
    incomplete = bundle.reference.model_copy(update={"events_complete": False})
    result = evaluate(bundle, incomplete)
    assert result.evaluation.by_split["held_out"]["candidate"].events.f1 is None


def test_wrong_configuration_and_missing_clip_labels_are_rejected(smoke):
    bundle, _ = smoke
    wrong = bundle.reference.model_copy(update={"config_sha256": "0" * 64})
    with pytest.raises(ValueError, match="different configuration"):
        evaluate(bundle, wrong)

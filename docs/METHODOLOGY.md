# Measurement protocol: G328 zone v2

This protocol was defined from footage inspection before running the detector.
It is a small same-camera engineering experiment, not evidence of generalization.

## What is measured

Zone occupancy means **observed vehicle count** in the outlined foreground
parking area, including vehicles in motion. A vehicle belongs to the zone when
the bottom-centre of its visible bounding box is inside its polygon. A boundary
point is included; uncertainty around borders is reviewable.

There are no reliable marked-bay or legal-capacity annotations. Capacity, free
spaces and percentage-full are always unknown. Do not convert visible gaps,
missing detections or entry/exit totals into available spaces.

Three finite observation boundaries cover the upper, right-access and left
edges. These are virtual boundaries of the monitored area, **not the site's
physical entrances**. An entry crosses toward the zone and an exit crosses away.
Track births, disappearances and crossings of an extended infinite line are
not events. Observations across a gap exceeding one second do not establish
continuity. A normalized 0.008 hysteresis band suppresses boundary jitter; a
genuine exit/re-entry can count again.

IDs are scoped to a single clip. Only car, motorcycle, bus and truck classes
are included. There is no person/plate recognition or cross-camera association.

## Footage and splits

`configs\meva-g328.json` records original URLs, exact SHA-256 hashes, crop and
time ranges. Camera G328 remains fixed. Development uses source seconds 60-120
on March 7; held-out segments use seconds 150-240 and 180-285 in two different,
non-overlapping March 13 recordings.

The fixed crop removes much of the sky and unmonitored background, not difficult
moments. Exported media is a resized crop; timestamps are relative to the start
of each selected segment. Preserve the original source offset and crop transform.

Process at five observations per second using decoded media timestamps.
Analysis is offline, not real-time. The viewer can hold the last observation
for at most 0.6 seconds; older/missing observations are unknown.

### Explicit MEVA r13 timing normalization

The selected H.264-in-AVI files expose non-monotonic raw PTS in this decoder,
including different pictures with decreasing timestamps. Standard FFmpeg
`+genpts` and `+genpts+igndts` did not resolve this. Rejecting those timestamps
stopped the first export before inference; they are not silently discarded.

MEVA's own [r13 reassembly script](https://mevadata.org/resources/transcode-meva-r13.pl)
explicitly encodes the ordered image sequence at `-r 30`. For this verified
release only, `source_clock = meva_r13_cfr` decodes from the beginning and uses
display-frame ordinal / 30. It checks the declared 30 fps, preserves every
selected decoded picture, and records the source start frame and the number
of irregular raw PTS. This is a declared source normalization, not an inferred
wall-clock capture time. Other inputs still require monotonic media PTS.

The exported MP4 has a proper monotonic presentation clock. Both analysis and
browser playback use that clock. Source frame mapping is
`source_start_frame + round(media_seconds * 30)`. The original source offset,
normalization and crop remain in the replay contract.

## Comparison

The baseline and candidate share the same RT-DETR-R18 detections, confidence
threshold, crop and observation times. The baseline uses per-frame zone counts,
consecutive-frame IoU assignment and a raw finite crossing rule. The candidate
uses ByteTrack confirmation/persistence and crossing hysteresis.

This evaluates temporal processing, not detector superiority. Frozen defaults
are in the config. No tuning against held-out segments, model sweep or training
is part of this release. Baseline wins and failures are legitimate outcomes.

Protocol v2 corrects a software integration error found by inspecting the
development segment's actual boxes: RT-DETR's multi-label/query postprocessing
can emit several almost-identical car/truck boxes for one physical vehicle.
Counting those class predictions as distinct vehicles inflated counts and
prevented track confirmation. A shared, class-agnostic `torchvision.ops.nms`
step at fixed IoU 0.7 now keeps the highest-score vehicle box. Both methods
receive the same deduplicated input. No detector weights, confidence threshold,
geometry, test labels or splits were selected to improve the held-out score.

The first diagnostic run is retained locally under `outputs\g328-normalized`;
its duplicate-inflated counts and very low candidate coverage are not hidden
or advertised as usable accuracy. The corrected run is a software-fix rerun,
not an independent model-selection benchmark. Overlapping real vehicles can
also be affected by suppression; inspect occlusions rather than assuming NMS
always makes counts correct.

The diagnostic run also incorrectly conflated track-ID confirmation with zone
visibility. In this zone-count mode, an observed box with a tentative ID is still
an observed vehicle. V2 reports its count and a separate `unconfirmed_count`;
missing/stale observations remain unknown. Both methods therefore have the same
framewise occupancy counts by design. No occupancy-quality improvement from
tracking is claimed; the temporal comparison concerns identity continuity and
crossing events. This does not establish parking-bay availability.

## Reference and metrics

Prepare zone-count snapshots every five seconds and annotate every crossing
in the selected intervals. Published MEVA activity labels are not assumed to
exhaustively annotate parked cars. Independently prepared visual labels are
explicitly provisional until a human checks them.

The viewer exposes the reference snapshots, event times and corrections.
Review status belongs to the exact reference content/hash. A corrected,
reviewed JSON can be exported locally and passed back to the evaluator; no
annotation backend or general-purpose labeling suite is required.

Report count MAE on comparable known samples, exact-match rate over all known
reference samples (abstentions are not correct), known-sample coverage, signed
count bias, and per-gate/direction event precision/recall/F1 and count error.
Match events one-to-one, same gate and direction, within one second.

Undefined metrics are null, with their denominators reported. Per-bay
classification F1, detection AP and identity accuracy are **not measured**:
the selected reference does not support those claims. Show development and
held-out results separately; do not blend them into a headline score.

Unreviewed labels, very small event totals, staged scenarios, the same camera,
perspective, occlusion, detector misses and track fragmentation limit the
evidence. Results must remain provisional until reference review. No accuracy
threshold or production-readiness claim has been promised.

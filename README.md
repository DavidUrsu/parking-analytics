# Parking operator app

One local application with four working modes:

| Mode | Current capability |
|------|--------------------|
| Monitoring | Private plate-event imports; exact plate history; entry/exit, overlapping-period, unclosed and review queries; auditable corrections |
| Billing | Explicit-tariff fee previews for completed unambiguous visits or manually supplied times; integer minor-unit arithmetic |
| Capacity | Mapped-space arithmetic from explicit operator inputs, preserving unknown spaces; separate real camera vehicle-count context |
| Analyze & review | Private video import, recording-time confirmation, visual zones/boundaries, saved camera presets, real cancellable processing, synchronized replay and private JSON/CSV exports; existing MEVA Evidence replay remains available |

**No automatic plate recognition is connected yet.** Monitoring ingests
authorized event logs, not licence plates inferred from the existing clip IDs.
The default database is empty. Synthetic examples are opt-in and prominently
labelled, never substituted for missing real observations.

Monitoring and custom-video analysis use a loopback-only FastAPI service and
private SQLite/media storage; existing Evidence alone still works as a static
replay. There are no accounts, payments,
physical barrier control, public deployment or website changes.

## Start the operational app

From the repository root, keep caches on the project drive as shown in the
setup section below. Monitoring, calculators and existing replay do not require
model downloads. New video processing additionally needs the inference extra
and cached pinned weights:

```powershell
uv sync --extra app
Set-Location viewer
npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'
npm.cmd run build
Set-Location ..
uv run --no-sync parking serve
```

Open `http://127.0.0.1:8000`. The server serves the built frontend and API from
one origin. The development preview uses `npm.cmd run dev` in `viewer`, with
the API still running on port 8000; its `/api` proxy is loopback-only.

If retaining the existing inference environment, use
`uv sync --extra app --extra inference` instead of the app-only setup, which
removes optional model packages. `parking serve` loads no model while idle;
submitted or previously queued video jobs run in a separate bounded process.

Monitoring starts with a source selector and no invented records. Use the
explicit synthetic-example button to exercise the query/review workflow, or
import the supplied clearly artificial historical log:

```powershell
uv run --no-sync parking monitor-import --input examples\plate-events.synthetic.json
```

Real logs must remain under ignored private storage, not the served viewer.
The default is `data\monitoring.sqlite3`; unrelated SQLite databases and paths
inside `viewer` are rejected. Authorization, event format, query semantics,
review behavior, fee rules and limitations are in
[the operator guide](docs/OPERATIONS.md).

This is a local single-operator prototype, **not an authenticated deployment**.
No automatic retention policy is enabled. Set a lawful retention policy and
deployment access controls before operational/public deployment.

## Analyze your own recording

Open **Analyze & review** at `http://127.0.0.1:8000/?mode=analysis`.
This checkout already has the pinned model. On a fresh checkout, use the
inference setup and verified fetch commands below before queuing work.

1. Drop a video or use the file picker. Confirm permission and identify
   camera footage versus synthetic/test input. Files remain private; no
   upload is copied into `viewer\public` or sent to an external service.
2. Inspect the first frame and recording-time metadata. Creation/export
   dates are only candidates, never automatically accepted as capture time.
   Use a checked candidate or enter the first-frame ISO-8601 time with an
   explicit timezone, for example `2026-10-22T18:00:00+03:00`.
3. Confirm that the recording advances at real time (1x), without time-lapse,
   speed changes or removed-time gaps. Event UTC is the confirmed first-frame
   time plus actual media seconds. Upload time and file modification time are
   never substituted. **Burned-in/on-screen timestamp OCR is not implemented**;
   read the preview and enter its first-frame time manually where necessary.
4. Define at least one visible-zone polygon and one finite crossing boundary.
   Finish each shape; the arrow shows the entering side and can be flipped.
   Keyboard users can edit normalized `[x, y]` coordinates in geometry JSON.
   Save/reuse a camera preset only for the same fixed view; matching image
   dimensions do not establish that. Check the fixed-camera confirmation.
5. Select local CPU or CUDA explicitly and queue analysis. The fixed
   RT-DETR/ByteTrack path runs with real phase/frame progress, cancellation
   and visible failures. Missing weights, invalid timing and unsupported
   inputs never generate fallback detections.
6. Open the finished replay, use slow review playback or step between analyzed
   frames, inspect crossing timestamps and filter review markers. Review
   playback speed never changes recording UTC. Download private event CSV or
   JSON containing the frozen recording clock, input metadata and results.

Limits: one running job, five outstanding jobs, 30 minutes per running job;
512 MiB, ten minutes and 2,073,600 pixels/frame (1080p area) per upload, with
nominal frame-rate metadata at most 120 fps. MP4/MOV, AVI and MKV/WebM containers
are accepted only when locally decodable with usable timing. Prepared replay
is H.264, longest edge at most 1280 pixels, with audio omitted. There are at
most eight zones/eight boundaries and 24 vertices per zone.

Custom results are **unverified model observations**, not measured accuracy,
ANPR, free-bay availability or billable visits. Their clip IDs are not plate
identities and are never inserted into Monitoring. Only completed successful
jobs expose results. The UI lists the latest 100 jobs; cancellation preserves
the original input, while Delete recording removes its finished/failed/
cancelled results after all related jobs have stopped. No retention policy
is applied automatically. See [the operator guide](docs/OPERATIONS.md).

## Camera-evidence scope

The independent Python CLI runs RT-DETR-R18 and ByteTrack offline. The
English/Romanian Evidence mode shows actual detections, tracks and counts.

Occupancy in the current MEVA footage means vehicles in an outlined area,
including moving vehicles, not occupied marked bays. Capacity, available spaces
and whole-site occupancy are unknown. Boundaries describe the monitored area,
not the site's physical entrances. IDs are local to a clip, not identities.

**Evidence status:** the pipeline and replay work on three MEVA KF1 G328
segments. Reference labels are AI-prepared drafts, not human-verified ground
truth. Count comparisons are provisional; crossing precision/recall/F1 remain
unscored until annotation completeness is confirmed. This is not a validated
parking-management product.

## Run the existing local replay

From this checkout, after viewer dependencies are installed:

```powershell
Set-Location viewer
npm.cmd run dev
```

Open the loopback URL printed by Vite (normally `http://127.0.0.1:5173`) and
select Evidence, or open `http://127.0.0.1:5173/?mode=evidence`.
`viewer\public\demo` contains the locally generated real replay on the original
development machine. Media, weights, environments and outputs are deliberately
not committed, so a fresh checkout must prepare them as below. Missing real
data is an error: the viewer never substitutes synthetic results automatically.

## Set up and reproduce

Requirements: `uv`, Node.js compatible with Vite 7 (Node 24 was used), and
Python 3.12 managed locally by uv. The real inference extra pins the Windows
PyTorch CUDA 12.6 wheels. CUDA is optional at execution: select `--device cpu`
explicitly when needed; the pipeline never silently changes devices.

Use a drive with space for the environment, caches and source clips. These
PowerShell settings are local to the current shell, not global configuration.
Run from the repository root:

```powershell
$env:UV_CACHE_DIR = Join-Path $PWD '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PWD '.cache\python'
$env:UV_MANAGED_PYTHON = '1'
$env:HF_HOME = Join-Path $PWD 'models\hub'
$env:MPLCONFIGDIR = Join-Path $PWD '.cache\matplotlib'
New-Item -ItemType Directory -Force '.cache\tmp' | Out-Null
$env:TEMP = Join-Path $PWD '.cache\tmp'
$env:TMP = $env:TEMP
uv sync --extra app --extra inference
```

Download/reuse the three checksum-verified source files and the pinned model:

```powershell
uv run --no-sync parking fetch
```

`configs\meva-g328.json` fixes the exact source hashes, camera, crop, splits,
boundaries, model revision and processing rules. Downloads are individual
objects, never a bucket sync. The fetch ledger reserves 4 GiB conservatively
for setup/dependencies and initial scouting; it limits further media/model
downloads within the approved 5 GiB total. The reserve is not a byte-accurate
network meter. Keep external dependency installs within it and do not reset
the ledger to bypass the budget.

The following are the commands used for the corrected real run. Choose a new
output name if one already exists; processing/export deliberately refuse to
overwrite existing work:

```powershell
uv run --no-sync parking process --output outputs\g328-v2 --device cuda
uv run --no-sync parking evaluate --bundle outputs\g328-v2\bundle.json --reference reference\meva-g328.json --output outputs\g328-v2\evaluated.json
uv run --no-sync parking validate --bundle outputs\g328-v2\evaluated.json
uv run --no-sync parking export --bundle outputs\g328-v2\evaluated.json --output viewer\public\demo
Set-Location viewer
npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'
npm.cmd run dev
```

Use `--no-sync` after choosing the inference environment: a base `uv sync`
without the extra would remove optional inference packages.

Processing has a 1,800-second deadline checked during decode/inference. There
is no training, model sweep, cloud compute or paid service. The initial model
is deliberately one pinned candidate, not a generic model registry.

## What was actually run

The corrected local run processed 255 seconds across three disjoint segments
into 1,275 observations at 5 Hz. The recorded pipeline timer was 318.55 seconds
on an RTX 3060 plus CPU video preparation: model loading, source verification,
transcoding and inference, before final JSON writing/evaluation. This is
**not** a model-only latency benchmark or a real-time claim.

Artifacts on this checkout:

| Path | Contents |
|------|----------|
| `outputs\g328-v2\bundle.json` | Actual baseline/candidate observations and events, media hashes and run provenance |
| `outputs\g328-v2\evaluated.json` | Same replay with provisional comparisons and reference disagreements |
| `viewer\public\demo\bundle.json` | Static replay copy loaded by the viewer |
| `reference\meva-g328.json` | 51 draft snapshots, including three unknown counts, and nine approximate crossing drafts |
| `outputs\g328-normalized` | Retained diagnostic run before duplicate-vehicle/confirmation semantics were corrected |

The held-out count comparison uses 37 known draft snapshots and reports two
unknown reference snapshots separately. Both methods use the same deduplicated
detections, so their zone counts match by design. Tracking is compared through
crossing events, not an invented occupancy improvement. Event accuracy is not
scored because crossing labels are incomplete. Exact commands, versions,
model/input/reference hashes, hardware and limitations are in the replay.
The first run had no committed Git revision; that absence is recorded, not
replaced with an invented revision.

Two real integration failures were addressed, not hidden: MEVA r13 AVI PTS
needed explicit release-specific normalization, and multiple car/truck/query
boxes needed vehicle-level deduplication. See [the protocol](docs/METHODOLOGY.md).
No confidence threshold, model weights, held-out labels or geometry were
optimized against the held-out results.

## Review the reference before making accuracy claims

Inspect all three segments, including difficult moments. Reference comparison
appears only at labelled timestamps. Correct the counts and crossing drafts;
the notes deliberately identify ambiguous observations and approximate times.
Check every finite boundary over the entire selected footage, not just the
listed draft events.

In the reference panel, confirm completeness and your personal review only
after doing that work. Download the JSON and save it, for example, as
`reference\reviewed-g328.json`. Edits/downloads do not rewrite server files,
change displayed metrics or automatically mark the original labels reviewed.
Re-evaluate without rerunning the detector:

```powershell
uv run --no-sync parking evaluate --bundle outputs\g328-v2\bundle.json --reference reference\reviewed-g328.json --require-reviewed --output outputs\g328-v2\reviewed.json
uv run --no-sync parking export --bundle outputs\g328-v2\reviewed.json --output viewer\public\reviewed
```

Open `http://127.0.0.1:5173/?bundle=/reviewed/bundle.json`. The
`--require-reviewed` flag fails explicitly on provisional labels. A human
review flag is an annotation assertion, not cryptographic proof of review.
Do not include plate strings, identities or private information in annotations.

## Tiny CPU-only example and checks

No model, GPU, private data or paid API is needed for the synthetic smoke path:

```powershell
uv sync
uv run --no-sync parking smoke --output outputs\synthetic-smoke
uv run --no-sync parking validate --bundle outputs\synthetic-smoke\bundle.json
```

It draws scripted rectangles and is visibly labelled **synthetic test only**.
It is not a fallback dataset or evidence of model quality.

Run checks from the repository root. The browser tests use installed Microsoft
Edge and start/stop their own loopback preview server:

```powershell
uv run --no-sync pytest -q
uv run --no-sync ruff check src tests
uv run --no-sync parking smoke --output viewer\public\test-fixture --replace-synthetic
Set-Location viewer
npm.cmd run build
npm.cmd test
```

The real replay browser check is explicitly skipped if its generated media is
absent; it is not replaced with a synthetic success. Optional tracker tests
are explicitly skipped without inference dependencies. All real/synthetic
checks were run with their required dependencies in the original checkout.

The Python producers own the frontend JSON Schemas. After changing the
corresponding models, regenerate them and rerun both language surfaces:

```powershell
uv run --no-sync parking schema --output viewer\src\bundle.schema.json --overwrite
uv run --no-sync parking schema --kind operations --output viewer\src\operations.schema.json --overwrite
uv run --no-sync parking schema --kind analysis --output viewer\src\analysis.schema.json --overwrite
```

## Rights and limitations

MEVA KF1 is CC BY 4.0 with required attribution and change notices. It includes
actors and staged scenarios. The licence permits commercial copyright reuse;
privacy/publicity clearance for a public presentation is **not complete**.
This project currently serves local inspection only.

The original project code is MIT. Dataset, derived reference, model-weight,
codec and dependency terms remain separate:
[sources and licences](docs/DATA_AND_LICENSES.md).

Out of scope: automatic marked-bay availability, whole-site camera capacity,
dwell/queues, congestion alarms, automatic number-plate recognition, visual
re-identification, accounts, bookings/payments, physical barriers, public
uploads, live cameras, training, website changes and publishing. Local private
recorded-video import is implemented; public upload/deployment is not. The versioned
replay JSON remains the future public website seam; real plate histories must
not be copied into it.

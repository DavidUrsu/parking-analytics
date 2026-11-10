# Setup and reproduction

Windows PowerShell instructions for the local app, offline MEVA replay and
development checks. Run commands from your checkout root unless a block changes
directory. A path such as `D:\work\parking-analytics` is only an example; use your
own checkout and a drive with room for environments, caches and recordings.

The app is a loopback-only, single-operator prototype. It is not authenticated,
has no automatic retention policy and must not be exposed publicly. Read
[operator workflows and privacy boundaries](OPERATIONS.md),
[the measurement protocol](METHODOLOGY.md) and
[data, model and dependency rights](DATA_AND_LICENSES.md) before using real data.

## 1. Prerequisites and local caches

- `uv`, with project-local managed Python 3.12 and this repository's `.venv`.
- Node.js compatible with Vite 7; Node 24 was used for development.
- Installed Microsoft Edge for browser tests; no Playwright browser download
  is needed for the documented checks.
- For real analysis: the inference extra, pinned cached model and authorized
  footage. CUDA is optional at execution, not a prerequisite for the smoke path.

Set these variables in each PowerShell session before setup or processing.
They keep caches on the checkout's drive, not in global configuration:

```powershell
$env:UV_CACHE_DIR = Join-Path $PWD '.cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $PWD '.cache\python'
$env:UV_MANAGED_PYTHON = '1'
$env:HF_HOME = Join-Path $PWD 'models\hub'
$env:MPLCONFIGDIR = Join-Path $PWD '.cache\matplotlib'
New-Item -ItemType Directory -Force '.cache\tmp' | Out-Null
$env:TEMP = Join-Path $PWD '.cache\tmp'
$env:TMP = $env:TEMP
```

Choose **one** environment setup:

| Intended use | Command |
|---|---|
| Operator app, calculators and existing replay | `uv sync --extra app` |
| Full app plus new video analysis | `uv sync --extra app --extra inference` |
| Offline inference CLI without the app | `uv sync --extra inference` |
| Synthetic CPU-only smoke and base Python checks | `uv sync` |

`uv sync` removes unselected optional packages. App-only setup removes inference;
base setup removes both app and inference. To retain all features, select both
extras together. Use `uv run --no-sync` after setup so subsequent commands do not
silently resynchronize to the base environment.

The inference extra pins PyTorch 2.8.0 and torchvision 0.23.0 from the Windows
CUDA 12.6 wheel index, even when execution uses CPU. It also installs Transformers
and Supervision 0.25.1 for the fixed RT-DETR-R18/ByteTrack pipeline. There is no
separate lightweight CPU inference environment documented here.

### Resource boundary

Approved processing uses local CPU or RTX 3060, no training, model sweeps,
paid APIs or cloud services. The limit is **5 GiB cumulative downloads including
dependencies** and **30 minutes per processing run**. Check remaining budget
before installs or fetching; CUDA wheels are large. The fetch ledger reserves
4 GiB conservatively for setup, dependencies and initial scouting, and limits
further media/model downloads within the total. It is not an exact network
traffic meter. Do not reset it to bypass the limit or sync an entire dataset
bucket. Work needing more resources requires a separately approved budget.

## 2. Build and start the local app

After selecting the app environment above:

```powershell
Set-Location viewer
npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'
npm.cmd run build
Set-Location ..
uv run --no-sync parking serve
```

Open `http://127.0.0.1:8000`. FastAPI serves the built Vite/TypeScript frontend
and API from one origin. Entry HTML always revalidates, including mode-specific
URLs; private API responses remain no-store. For an explicit private database
and port:

```powershell
uv run --no-sync parking serve --database data\monitoring.sqlite3 --port 8000
```

These are alternative start commands, not two servers to run together.
The default database starts empty; the app never invents missing observations.
No model loads while idle. Submitted or previously queued analysis jobs run in
a separate bounded process and require cached weights and inference packages.

Optional artificial Monitoring input:

```powershell
uv run --no-sync parking monitor-import --input examples\plate-events.synthetic.json
```

This is a labelled synthetic log, not an ANPR result. For authorized real logs,
keep inputs under ignored private storage such as `data` and follow the import
contract in [OPERATIONS.md](OPERATIONS.md). The default database is
`data\monitoring.sqlite3`; unrelated databases and paths inside `viewer` are
rejected. Private analysis media lives beside that database in its
`<database-stem>-media` directory, never in public assets.

### Optional frontend development preview

Keep the API running on port 8000. In another PowerShell session, from the
repository root:

```powershell
Set-Location viewer
npm.cmd run dev
```

Open Vite's printed loopback URL, normally `http://127.0.0.1:5173`.
Its `/api` proxy targets the local API; `PARKING_API_URL` may select another
loopback HTTP origin only. Static Evidence replay alone can use Vite without
the API. Stop a foreground server with Ctrl+C in its own terminal.

Rebuild with `npm.cmd run build` in `viewer` after frontend changes or generating
new public replay assets when using the built app instead of Vite.

## 3. Prepare real inputs

Fresh clones do **not** contain MEVA footage, model weights, environments,
generated outputs or `viewer\public` replay assets. An existing developer
checkout may already have them; do not assume that another machine does.

### Pinned MEVA reproduction

Select the inference environment first, then download or reuse the verified
inputs within the budget:

```powershell
uv run --no-sync parking fetch
```

`configs\meva-g328.json` fixes the three source objects and SHA-256 hashes,
camera, crop, time ranges, splits, geometry, processing rules and model revision.
Fetch uses individual verified objects, not a bucket sync. The pinned detector
is `PekingU/rtdetr_r18vd` at revision
`ac77a11ff0170a41b771c03264987f8ce2b0d753`; tracking uses ByteTrack.
Job submission never downloads weights or substitutes a model automatically.

The three MEVA KF1 G328 segments are recordings of **one camera at different
historical times**, not simultaneous live cameras. Their readings cannot be
added into a current site total.

### Your own authorized recording

Use the full app/inference environment and prepare the pinned cache before
queuing work at `http://127.0.0.1:8000/?mode=analysis`. Upload only a recording
you may process, confirm its timezone-aware first-frame capture time and
continuous real-time 1x timing, then define the fixed-view zones/boundaries and
select CPU or CUDA explicitly. Metadata is only a candidate, not capture-time
proof; upload time and file modification time are never substitutes.
Burned-in timestamp OCR is not implemented.

Upload limits are 512 MiB, ten minutes, 2,073,600 pixels/frame and at most
120 nominal fps, with locally decodable MP4/MOV, AVI or MKV/WebM and usable
timing. One job runs at a time; at most five jobs are outstanding. Each running
job has a 30-minute deadline. Missing weights, unsupported media and invalid
timing fail visibly, without synthetic detections or a device fallback.

Keep uploads, job outputs and downloaded JSON/CSV private. The static export
command intentionally **refuses private uploaded-video bundles**. Processing
permission is not redistribution permission. See
[OPERATIONS.md](OPERATIONS.md) for recording clocks, geometry, cancellation,
presets, private result export and deletion semantics.

## 4. Process, evaluate and export the MEVA replay

These are the corrected real-run commands. Use **fresh output paths**:
processing and export refuse destructive overwrites. If `outputs\g328-v2` or
`viewer\public\demo` already exists, choose another name and update every
dependent path; do not delete prior work to make the example run.

```powershell
uv run --no-sync parking process --output outputs\g328-v2 --device cuda
uv run --no-sync parking evaluate --bundle outputs\g328-v2\bundle.json --reference reference\meva-g328.json --output outputs\g328-v2\evaluated.json
uv run --no-sync parking validate --bundle outputs\g328-v2\evaluated.json
uv run --no-sync parking export --bundle outputs\g328-v2\evaluated.json --output viewer\public\demo
Set-Location viewer
npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'
npm.cmd run dev
```

For CPU inference, replace `--device cuda` with `--device cpu` in the process
command; do not run both as an implicit retry. There is no silent device
switch. The 1,800-second processing deadline is checked during decode/inference
on either device.

Open `http://127.0.0.1:5173/?mode=evidence`, or use the existing MEVA benchmark
replay link in Analyze & review.
An alternative public export can be selected with a URL such as
`http://127.0.0.1:5173/?bundle=/reviewed/bundle.json`. Missing real replay media
is an error, never a request to substitute synthetic results.

The frozen protocol is `g328-zone-v2`. Source timing normalization for verified
MEVA r13 is explicit and must not be applied to unrelated uploads. Both methods
share deduplicated detections, so matching zone counts are by design, not an
occupancy improvement from tracking. Measurements concern visible vehicles,
including movers, not occupied marked bays or available spaces. See
[METHODOLOGY.md](METHODOLOGY.md) rather than retuning held-out data or geometry.

## 5. Review references and re-evaluate

Committed `reference\meva-g328.json` labels are AI-prepared **provisional
drafts**, not human-verified ground truth. Count comparisons remain provisional;
crossing precision/recall/F1 remain unscored until annotation completeness is
confirmed. A successful replay or synthetic test proves no model accuracy.

1. Inspect all three segments, including ambiguous counts and difficult moments.
   Reference comparisons appear only at labelled timestamps.
2. Correct snapshot counts and approximate crossing drafts. Check every finite
   boundary over the entire selected footage, not just listed draft events.
3. In the reference panel, assert completeness and personal review only after
   doing that work. Download the JSON and save it, for example, as
   `reference\reviewed-g328.json`. Include no plates, identities or private data.
4. Re-evaluate the original observations; rerunning the detector is unnecessary:

```powershell
uv run --no-sync parking evaluate --bundle outputs\g328-v2\bundle.json --reference reference\reviewed-g328.json --require-reviewed --output outputs\g328-v2\reviewed.json
uv run --no-sync parking export --bundle outputs\g328-v2\reviewed.json --output viewer\public\reviewed
```

Open `http://127.0.0.1:5173/?bundle=/reviewed/bundle.json`, or rebuild the
frontend to serve those new assets through port 8000. Downloading/editing a
reference does not rewrite server files, update displayed metrics or mark the
original reference reviewed. `--require-reviewed` explicitly rejects provisional
labels. The review flag is an annotation assertion, not cryptographic proof.

## 6. Synthetic smoke and development checks

### Small CPU-only smoke

No model, GPU, private input or paid API is needed:

```powershell
uv sync
uv run --no-sync parking smoke --output outputs\synthetic-smoke
uv run --no-sync parking validate --bundle outputs\synthetic-smoke\bundle.json
```

Choose a fresh output directory. This draws scripted rectangles and is clearly
labelled **synthetic test only**. It is not model-quality evidence or a fallback
dataset. Remember that this base `uv sync` removes app/inference extras; restore
your chosen environment before returning to those features.

### Python and browser checks

For app checks, select the app extra first; use both extras to include optional
tracker coverage. Install viewer dependencies as in section 2. From the
repository root:

```powershell
uv run --no-sync pytest -q
uv run --no-sync ruff check src tests
uv run --no-sync parking smoke --output viewer\public\test-fixture --replace-synthetic
Set-Location viewer
npm.cmd run build
npm.cmd test
```

The fixture replacement flag is only for the explicit synthetic fixture, not
real output directories. `npm.cmd test` uses the project's cleanup wrapper and
installed Edge; its loopback test servers stop before isolated database/media
cleanup. Do not replace it with a direct Playwright invocation or delete a
database while its test server is running.

Real-replay browser checks explicitly skip when generated real media is absent;
synthetic coverage does not count as a real-replay pass. Optional tracker tests
skip without inference dependencies. Record skips rather than claiming those
paths were tested.

### Regenerate the JSON contracts

Python producers own the frontend schemas. After changing their models, run
from the repository root, then rerun the relevant Python and viewer checks:

```powershell
uv run --no-sync parking schema --output viewer\src\bundle.schema.json --overwrite
uv run --no-sync parking schema --kind operations --output viewer\src\operations.schema.json --overwrite
uv run --no-sync parking schema --kind analysis --output viewer\src\analysis.schema.json --overwrite
```

### Regenerate the README screenshots

Use the app environment, viewer dependencies and installed Edge described above.
From the repository root:

```powershell
Set-Location viewer
npm.cmd run screenshots
```

The repeatable capture uses an isolated test database/browser and original
MIT synthetic fixtures, with no inference. It writes four files under
`docs\screenshots`: `dashboard.png`, `monitoring.png`, `analysis.png` and
`mobile.png`. These are **actual app screenshots showing synthetic UI
demonstrations**, not model/ANPR-quality evidence. Keep that caption when
reusing them. They contain neither MEVA frames nor private runtime records;
do not replace them with real footage or private data without separate clearance.

## 7. Expected artifacts and evidence

| Path | Purpose |
|---|---|
| `.venv`, `.cache`, `models` | Local environment, caches and pinned weights; ignored |
| `data` and `<database-stem>-media` | Private imported logs, SQLite and analysis media; never served as static assets |
| `outputs\g328-v2\bundle.json` | Actual baseline/candidate observations, events, media hashes and run provenance |
| `outputs\g328-v2\evaluated.json` | Replay with provisional reference comparisons and disagreements |
| `outputs\g328-v2\reviewed.json` | Optional re-evaluation using the downloaded reviewed reference |
| `viewer\public\demo` or `viewer\public\reviewed` | Locally generated static benchmark bundle/media; ignored, not supplied by a clone |
| `reference\meva-g328.json` | Committed provisional text reference; derived MEVA rights apply |
| `outputs\g328-normalized` | Historical pre-correction diagnostic run, if present; not the corrected reproduction target |
| `outputs\synthetic-smoke`, `viewer\public\test-fixture` | Explicit synthetic check outputs, not real observations |
| `viewer\dist`, `viewer\node_modules`, test reports | Generated frontend/development artifacts; ignored |
| `docs\screenshots` | Curated dashboard, monitoring, analysis and mobile screenshots of original MIT synthetic UI fixtures; intended for Git, unlike runtime media |

Preserve actual commands, code revision when available, dependency versions,
source/model/reference hashes, config, splits, hardware, runtime and limitations
with results. The replay stores run provenance; do not invent missing revisions,
benchmarks or human review. Keep datasets, recordings, weights, environments,
private databases and generated run outputs out of Git.

Original source code is MIT. MEVA footage and derived reference labels, model
weights, codecs and dependencies have separate terms. Public presentation and
privacy clearance for MEVA and private runtime media are **not established**;
the README screenshots use synthetic fixtures instead. See
[DATA_AND_LICENSES.md](DATA_AND_LICENSES.md). No live-camera, ANPR, public
deployment, authentication or automated retention capability is implied by these
setup instructions.

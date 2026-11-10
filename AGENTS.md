# Project agent instructions

## Project

- Purpose: turn licensed recorded parking video into inspectable operational
  observations for a parking operator.
- Current release: one app with Monitoring (private imported plate events and
  visit queries), Billing (explicit-tariff previews), Capacity (operator-input
  mapped-space arithmetic plus real camera context) and the existing Evidence
  replay within Analyze & review. Private drag/drop custom-video analysis,
  visual camera geometry, saved presets, cancellable processing and confirmed
  recording times are implemented. Overview is now a dashboard camera wall
  with recorded feeds, selectable 1/4/9-view grids and the shared tools sidebar.
- Acceptance: exact plate history and entry/exit/time-range queries, safe
  incomplete/ambiguous visits, auditable corrections, exact-money previews,
  unknown space handling, preserved real replay, and English/Romanian controls.
- Out of scope: automatic ANPR without qualified footage/model evaluation,
  website integration, live cameras, cross-camera visual re-identification or person identity,
  payments, physical barrier control, training, public deployment and publishing.
- Tools: project-local uv/Python 3.12, PyAV, NumPy, Pydantic, SciPy, pytest,
  RT-DETR-R18/Transformers/PyTorch and Supervision ByteTrack; static
  Vite/TypeScript/Ajv viewer with Playwright checks. Monitoring now requires a
  small loopback-only FastAPI service and private SQLite storage. No ORM,
  generic plugin framework, Docker or inference service is needed.

Work only in this repository or its explicitly assigned worktree. Do not edit
sibling projects or the parent workspace. Follow more specific instructions
for the files you change.

## Keep the code simple

- Implement the current requirement, not a framework for future requirements.
- Use clear names, straightforward functions and ordinary data structures.
- Add classes when they represent meaningful state or the library needs them.
- Reuse existing helpers and dependencies; avoid unnecessary new packages.
- Avoid speculative abstractions, plugin systems, configuration layers and
  excessive file splitting.
- Extract repeated behavior only when the shared meaning is clear.
- Keep types accurate and errors explicit. No swallowed exceptions, invented
  results or silent success-shaped fallbacks.
- Comment non-obvious reasoning only. Prefer self-explanatory code.
- Keep changes focused and preserve unrelated work.
- Finish the real execution path; simple does not mean a placeholder demo.

## Commands and environment

Run these from the repository root unless indicated. Full environment/cache
settings and reproduction instructions are in the README.

| Purpose | Command |
|---------|---------|
| Set up operator app | `uv sync --extra app` |
| Set up all features | `uv sync --extra app --extra inference` |
| Build app frontend | In `viewer`: `npm.cmd run build` |
| Start local app/API | `uv run --no-sync parking serve` (loopback port 8000) |
| Import plate-event log | `uv run --no-sync parking monitor-import --input data\your-events.json` (authorized private input) |
| Set up real inference | `uv sync --extra inference` |
| Set up CPU-only smoke | `uv sync` (removes optional inference extras) |
| Fetch verified inputs | `uv run --no-sync parking fetch` |
| Small CPU example | `uv run --no-sync parking smoke --output outputs\synthetic-smoke` (fresh path) |
| Real processing | `uv run --no-sync parking process --output outputs\g328-v2 --device cuda` (fresh path) |
| Evaluate drafts | `uv run --no-sync parking evaluate --bundle outputs\g328-v2\bundle.json --reference reference\meva-g328.json --output outputs\g328-v2\evaluated.json` |
| Validate actual replay | `uv run --no-sync parking validate --bundle outputs\g328-v2\evaluated.json` |
| Python checks | `uv run --no-sync pytest -q`; `uv run --no-sync ruff check src tests` |
| Browser fixture | `uv run --no-sync parking smoke --output viewer\public\test-fixture --replace-synthetic` |
| Viewer setup | In `viewer`: `npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'` |
| Viewer checks | In `viewer`: `npm.cmd run build`; `npm.cmd test` |
| README screenshots | In `viewer`: `npm.cmd run screenshots` (isolated synthetic UI data, no inference) |
| Start viewer | In `viewer`: `npm.cmd run dev` |
| Regenerate contract | `uv run --no-sync parking schema --output viewer\src\bundle.schema.json --overwrite` |
| Regenerate operations contract | `uv run --no-sync parking schema --kind operations --output viewer\src\operations.schema.json --overwrite` |
| Regenerate analysis contract | `uv run --no-sync parking schema --kind analysis --output viewer\src\analysis.schema.json --overwrite` |

Use this repository as the working directory and its own `.venv`. Keep uv,
Python-download, model and npm caches on the project drive under ignored
directories rather than filling the system drive. Shell environment settings
do not persist between tool calls.

Run the smallest checks covering a change. For bugs, cover the failing case.
Update documentation when behavior or commands change.

## Data and experiments

- Read `.github\skills\ml-experiments\SKILL.md` when preparing data, running
  inference, evaluating or making model-quality claims.
- Qualify source rights and camera coverage before the main pipeline work.
- Define geometry, event/occupancy rules, baseline, splits and sampling before
  tuning. Do not optimize against held-out segments.
- Published activity annotations need not cover stationary vehicles.
- Do not promote unreviewed model labels to ground truth. User-reviewed
  reference status and hashes must be preserved.
- Synthetic examples are smoke checks, not model-quality evidence.
- Record actual commands, revisions, versions, source/model/reference hashes,
  configurations, splits, hardware, runtime, metrics and limitations.
- Budget: local CPU/RTX 3060 inference, no training or paid/cloud services;
  at most 5 GiB total downloads including dependencies and 30 minutes per
  processing run. Stop before exceeding these limits.
- An unknown or unseen space is never silently available. Entry counts alone
  do not establish occupancy.
- MEVA Evidence counts observed zone vehicles, including movers; tentative
  IDs are separate from visibility. Camera availability/capacity stay null.
  The separate manual Capacity calculator must identify operator inputs and
  must subtract unknown/unobservable mapped spaces rather than declaring them free.
- Real plate events belong only in ignored private storage, never viewer public
  assets, query-string histories, source fixtures or routine access logs.
  Synthetic examples must be opt-in and clearly identified, never a fallback.
- Imported plate events are not proof of ANPR accuracy or vehicle ownership.
  No OCR is running until an evaluated plate-reading source is connected.
- Custom recordings must stay in ignored private storage and be operator-
  authorized. Process one video at a time with real progress/cancellation,
  the fixed detector and the existing 30-minute run limit; no new model downloads.
- Recording-time metadata is only a candidate, not proof of capture time.
  Require confirmation of a timezone-aware recording start and the 1x real-
  time assumption. Never substitute upload time or file mtime. Burned-in
  timestamps are not automatically read unless a separate OCR path is evaluated.
- Visual zones describe visible vehicle presence, not available bays.
  Do not turn uploaded track IDs into plate identities or billable visits.
- The dashboard wall is recorded playback, not live cameras. The three MEVA
  segments are one camera at different times; do not aggregate their readings
  into a simultaneous site total or invent camera names/locations.
- Persist only layout and demo feed IDs in browser preferences. Private
  analyzed recordings require per-visit opt-in and explicit selection, never
  auto-display or persistence of their names/IDs. Missing feeds stay unknown.
- Private API replay media streams after server-side checksum verification;
  static benchmark media retains full client-side checksum verification.
  Never copy private bundles/media to static/public exports.
- Browser tests use `npm.cmd test` so their isolated database/media are removed
  only after Playwright has stopped its servers. Do not delete a live test
  database from global-setup teardown.
- Curated `docs\screenshots` images use original synthetic fixtures only.
  Keep real/private footage and plate histories out of public screenshots;
  generate them explicitly, not as a side effect of the normal test suite.
- Event imports must be atomic and idempotent. Conflicting IDs, ambiguous
  pairs and missing exits need visible review, not guessed times or fees.
- Operator APIs are local prototypes, not authenticated public deployments.
  Do not expose them beyond loopback; deployment authentication and a real
  retention policy require a separate accepted scope.
- Monitoring uses UTC half-open windows and exact normalized plate/jurisdiction
  keys. Preserve out-of-order import correctness, atomic idempotency and audit
  history, including ignored observations. Do not guess visit durations.
- Recorded-visit fees require completed, unambiguous pairs. Preview policies
  explicitly subtract free minutes and charge started intervals, using integer
  minor units. Do not add guessed tariffs, taxes, payments or daily-cap rules.
- MEVA r13 explicitly uses its documented decoded-frame / 30 clock because raw
  AVI PTS are irregular. Do not silently apply that rule to unrelated footage.
- Both temporal methods share vehicle-level class-agnostic NMS at IoU 0.7.
  Do not count overlapping car/truck predictions as separate physical vehicles.
- Frozen protocol is `g328-zone-v2`. Do not tune the detector/thresholds or edit
  held-out labels to make existing results prettier.

## Collaboration and delivery

- Inspect the Git root and existing changes before writing.
- One implementation writer per working tree; no additional agents by default.
- Never commit secrets, media, weights, environments, bulk data or generated
  experiment outputs. Small synthetic fixtures and permitted text reference
  annotations are fine.
- Check licences before redistributing code, datasets or models.
- Do not publish or merge without authorization. A requested PR is ready for
  review unless the user explicitly requests a draft.
- Report actual results and blockers. Pending human reference review blocks
  verified accuracy claims, not continued implementation of the software.

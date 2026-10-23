# Local operator modes

This release implements the event/visit/query and calculation layers. It does
not read licence plates from video yet. A future qualified ANPR source can
produce the same event contract; existing clip-local tracking IDs cannot.

## Private video analysis

The Analyze & review tab accepts one authorized fixed-camera recording at a
time through a file picker or drag/drop. Import is streamed to private storage,
not public assets. Limits are 512 MiB, ten minutes, 2,073,600 pixels/frame and
at most 120 nominal fps. Accepted container signatures are MP4/MOV, AVI and
MKV/WebM; playlists, external URLs, missing duration and unsupported decoding
are errors. Right-angle orientation metadata is applied to both preview and
analysis media. Audio is omitted from the H.264 replay.

### Capture time is not upload time

The probe exposes only whitelisted date/time metadata as candidates, including
container/video creation dates, recording dates and timecode. It does not dump
arbitrary GPS or other metadata into the API. A creation date can be an export
date; a timecode may lack a calendar date and timezone. Neither proves capture
time. No candidate is selected as the recording clock automatically.

Enter the first-frame start with an ISO-8601 offset or `Z`, or explicitly use
a checked timezone-aware candidate. A date without timezone is rejected. For
example, `2026-10-22T18:00:00+03:00` becomes `2026-10-22T15:00:00Z`. A manually
adjusted candidate must be labelled Manual rather than falsely attributed to
unchanged metadata.

The operator must confirm a real-time 1x recording without time-lapse, speed
changes, cuts that remove time or recording gaps. Event time is that confirmed
first-frame start plus media elapsed seconds, using the actual presentation
timestamps. The original offset input and time source are retained. The 1x
assumption is not independently verified. Neither upload time nor file mtime
is ever substituted. Slower/faster **review playback** does not alter event UTC.

Burned-in/on-screen timestamp OCR is not connected. Inspect the decoded first
frame (or original playback where the browser supports its codec) and enter
the visible start manually when needed. Custom uploads do not use the
MEVA-r13-specific frame-index clock: missing or non-monotonic frame timestamps
fail visibly rather than being silently repaired or guessed.

### Geometry, jobs and evidence

Draw ordered polygon vertices and finish the zone; draw two distinct endpoints
and finish each boundary. At least one zone and one boundary are required.
The arrow points toward the entering side; Flip changes it. Counts use the
vehicle's bottom-centre anchor. A crossing needs a confirmed finite traversal,
not track appearance/disappearance or a crossing of the line's extension.
Zones mean **visible vehicle presence**, including moving vehicles, not bays.
Unseen capacity and available spaces remain unknown.

Coordinates are normalized `[x, y]` values from zero to one. Keyboard users can
edit/apply the geometry JSON. Duplicate IDs, invalid coordinates, degenerate
boundaries and self-intersecting polygons are rejected. There are at most
eight zones/eight boundaries, with 24 vertices per zone. Saved presets preserve
dimensions and geometry. Applying one to a different image size is refused;
matching dimensions still require the operator to check the same camera/view.

Choose CPU or CUDA explicitly. Processing requires the existing inference
extra and pinned cached weights; the server never downloads or substitutes a
model. One job runs at a time, with at most five queued/running/cancelling jobs.
A per-project analysis execution lock prevents concurrent private workers
across database instances. A running job has a hard 30-minute deadline.
Queue, preparation, model loading, analysis and finalization are distinct
stages; progress reports actual frames/media time for the current stage.

Cancel stops queued work immediately or signals running work, terminating its
owned worker after a short grace period. A cancellation during finalization
cannot publish success. Failed, cancelled, interrupted or partial jobs do not
expose result URLs. Restart marks interrupted running jobs failed and retains
queued jobs. The list shows only the latest 100 jobs, not an unlimited history.

Completed results have synchronized detections, clip-local tracks, all zone
readings and crossing logs, review-marker filtering, review-speed controls
and stepping between **analyzed observations**, not every decoded frame.
Private replay streams through the API after the local server checks its
checksum; the browser does not buffer a whole large recording for hashing.
Existing static benchmark clips retain client-side checksum verification.

Private JSON includes the frozen recording clock, upload metadata, model/run
provenance, geometry and actual baseline/candidate results. CSV lists each
method's events with clip seconds, event UTC, gate/direction, clip-local track
ID, clock basis and assumed recording rate. No human reference or accuracy
report is manufactured for a custom upload. Low-score markers are not
calibrated probabilities or confirmed mistakes. These observations do not
create plate histories, billable visits or available-space counts.

Private files live beside the selected database in
`<database-stem>-media\videos\...` and `...\jobs\...`, never under `viewer`.
Delete recording removes that input and all related terminal jobs; active jobs
must stop first. Camera presets remain reusable. Cancellation alone does not
delete the original or partial private artifacts. No automatic retention
policy is guessed. Keep the media root and database/backups under appropriate
OS access restrictions. The public/static export command refuses private
upload bundles; authorization to process is not permission to redistribute.

## Monitoring data

Import a JSON manifest with `parking monitor-import --input PATH`. The
committed `examples\plate-events.synthetic.json` is an artificial test input,
not footage output or an accuracy benchmark. The UI's separate example button
generates clearly labelled relative-time test events only when requested.

For real inputs, keep the file under ignored `data`, use `authorized_log` or
`anpr_log`, and set `rights_attested` to true only when you are authorized to
process the records. This is an operator assertion, not a legal clearance
check. Do not relabel generated test events as real data.

A manifest has:

| Field | Meaning |
|-------|---------|
| `schema_version` | `"1.0"` |
| `site_id`, `site_name` | Stable site namespace and operator label |
| `source_label` | Where the observations came from |
| `source_kind` | `authorized_log`, `anpr_log` or `synthetic`; kinds cannot mix within a site |
| `rights_attested` | Explicit authorization assertion for non-synthetic input |
| `events` | 1-10,000 observations per import |

Each event needs `event_id`, `occurred_at`, `direction`, `plate`,
`country_code` and `review_state`. Optional `confidence` and `camera_id`
describe the original source. A confidence score is not a calibrated
probability or independent validation.

- `event_id` identifies a crossing observation, not every OCR frame.
- `occurred_at` must have an ISO-8601 timezone offset or `Z`. Storage and
  filters use UTC; at most six fractional decimal places are supported.
- `direction` is `in` or `out` relative to the defined site boundary.
- `plate` is normalized to ASCII uppercase letters/digits by removing spaces
  and hyphens. Supported normalized length is 2-12. There is no fuzzy O/0
  matching or owner lookup.
- `country_code` is a two-letter jurisdiction key. Different jurisdiction/
  plate pairs never merge automatically.
- `review_state` is `confirmed`, `needs_review` or `ignored`. Confirmed input
  needs a readable plate and jurisdiction. Unreadable observations remain
  reviewable with null identifiers.

The importer is atomic and idempotent. Identical original event IDs/payloads
are reported as unchanged duplicates. Conflicting IDs roll back the entire
batch. Re-importing originals does not undo local operator corrections.

## Queries and visits

Choose a private source before querying. No source is selected automatically
to expose an existing history. An empty source selector is not a measured
zero-vehicle result.

| Query | Rule |
|-------|------|
| Entries | Entry-event time is in `[start, end)` |
| Exits | Exit-event time is in `[start, end)`, even without a matched entry |
| Visit history | All visits for the exact plate/jurisdiction filter; with a range, overlapping visits plus standalone observations inside the range |
| Overlapping period | Entry precedes the end and the exit follows the start; unclosed intervals extend only to the response `as_of` |
| Active/unclosed | An entry has no paired exit as of the response; date-window fields are disabled |
| Needs review | Unreadable, uncertain, duplicate, unmatched, simultaneous or future-dated observations |
| Reviewed/ignored | Locally corrected or explicitly ignored observations, filtered by observation time, with persistent audit detail |

Supply both range boundaries or neither. The end is exclusive to avoid
double counting adjacent windows. Overlap requires a range. A vehicle that
entered earlier can therefore appear in exits/presence without appearing in
that period's entries.

Visits are reconstructed from effective events in timestamp order, so later
imports of older events do not corrupt pairing. Repeated visits remain
separate. A repeated entry never silently resets the original entry time.
Simultaneous events are not ordered by a guessed direction. Unmatched exits
do not create invented entries, durations or charges.

An unclosed record is **not proof of physical presence**: an exit may have been
missed. Its elapsed time is explicitly provisional. Duplicate/uncertain
sequences have no billable final duration until resolved. Plate matches are
logical observations within a site, not proof of vehicle ownership.

Query results are paginated, 50 records by default and at most 200 per page.
The reported total is the full matching record count, not just the page size.
This first SQLite implementation rebuilds visit history for a selected site;
it is not a claim of production-scale performance.

## Local corrections

Open an event from a row, inspect its source and original payload, then
correct the effective plate/jurisdiction/time/direction/state with a reason
and an explicit source-inspected assertion. Ignore false/duplicate observations
rather than deleting the imported evidence.

Original normalized observations and hashes remain immutable. Corrections
append before/after audit records. An expected-content hash rejects stale
concurrent updates instead of overwriting another operator's resolution.
Queries and fees rebuild from the corrected effective history. The
Reviewed/ignored query can reopen an earlier ignored record.

These local assertions do not authenticate a reviewer or validate ANPR model
accuracy. They do not change the separate provisional MEVA reference status.

## Billing previews

The supported first policy has an explicit currency (`RON`, `EUR` or `USD`),
integer `price_minor`, positive `interval_minutes` and nonnegative
`free_minutes`. All supported currencies use two minor-unit decimals.

Free minutes are subtracted from the entire elapsed visit. Each **started**
remaining interval is charged. Integer microseconds and minor units avoid
floating-money rounding. UTC offsets are respected; naive timestamps and
backwards intervals are errors.

No price is prefilled. A zero price is allowed only as an explicit input.
There are no daily caps, tax rules, overnight tariff schedules, discounts,
minimum-stay charges or automatic payments in this policy.

A recorded-visit quote is allowed only for a completed, unambiguous pair.
Missing, disputed or unclosed visits cannot produce a charge. Manual times
are a separate labelled preview. Every response is `is_invoice = false`:
this is not an invoice, payment or authorization to actuate a barrier.

## Capacity

The calculator accepts an explicit mapped-space inventory, occupied count
and unknown/unobservable count. Only the remainder is reported as available
mapped spaces. Negative or contradictory inputs are rejected. Unmapped
whole-site capacity remains null.

These are operator inputs, **not image-derived availability**. Fields are
never populated from vehicle detections. The separate MEVA camera context
shows real zone-vehicle observations, including movers, and always reports
camera-derived available capacity as unknown. Automatic bay/layout geometry
needs appropriate footage, calibration and evaluation in a later task.

## Run and privacy boundary

For video processing, retain/install inference with
`uv sync --extra app --extra inference` instead of the app-only setup below,
which removes optional model packages. Use the pinned verified weights from
the README; jobs never download a model automatically.

```powershell
uv sync --extra app
Set-Location viewer
npm.cmd install --no-audit --no-fund --cache '..\.cache\npm'
npm.cmd run build
Set-Location ..
uv run --no-sync parking serve --database data\monitoring.sqlite3 --port 8000
```

Open `http://127.0.0.1:8000`. During frontend development, also run
`npm.cmd run dev` in `viewer`; the Vite `/api` proxy targets port 8000.
`PARKING_API_URL` can change that target only to another loopback HTTP origin.
After generating new public replay assets, rebuild the frontend if serving
the built app instead of Vite.

- The API binds only to `127.0.0.1`. Host/origin checks, JSON-only browser
  mutations (with a narrow octet-stream exception for video import) and
  no-store responses reduce accidental browser exposure.
- SQLite and real input logs stay outside the served viewer directory.
  Real logs inside this repository must be under ignored `data`, `.cache` or
  `outputs` (external operator-selected private files are also accepted).
  Database/journal file extensions are ignored globally. Vite's filesystem
  boundary also denies database files.
- Plate searches use request bodies, not URL history; routine API access logs
  are disabled. No external fonts, analytics, OCR API or payment service is used.
- Original and corrected plate observations are personal-data-bearing records.
  They are not encrypted or authenticated by this prototype. Apply OS access
  restrictions and an appropriate legal basis/retention policy.
- No automatic deletion policy is guessed. Authentication, deployment access
  control, retention enforcement/backups and public redaction remain required
  work before deployment. Do not bind this prototype publicly.
- Public website integration must use separately sanitized or synthetic data,
  never the private operations database or real plate-history responses.
- The schema-v1 database is migrated additively to v2 for analysis. Startup
  makes a private `<database-stem>-v1-backup-<id>.sqlite3` copy first; existing
  sites, events and correction audit are retained. Backups also need a lawful
  retention/access policy. Stop the old server before upgrading its database.

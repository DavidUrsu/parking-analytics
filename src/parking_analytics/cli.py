from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import av

from parking_analytics.evaluation import evaluate
from parking_analytics.io import fetch_inputs, read_model, sha256, write_json
from parking_analytics.models import Bundle, Config, Reference


def validate_assets(bundle: Bundle, directory: Path) -> None:
    for clip in bundle.clips:
        path = directory.joinpath(*clip.video.split("/"))
        if sha256(path) != clip.video_sha256:
            raise ValueError(f"Replay media hash mismatch: {path}")
        with av.open(str(path)) as video:
            stream = video.streams.video[0]
            if (stream.width, stream.height) != (clip.width, clip.height):
                raise ValueError(f"Replay media dimensions disagree with the bundle: {path}")
            if video.duration is None:
                raise ValueError(f"Replay has no duration: {path}")
            duration = video.duration / av.time_base
            if abs(duration - clip.duration_s) > 0.1:
                raise ValueError(f"Replay media duration disagrees with the bundle: {path}")


def export_bundle(bundle_path: Path, destination: Path) -> None:
    bundle = read_model(bundle_path, Bundle)
    if bundle.attribution.source_url.startswith("/api/analysis/") or any(
        clip.source.url.startswith("/api/analysis/") for clip in bundle.clips
    ):
        raise ValueError(
            "Private uploads cannot be copied to static/public exports. "
            "Use the private app replay and its private JSON/CSV downloads."
        )
    validate_assets(bundle, bundle_path.parent)
    if destination.exists():
        raise FileExistsError(f"Choose a new export directory; refusing to overwrite {destination}")
    destination.mkdir(parents=True)
    for clip in bundle.clips:
        source = bundle_path.parent.joinpath(*clip.video.split("/"))
        target = destination.joinpath(*clip.video.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    write_json(destination / "bundle.json", bundle)
    validate_assets(bundle, destination)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="parking",
        description="Local parking operations and offline evidence; no live inference service",
    )
    commands = root.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser(
        "fetch", help="Fetch/reuse checksum-verified footage and pinned weights"
    )
    fetch.add_argument("--config", type=Path, default=Path("configs") / "meva-g328.json")
    fetch.add_argument("--data", type=Path, default=Path("data"))
    fetch.add_argument("--model-dir", type=Path, default=Path("models") / "rtdetr-r18")
    fetch.add_argument("--ledger", type=Path, default=Path(".cache") / "download-ledger.json")
    process = commands.add_parser("process", help="Run the real detector and both temporal methods")
    process.add_argument("--config", type=Path, default=Path("configs") / "meva-g328.json")
    process.add_argument("--data", type=Path, default=Path("data"))
    process.add_argument("--model-dir", type=Path, default=Path("models") / "rtdetr-r18")
    process.add_argument("--output", type=Path, required=True)
    process.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    score = commands.add_parser("evaluate", help="Evaluate against explicit reference labels")
    score.add_argument("--bundle", type=Path, required=True)
    score.add_argument("--reference", type=Path, required=True)
    score.add_argument("--output", type=Path, required=True)
    score.add_argument("--require-reviewed", action="store_true")
    score.add_argument("--overwrite", action="store_true")
    export = commands.add_parser(
        "export", help="Copy a validated replay bundle and media for the viewer"
    )
    export.add_argument("--bundle", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser(
        "validate", help="Validate a replay contract and actual media hashes"
    )
    validate.add_argument("--bundle", type=Path, required=True)
    schema = commands.add_parser(
        "schema", help="Generate the viewer's JSON Schema from Python models"
    )
    schema.add_argument("--output", type=Path, required=True)
    schema.add_argument("--overwrite", action="store_true")
    schema.add_argument("--kind", choices=["replay", "operations", "analysis"], default="replay")
    smoke = commands.add_parser(
        "smoke", help="Generate a tiny explicitly synthetic, CPU-only replay"
    )
    smoke.add_argument("--output", type=Path, required=True)
    smoke.add_argument("--replace-synthetic", action="store_true")
    serve = commands.add_parser("serve", help="Start the private loopback-only operations app/API")
    serve.add_argument("--database", type=Path, default=Path("data") / "monitoring.sqlite3")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--frontend-origin", default="http://127.0.0.1:4186")
    ingest = commands.add_parser(
        "monitor-import", help="Import an authorized event JSON into private SQLite"
    )
    ingest.add_argument("--input", type=Path, required=True)
    ingest.add_argument("--database", type=Path, default=Path("data") / "monitoring.sqlite3")
    return root


def main() -> None:
    arguments = parser()
    args = arguments.parse_args()
    try:
        if args.command == "fetch":
            config = read_model(args.config, Config)
            fetch_inputs(config, args.data, args.model_dir, args.ledger)
        elif args.command == "process":
            from parking_analytics.pipeline import process

            config = read_model(args.config, Config)
            result = process(config, args.data, args.model_dir, args.output, args.device)
            validate_assets(result, args.output)
            print(f"Actual model output: {args.output / 'bundle.json'}; not yet evaluated")
        elif args.command == "evaluate":
            bundle = read_model(args.bundle, Bundle)
            validate_assets(bundle, args.bundle.parent)
            reference = read_model(args.reference, Reference)
            if args.require_reviewed and reference.review_status != "reviewed":
                raise ValueError(
                    "Human reference review is pending; verified evaluation is blocked"
                )
            result = evaluate(bundle, reference)
            write_json(args.output, result, overwrite=args.overwrite)
            if reference.review_status != "reviewed":
                print("PROVISIONAL: these labels are not human-verified.", file=sys.stderr)
            if not reference.events_complete:
                print(
                    "Event precision/recall/F1 are NOT SCORED: crossing drafts are incomplete.",
                    file=sys.stderr,
                )
            for split, methods in result.evaluation.by_split.items():
                for name, metrics in methods.items():
                    print(
                        f"{split}/{name}: zone-count MAE={metrics.occupancy.mean_absolute_error}, "
                        f"coverage={metrics.occupancy.coverage}, "
                        f"event F1={metrics.events.f1}"
                    )
            print(f"Evaluation ({reference.review_status}) saved: {args.output}")
        elif args.command == "export":
            export_bundle(args.bundle, args.output)
            print(f"Exported validated replay to {args.output}")
        elif args.command == "validate":
            bundle = read_model(args.bundle, Bundle)
            validate_assets(bundle, args.bundle.parent)
            print(
                f"Valid {'SYNTHETIC' if bundle.synthetic else 'real-video'} replay: {args.bundle}"
            )
        elif args.command == "schema":
            if args.kind == "analysis":
                from parking_analytics.analysis_models import ANALYSIS_ADAPTER

                generated = ANALYSIS_ADAPTER.json_schema(mode="serialization")
            elif args.kind == "operations":
                from parking_analytics.operations_models import OPERATIONS_ADAPTER

                generated = OPERATIONS_ADAPTER.json_schema(mode="serialization")
            else:
                generated = Bundle.model_json_schema(mode="serialization")
            write_json(
                args.output,
                generated,
                overwrite=args.overwrite,
            )
            print(f"Generated shared schema: {args.output}")
        elif args.command == "smoke":
            from parking_analytics.synthetic import create_smoke

            create_smoke(args.output, replace=args.replace_synthetic)
            print(f"SYNTHETIC SMOKE ONLY: {args.output}; not model-quality evidence")
        elif args.command == "monitor-import":
            from parking_analytics.monitoring_store import (
                ROOT,
                import_events,
                initialize_database,
                inside_viewer,
            )
            from parking_analytics.operations_models import EventManifest

            if inside_viewer(args.input):
                raise ValueError("Keep plate-event input files outside the served viewer directory")
            manifest = read_model(args.input, EventManifest)
            input_path = args.input.resolve()
            private_roots = [ROOT / "data", ROOT / ".cache", ROOT / "outputs"]
            if (
                manifest.source_kind != "synthetic"
                and input_path.is_relative_to(ROOT)
                and not any(input_path.is_relative_to(folder.resolve()) for folder in private_roots)
            ):
                raise ValueError(
                    "Real event files inside this repository must stay in ignored private storage"
                )
            initialize_database(args.database)
            result = import_events(args.database, manifest)
            print(
                f"{result.site.source_kind}: imported {result.imported}, "
                f"unchanged duplicates {result.duplicates}; private site {result.site.id}"
            )
        elif args.command == "serve":
            try:
                import uvicorn

                from parking_analytics.api import create_app
            except ModuleNotFoundError as error:
                raise RuntimeError("Install app dependencies with: uv sync --extra app") from error
            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be between 1 and 65535")
            app = create_app(args.database, frontend_origin=args.frontend_origin)
            uvicorn.run(
                app, host="127.0.0.1", port=args.port, access_log=False, proxy_headers=False
            )
    except (OSError, ValueError, RuntimeError, TimeoutError, av.FFmpegError) as error:
        arguments.exit(2, f"parking: error: {error}\n")


if __name__ == "__main__":
    main()

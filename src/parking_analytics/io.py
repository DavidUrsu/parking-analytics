from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from pathlib import Path

from parking_analytics.models import Config, Model

DEPENDENCY_RESERVE = 4 * 1024**3
MODEL_FILES = {
    "config.json": (5267, "36c0aaddbdd2d161a7fd9e5930051198d1455be1"),
    "preprocessor_config.json": (841, "0eaa5c051317a3725f47218ae30b6e654f0ece36"),
    "README.md": (9102, "8911a08498e4b2a1118faa1d63b091c5b237b24d"),
}


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def read_model[T: Model](path: Path, model_type: type[T]) -> T:
    return model_type.model_validate_json(path.read_bytes())


def write_json(path: Path, value: Model | dict, *, overwrite: bool = False) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite {path}; choose a new output path")
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (
        value.model_dump_json(indent=2)
        if isinstance(value, Model)
        else json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False)
    )
    temporary = path.with_name(path.name + ".tmp")
    if temporary.exists():
        raise FileExistsError(f"Remove or inspect the existing temporary file: {temporary}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as output:
            output.write(text + "\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def verify_source(path: Path, expected_bytes: int, expected_sha256: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Missing {path}; run 'parking fetch' first")
    if path.stat().st_size != expected_bytes or sha256(path) != expected_sha256:
        raise ValueError(f"Source size/hash mismatch: {path}; do not use a changed or partial file")


class DownloadBudget:
    def __init__(self, path: Path, limit: int) -> None:
        self.path = path
        self.limit = limit
        if path.exists():
            self.ledger = json.loads(path.read_text(encoding="utf-8"))
            if self.ledger["limit_bytes"] != limit:
                raise ValueError("Download ledger limit differs from the approved configuration")
        else:
            self.ledger = {
                "limit_bytes": limit,
                "used_bytes": DEPENDENCY_RESERVE,
                "records": [
                    {
                        "label": "Conservative dependency/scouting reserve; not measured traffic",
                        "bytes": DEPENDENCY_RESERVE,
                        "status": "reserved",
                    }
                ],
            }
        if not DEPENDENCY_RESERVE <= self.ledger["used_bytes"] <= limit:
            raise ValueError("Download ledger is invalid or its budget is exhausted")

    def download(
        self,
        url: str,
        path: Path,
        size: int,
        *,
        digest: str | None = None,
        git_blob: str | None = None,
    ) -> None:
        def verify() -> None:
            if path.stat().st_size != size:
                raise ValueError(f"Incomplete file: {path}")
            if digest is not None and sha256(path) != digest:
                raise ValueError(f"SHA-256 mismatch: {path}")
            if git_blob is not None:
                data = path.read_bytes()
                actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                if actual != git_blob:
                    raise ValueError(f"Pinned Git blob mismatch: {path}")

        if path.exists():
            verify()
            print(f"Reusing verified {path}")
            return
        if not url.startswith("https://"):
            raise ValueError("Downloads must use HTTPS")
        if size > self.limit - self.ledger["used_bytes"]:
            raise ValueError(f"Download would exceed the approved budget: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".part")
        if partial.exists():
            raise FileExistsError(
                f"Inspect the previous partial download before retrying: {partial}"
            )
        received = 0
        complete = False
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "parking-analytics/0.1"})
            with (
                urllib.request.urlopen(request, timeout=90) as response,
                partial.open("xb") as output,
            ):
                advertised = response.headers.get("Content-Length")
                if advertised is not None and int(advertised) != size:
                    raise ValueError(f"Remote source size changed: {path.name}")
                while received < size:
                    chunk = response.read(min(1024**2, size - received))
                    if not chunk:
                        break
                    received += len(chunk)
                    output.write(chunk)
            if received != size:
                raise ValueError(f"Incomplete download: {path.name}")
            os.replace(partial, path)
            verify()
            complete = True
            print(f"Downloaded and verified {path} ({received:,} bytes)")
        finally:
            self.ledger["used_bytes"] += received
            self.ledger["records"].append(
                {
                    "label": str(path),
                    "bytes": received,
                    "status": "complete" if complete else "failed",
                }
            )
            write_json(self.path, self.ledger, overwrite=True)
            partial.unlink(missing_ok=True)
            if not complete:
                path.unlink(missing_ok=True)


def fetch_inputs(config: Config, data_dir: Path, model_dir: Path, ledger: Path) -> None:
    budget = DownloadBudget(ledger, config.max_download_bytes)
    for clip in config.clips:
        source = clip.source
        budget.download(source.url, data_dir / source.file, source.bytes, digest=source.sha256)
    base = f"https://huggingface.co/{config.model.id}/resolve/{config.model.revision}/"
    for filename, (size, blob) in MODEL_FILES.items():
        budget.download(base + filename, model_dir / filename, size, git_blob=blob)
    budget.download(
        base + "model.safetensors",
        model_dir / "model.safetensors",
        80904152,
        digest=config.model.weights_sha256,
    )
    print(f"Budget accounted/reserved: {budget.ledger['used_bytes']:,}/{budget.limit:,} bytes")

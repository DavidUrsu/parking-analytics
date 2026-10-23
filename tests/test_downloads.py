import hashlib
import io
import json
import urllib.request

import pytest

from parking_analytics.io import DEPENDENCY_RESERVE, DownloadBudget


class Response(io.BytesIO):
    headers = {"Content-Length": "3"}


def test_download_budget_and_failed_hash_accounting(tmp_path, monkeypatch):
    calls = []

    def open_response(*args, **kwargs):
        calls.append(True)
        return Response(b"abc")

    monkeypatch.setattr(urllib.request, "urlopen", open_response)
    ledger = tmp_path / "ledger.json"
    budget = DownloadBudget(ledger, DEPENDENCY_RESERVE + 3)
    target = tmp_path / "file"
    with pytest.raises(ValueError, match="exceed"):
        budget.download("https://example.invalid/file", target, 4)
    assert not calls
    with pytest.raises(ValueError, match="SHA-256"):
        budget.download("https://example.invalid/file", target, 3, digest="0" * 64)
    assert not target.exists() and not target.with_name("file.part").exists()
    persisted = json.loads(ledger.read_text())
    assert persisted["used_bytes"] == DEPENDENCY_RESERVE + 3
    assert persisted["records"][-1]["status"] == "failed"
    with pytest.raises(ValueError, match="exceed"):
        budget.download("https://example.invalid/file", target, 1)


def test_verified_reuse_does_not_spend_budget(tmp_path, monkeypatch):
    target = tmp_path / "file"
    target.write_bytes(b"abc")
    budget = DownloadBudget(tmp_path / "ledger.json", DEPENDENCY_RESERVE + 3)
    digest = hashlib.sha256(b"abc").hexdigest()
    budget.download("https://example.invalid/file", target, 3, digest=digest)
    assert budget.ledger["used_bytes"] == DEPENDENCY_RESERVE
    with pytest.raises(ValueError, match="SHA-256"):
        budget.download("https://example.invalid/file", target, 3, digest="0" * 64)

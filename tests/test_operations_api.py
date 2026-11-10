import pytest

from parking_analytics.monitoring_store import example_manifest, import_events


@pytest.fixture
def api_client(tmp_path):
    pytest.importorskip("fastapi", reason="Optional app dependencies are not installed")
    pytest.importorskip("httpx", reason="API test dependencies are not installed")
    from fastapi.testclient import TestClient

    from parking_analytics.api import create_app

    path = tmp_path / "operator.sqlite3"
    app = create_app(path, frontend_origin="http://127.0.0.1:4175", serve_frontend=False)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, path


def test_no_source_is_empty_not_a_synthetic_fallback(api_client):
    client, _ = api_client
    response = client.get("/api/sites")
    assert response.status_code == 200
    assert response.json() == {"kind": "sites", "sites": []}
    assert response.headers["cache-control"] == "no-store"
    missing = client.post("/api/monitoring/search", json={"site_id": "missing"})
    assert missing.status_code == 404


def test_example_is_explicit_separate_and_queryable(api_client):
    client, _ = api_client
    result = client.post("/api/examples", json={})
    assert result.status_code == 200
    assert result.json()["site"]["source_kind"] == "synthetic"
    assert result.json()["imported"] == 11
    again = client.post("/api/examples", json={})
    assert again.json()["imported"] == 0 and again.json()["duplicates"] == 11
    result = client.post("/api/monitoring/search", json={"site_id": "example", "plate": "demo-001"})
    assert result.status_code == 200 and result.json()["total"] == 2
    assert result.json()["records"][0]["record_type"] == "visit"


def test_api_corrections_are_durable_and_not_public_uploads(api_client):
    client, path = api_client
    manifest = example_manifest()
    import_events(path, manifest)
    original = next(event for event in manifest.events if event.event_id == "duplicate-in-second")
    correction = original.model_dump(mode="json")
    correction.pop("confidence")
    correction.pop("camera_id")
    correction |= {
        "site_id": "example",
        "review_state": "ignored",
        "expected_event_hash": original.digest(),
        "reason": "Checked generated test source",
        "source_checked": True,
    }
    result = client.post("/api/events/review", json=correction)
    assert result.status_code == 200
    assert len(result.json()["audit"]) == 1
    assert result.json()["current"]["review_state"] == "ignored"
    assert client.post("/api/import", json=manifest.model_dump(mode="json")).status_code == 404


def test_private_queries_reject_cross_origin_hosts_and_non_json_mutations(api_client):
    client, _ = api_client
    assert (
        client.get("/api/sites", headers={"Origin": "https://unrelated.example"}).status_code == 403
    )
    assert client.get("/api/sites", headers={"Host": "unrelated.example"}).status_code == 400
    assert (
        client.post(
            "/api/examples", content="{}", headers={"Content-Type": "text/plain"}
        ).status_code
        == 415
    )
    assert client.get("/api/sites", headers={"Origin": "http://127.0.0.1:4175"}).status_code == 200


def test_validation_errors_do_not_echo_private_input(api_client):
    client, _ = api_client
    response = client.post(
        "/api/monitoring/search",
        json={"site_id": "example", "plate": "PRIVATE_TEST_VALUE_WITH_INVALID_CHARACTERS!"},
    )
    assert response.status_code == 422
    assert "PRIVATE_TEST_VALUE" not in response.text
    assert all("input" not in issue for issue in response.json()["detail"])


def test_calculators_validate_and_return_explicit_non_invoice_results(api_client):
    client, _ = api_client
    response = client.post(
        "/api/billing/preview",
        json={
            "entered_at": "2026-01-15T10:00:00Z",
            "exited_at": "2026-01-15T11:15:00Z",
            "policy": {
                "currency": "RON",
                "price_minor": 500,
                "interval_minutes": 30,
                "free_minutes": 15,
            },
        },
    )
    assert response.status_code == 200
    assert response.json()["total_minor"] == 1000 and not response.json()["is_invoice"]
    response = client.post(
        "/api/capacity/calculate",
        json={"mapped_spaces": 10, "occupied_spaces": 6, "unknown_spaces": 2},
    )
    assert response.status_code == 200 and response.json()["available_mapped_spaces"] == 2
    invalid = client.post(
        "/api/capacity/calculate",
        json={"mapped_spaces": 10, "occupied_spaces": 8, "unknown_spaces": 4},
    )
    assert invalid.status_code == 422


def test_frontend_entry_revalidates_for_all_modes_and_after_a_rebuild(tmp_path, monkeypatch):
    pytest.importorskip("fastapi", reason="Optional app dependencies are not installed")
    pytest.importorskip("httpx", reason="API test dependencies are not installed")
    from fastapi.testclient import TestClient

    from parking_analytics import api

    frontend = tmp_path / "viewer" / "dist"
    assets = frontend / "assets"
    assets.mkdir(parents=True)
    entry = frontend / "index.html"
    entry.write_text("<html>previous dashboard build</html>", encoding="utf-8")
    (assets / "app-versioned.js").write_text("console.log('test fixture');", encoding="utf-8")
    monkeypatch.setattr(api, "ROOT", tmp_path)
    app = api.create_app(tmp_path / "operator.sqlite3")
    with TestClient(app, base_url="http://127.0.0.1") as client:
        paths = ["/", "/index.html"]
        paths.extend(
            f"/?mode={mode}&lang={language}"
            for mode in ("dashboard", "monitoring", "billing", "capacity", "analysis", "evidence")
            for language in ("en", "ro")
        )
        for path in paths:
            response = client.get(path)
            assert response.status_code == 200 and "previous dashboard build" in response.text
            assert response.headers["cache-control"] == "no-cache"
            previous_etag = response.headers["etag"]
            unchanged = client.get(path, headers={"If-None-Match": previous_etag})
            assert unchanged.status_code == 304
            assert unchanged.headers["cache-control"] == "no-cache"

        entry.write_text(
            "<html>new dashboard build with shared navigation</html>", encoding="utf-8"
        )
        updated = client.get("/?mode=monitoring&lang=en", headers={"If-None-Match": previous_etag})
        assert updated.status_code == 200
        assert "new dashboard build with shared navigation" in updated.text
        assert updated.headers["cache-control"] == "no-cache"
        assert updated.headers["etag"] != previous_etag
        assert client.get("/api/health").headers["cache-control"] == "no-store"
        asset = client.get("/assets/app-versioned.js")
        assert asset.status_code == 200 and "cache-control" not in asset.headers

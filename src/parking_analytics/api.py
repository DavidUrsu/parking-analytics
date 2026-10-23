from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from parking_analytics.analysis_manager import AnalysisManager
from parking_analytics.analysis_routes import analysis_router
from parking_analytics.calculators import calculate_capacity, calculate_fee
from parking_analytics.monitoring_store import (
    ROOT,
    ConflictError,
    MissingRecordError,
    event_detail,
    example_manifest,
    get_visit,
    import_events,
    initialize_database,
    list_sites,
    private_database_path,
    quote_visit,
    review_event,
    search,
)
from parking_analytics.operations_models import (
    BillingQuote,
    CapacityRequest,
    CapacityResult,
    EventCorrection,
    EventDetail,
    EventLookup,
    ExampleRequest,
    ImportResult,
    ManualQuoteRequest,
    SearchRequest,
    SearchResult,
    SiteList,
    VisitDetail,
    VisitLookup,
    VisitQuoteRequest,
)

logger = logging.getLogger(__name__)


def create_app(
    database_path: Path,
    *,
    frontend_origin: str = "http://127.0.0.1:4186",
    serve_frontend: bool = True,
) -> FastAPI:
    database_path = private_database_path(database_path)
    parsed = urlsplit(frontend_origin)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or parsed.username
    ):
        raise ValueError("The operator frontend origin must be a loopback HTTP origin")
    allowed = {
        frontend_origin.rstrip("/"),
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4186",
        "http://localhost:4186",
    }
    analysis = AnalysisManager(database_path)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        initialize_database(database_path)
        analysis.start()
        try:
            yield
        finally:
            analysis.stop()

    app = FastAPI(
        title="Parking operations - local operator prototype",
        version="0.2.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def private_api(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            own_origin = f"{request.url.scheme}://{request.url.netloc}"
            if origin is not None and origin.rstrip("/") not in allowed | {own_origin}:
                return JSONResponse({"detail": "Unapproved browser origin"}, status_code=403)
            if request.method in ("POST", "PUT", "PATCH", "DELETE"):
                content_type = request.headers.get("content-type", "").split(";")[0].lower()
                upload = request.method == "POST" and request.url.path == "/api/analysis/videos"
                expected = "application/octet-stream" if upload else "application/json"
                if content_type != expected:
                    return JSONResponse({"detail": f"Use {expected}"}, status_code=415)
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError):
        return JSONResponse(
            {
                "detail": [
                    {"loc": issue["loc"], "msg": issue["msg"], "type": issue["type"]}
                    for issue in error.errors()
                ]
            },
            status_code=422,
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(MissingRecordError)
    async def missing_record(_request: Request, error: MissingRecordError):
        return JSONResponse(
            {"detail": str(error)}, status_code=404, headers={"Cache-Control": "no-store"}
        )

    @app.exception_handler(ConflictError)
    async def conflict(_request: Request, error: ConflictError):
        return JSONResponse(
            {"detail": str(error)}, status_code=409, headers={"Cache-Control": "no-store"}
        )

    @app.exception_handler(ValueError)
    async def invalid_value(_request: Request, error: ValueError):
        return JSONResponse(
            {"detail": str(error)}, status_code=422, headers={"Cache-Control": "no-store"}
        )

    @app.exception_handler(sqlite3.Error)
    async def database_failure(_request: Request, _error: sqlite3.Error):
        logger.error(
            "Operations database request failed; inspect the private database and permissions"
        )
        return JSONResponse(
            {"detail": "Operations database failed; inspect its file and permissions"},
            status_code=500,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/health")
    def health():
        return {"status": "ok", "service": "parking-operations"}

    @app.get("/api/sites", response_model=SiteList)
    def sites():
        return SiteList(sites=list_sites(database_path))

    @app.post("/api/monitoring/search", response_model=SearchResult)
    def monitoring(request: SearchRequest):
        return search(database_path, request)

    @app.post("/api/events/detail", response_model=EventDetail)
    def detail(request: EventLookup):
        return event_detail(database_path, request)

    @app.post("/api/events/review", response_model=EventDetail)
    def correction(request: EventCorrection):
        return review_event(database_path, request)

    @app.post("/api/examples", response_model=ImportResult)
    def example(request: ExampleRequest):
        existing = next(
            (site for site in list_sites(database_path) if site.id == request.site_id), None
        )
        if existing is not None:
            if existing.source_kind != "synthetic":
                raise ConflictError("The example must not overwrite a real operator source")
            return ImportResult(site=existing, imported=0, duplicates=existing.event_count)
        return import_events(database_path, example_manifest(request.site_id))

    @app.post("/api/visits/detail", response_model=VisitDetail)
    def visit(request: VisitLookup):
        site, record = get_visit(database_path, request)
        return VisitDetail(site=site, visit=record)

    @app.post("/api/billing/preview", response_model=BillingQuote)
    def manual_fee(request: ManualQuoteRequest):
        return calculate_fee(request)

    @app.post("/api/billing/visit", response_model=BillingQuote)
    def visit_fee(request: VisitQuoteRequest):
        return quote_visit(database_path, request)

    @app.post("/api/capacity/calculate", response_model=CapacityResult)
    def capacity(request: CapacityRequest):
        return calculate_capacity(request)

    app.include_router(analysis_router(database_path, analysis))
    frontend = ROOT / "viewer" / "dist"
    if serve_frontend and frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="operator-app")
    return app

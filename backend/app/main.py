"""FastAPI app: analysis/export API plus the built frontend."""

from __future__ import annotations

import csv
import io
import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.domain import Analysis, Analyzer, HourRow, Snapshot, cutoff_time

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = BACKEND / "data" / "snapshot.json"
FRONTEND_DIST = BACKEND.parent / "frontend" / "dist"
logger = logging.getLogger(__name__)


def create_app(snapshot_path: Path | None = None, frontend_dist: Path | None = None) -> FastAPI:
    path = snapshot_path or Path(os.getenv("WIND_SNAPSHOT_PATH", str(DEFAULT_SNAPSHOT)))

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.analyzer = None
        try:
            application.state.analyzer = Analyzer(Snapshot.model_validate_json(path.read_bytes()))
        except (OSError, ValueError):
            logger.exception("Snapshot unavailable or invalid: %s", path)
        yield

    application = FastAPI(title="Wind forecast analysis", version="1.0.0", lifespan=lifespan)

    def get_analysis(decision_date: date, cutoff: str) -> Analysis:
        try:
            cutoff_time(decision_date, cutoff)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        analyzer = application.state.analyzer
        if analyzer is None:
            raise HTTPException(
                status_code=503,
                detail="Data snapshot unavailable. Regenerate it with python -m app.acquire.",
            )
        return analyzer.analysis(decision_date, cutoff)

    @application.get("/api/health")
    def health():
        analyzer = application.state.analyzer
        if analyzer is None:
            raise HTTPException(status_code=503, detail="Data snapshot unavailable or invalid")
        return {
            "status": "ok",
            "data_available": True,
            "retrieved_at": analyzer.snapshot.metadata["retrieved_at"],
            "forecast_records": len(analyzer.snapshot.forecasts),
            "actual_records": len(analyzer.snapshot.actuals),
        }

    @application.get("/api/analysis", response_model=Analysis)
    def analysis(
        decision_date: date = date(2026, 1, 15),
        cutoff: Annotated[str, Query(pattern=r"^[0-9]{2}:[0-9]{2}$")] = "10:00",
    ) -> Analysis:
        return get_analysis(decision_date, cutoff)

    @application.get("/api/export")
    def export(
        decision_date: date = date(2026, 1, 15),
        cutoff: Annotated[str, Query(pattern=r"^[0-9]{2}:[0-9]{2}$")] = "10:00",
    ) -> Response:
        result = get_analysis(decision_date, cutoff)
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=list(HourRow.model_fields))
        writer.writeheader()
        writer.writerows(row.model_dump(mode="json") for row in result.rows)
        filename = f"wind-{decision_date}-{cutoff.replace(':', '')}.csv"
        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # Unknown /api paths should 404 instead of falling through to the frontend.
    @application.api_route(
        "/api/{unknown:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    def unknown_api(unknown: str):
        raise HTTPException(status_code=404, detail="API route not found")

    dist = frontend_dist or FRONTEND_DIST
    if dist.is_dir() and (dist / "index.html").is_file():
        assets = dist / "assets"
        if assets.is_dir():
            application.mount("/assets", StaticFiles(directory=assets), name="assets")

        @application.get("/", include_in_schema=False)
        def index():
            return FileResponse(dist / "index.html")

    return application


app = create_app()

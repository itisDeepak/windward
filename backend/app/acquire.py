"""Download the Elexon data and save it as data/snapshot.json (python -m app.acquire)."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import UTC, date, datetime, timedelta
from datetime import time as day_time
from pathlib import Path

import httpx

from app.domain import Record, Snapshot

BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"
TARGET_FROM = datetime(2026, 1, 2, tzinfo=UTC)
TARGET_TO = datetime(2026, 2, 2, tzinfo=UTC)
PUBLICATION_FROM = date(2025, 12, 29)
PUBLICATION_TO = date(2026, 2, 1)
MAX_BYTES = 20_000_000


def request_records(client: httpx.Client, dataset: str, params: dict) -> tuple[list[dict], dict]:
    """Fetch one dataset window; the stream endpoint returns every forecast version."""
    url = f"{BASE_URL}/datasets/{dataset}/stream"
    for attempt in range(3):
        try:
            with client.stream("GET", url, params=params) as response:
                response.raise_for_status()
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        raise ValueError("Upstream response exceeds 20 MB bound")
                payload = json.loads(content)
                if not isinstance(payload, list):
                    raise ValueError("Expected a source stream JSON array")
                return payload, {
                    "url": str(response.url),
                    "retrieved_at": datetime.now(UTC).isoformat(),
                    "response_sha256": hashlib.sha256(content).hexdigest(),
                    "source_rows": len(payload),
                }
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
            retryable = not isinstance(exc, httpx.HTTPStatusError) or (
                exc.response.status_code == 429 or exc.response.status_code >= 500
            )
            if not retryable or attempt == 2:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("Unreachable request state")


def normalize(source: list[dict], dataset: str) -> list[Record]:
    records = []
    for row in source:
        if row.get("dataset") != dataset:
            raise ValueError(f"Unexpected dataset in {dataset} response")
        if dataset == "FUELHH" and row.get("fuelType") != "WIND":
            raise ValueError("FUELHH response contains non-WIND records")
        record = Record(
            start_time=row["startTime"],
            publish_time=row["publishTime"],
            generation_mw=row["generation"],
        )
        if TARGET_FROM <= record.start_time < TARGET_TO:
            records.append(record)
    return records


def acquire(destination: Path) -> Snapshot:
    forecasts: list[Record] = []
    actuals: list[Record] = []
    requests = []
    with httpx.Client(
        timeout=httpx.Timeout(40, connect=15),
        follow_redirects=False,
        headers={"User-Agent": "windward/1.0"},
    ) as client:
        current = PUBLICATION_FROM
        while current < PUBLICATION_TO:
            following = current + timedelta(days=1)
            params = {
                "publishDateTimeFrom": datetime.combine(current, day_time(), UTC).isoformat(),
                "publishDateTimeTo": datetime.combine(following, day_time(), UTC).isoformat(),
            }
            rows, metadata = request_records(client, "WINDFOR", params)
            # An empty day almost certainly means a failed fetch, so stop instead of saving it.
            if not rows:
                raise ValueError(f"Empty WINDFOR publication window: {current}")
            forecasts.extend(normalize(rows, "WINDFOR"))
            requests.append(metadata)
            print(f"WINDFOR {current}: {len(rows)} source rows", flush=True)
            current = following
        current = TARGET_FROM.date()
        while current < TARGET_TO.date():
            params = {
                "settlementDateFrom": current.isoformat(),
                "settlementDateTo": current.isoformat(),
                "fuelType": "WIND",
            }
            rows, metadata = request_records(client, "FUELHH", params)
            if not rows:
                raise ValueError(f"Empty FUELHH settlement day: {current}")
            actuals.extend(normalize(rows, "FUELHH"))
            requests.append(metadata)
            print(f"FUELHH {current}: {len(rows)} source rows", flush=True)
            current += timedelta(days=1)
    snapshot = Snapshot(
        metadata={
            "retrieved_at": datetime.now(UTC).isoformat(),
            "sources": [
                f"{BASE_URL}/datasets/WINDFOR/stream",
                f"{BASE_URL}/datasets/FUELHH/stream",
            ],
            "documentation": "https://bmrs.elexon.co.uk/api-documentation",
            "openapi": "https://data.elexon.co.uk/swagger/v1/swagger.json",
            "publication_window_from": f"{PUBLICATION_FROM}T00:00:00+00:00",
            "publication_window_to": f"{PUBLICATION_TO}T00:00:00+00:00",
            "delivery_window_from": TARGET_FROM.isoformat(),
            "delivery_window_to_exclusive": TARGET_TO.isoformat(),
            "requests": requests,
            "forecast_records_before_deduplication": len(forecasts),
            "actual_records_before_deduplication": len(actuals),
            "vintages_preserved": True,
        },
        forecasts=forecasts,
        actuals=actuals,
    )
    # Days overlap at the boundaries, so drop exact duplicates.
    snapshot.forecasts = list(
        {(r.start_time, r.publish_time): r for r in snapshot.forecasts}.values()
    )
    snapshot.actuals = list({(r.start_time, r.publish_time): r for r in snapshot.actuals}.values())
    snapshot.forecasts.sort(key=lambda record: (record.start_time, record.publish_time))
    snapshot.actuals.sort(key=lambda record: (record.start_time, record.publish_time))
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.with_suffix(".json.part")
    try:
        staging.write_text(snapshot.model_dump_json(), encoding="utf-8")
        Snapshot.model_validate_json(staging.read_bytes())
        staging.replace(destination)
    finally:
        staging.unlink(missing_ok=True)
    return snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "snapshot.json",
    )
    args = parser.parse_args()
    snapshot = acquire(args.output)
    print(f"Saved {len(snapshot.forecasts)} forecasts and {len(snapshot.actuals)} half-hours")


if __name__ == "__main__":
    main()

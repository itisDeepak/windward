"""Validated source records and publication-time-safe hourly analysis."""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

FIRST_DECISION = date(2026, 1, 1)
LAST_DECISION = date(2026, 1, 31)
LONDON = ZoneInfo("Europe/London")
Generation = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_time: AwareDatetime
    publish_time: AwareDatetime
    generation_mw: Generation | None

    @field_validator("start_time", "publish_time")
    @classmethod
    def normalize_time(cls, value: datetime) -> datetime:
        return value.astimezone(UTC)


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1] = 1
    metadata: dict
    forecasts: list[Record]
    actuals: list[Record]

    @model_validator(mode="after")
    def validate_records(self) -> Snapshot:
        for name, records, minutes in (
            ("forecasts", self.forecasts, (0,)),
            ("actuals", self.actuals, (0, 30)),
        ):
            seen: dict[tuple[datetime, datetime], float | None] = {}
            for record in records:
                start = record.start_time
                if start.minute not in minutes or start.second or start.microsecond:
                    raise ValueError(f"{name}: invalid interval boundary {start}")
                key = (start, record.publish_time)
                if key in seen and seen[key] != record.generation_mw:
                    raise ValueError(f"{name}: conflicting duplicate {key}")
                seen[key] = record.generation_mw
        if not self.metadata.get("retrieved_at") or not self.metadata.get("sources"):
            raise ValueError("snapshot must include retrieval time and sources")
        return self


class HourRow(BaseModel):
    start_time: datetime
    forecast_mw: float | None
    actual_mw: float | None
    publish_time: datetime | None
    error_mw: float | None


class Metrics(BaseModel):
    mae_mw: float | None
    rmse_mw: float | None
    bias_mw: float | None
    p90_absolute_error_mw: float | None
    overforecast_mwh: float | None
    matched_hours: int
    expected_hours: int
    coverage_pct: float


class DaySummary(BaseModel):
    decision_date: date
    delivery_date: date
    mae_mw: float | None
    bias_mw: float | None
    coverage_pct: float


class Analysis(BaseModel):
    decision_date: date
    delivery_date: date
    cutoff: str
    cutoff_at: datetime
    rows: list[HourRow]
    metrics: Metrics
    month_metrics: Metrics
    days: list[DaySummary]
    metadata: dict


def cutoff_time(decision_date: date, cutoff: str) -> datetime:
    if not FIRST_DECISION <= decision_date <= LAST_DECISION:
        raise ValueError("decision_date must be between 2026-01-01 and 2026-01-31 inclusive")
    try:
        if (
            len(cutoff) != 5
            or cutoff[2] != ":"
            or not (
                cutoff[:2].isascii()
                and cutoff[:2].isdigit()
                and cutoff[3:].isascii()
                and cutoff[3:].isdigit()
            )
        ):
            raise ValueError
        hour, minute = map(int, cutoff.split(":"))
        local_time = time(hour, minute)
    except ValueError as exc:
        raise ValueError("cutoff must be a valid HH:MM London time") from exc
    return datetime.combine(decision_date, local_time, LONDON).astimezone(UTC)


def calculate_metrics(rows: list[HourRow]) -> Metrics:
    errors = [row.error_mw for row in rows if row.error_mw is not None]
    n = len(errors)
    if not n:
        return Metrics(
            mae_mw=None,
            rmse_mw=None,
            bias_mw=None,
            p90_absolute_error_mw=None,
            overforecast_mwh=None,
            matched_hours=0,
            expected_hours=len(rows),
            coverage_pct=0,
        )
    absolute = sorted(abs(error) for error in errors)
    position = (n - 1) * 0.9
    low, high = math.floor(position), math.ceil(position)
    p90 = absolute[low] + (absolute[high] - absolute[low]) * (position - low)
    return Metrics(
        mae_mw=sum(absolute) / n,
        rmse_mw=math.sqrt(sum(error**2 for error in errors) / n),
        bias_mw=sum(errors) / n,
        p90_absolute_error_mw=p90,
        overforecast_mwh=sum(max(error, 0) for error in errors),
        matched_hours=n,
        expected_hours=len(rows),
        coverage_pct=100 * n / len(rows),
    )


class Analyzer:
    def __init__(self, snapshot: Snapshot) -> None:
        self.snapshot = snapshot
        self.forecasts: dict[datetime, list[Record]] = defaultdict(list)
        self.actuals: dict[datetime, Record] = {}
        for record in snapshot.forecasts:
            self.forecasts[record.start_time].append(record)
        for records in self.forecasts.values():
            records.sort(key=lambda record: record.publish_time)
        for record in snapshot.actuals:
            previous = self.actuals.get(record.start_time)
            if previous is None or record.publish_time > previous.publish_time:
                self.actuals[record.start_time] = record

    def rows_for_day(self, decision: date, cutoff: str) -> list[HourRow]:
        cutoff_at = cutoff_time(decision, cutoff)
        start = datetime.combine(decision + timedelta(days=1), time(), LONDON).astimezone(UTC)
        rows = []
        for hour in range(24):
            target = start + timedelta(hours=hour)
            eligible = [
                record
                for record in self.forecasts.get(target, [])
                if record.publish_time <= cutoff_at
            ]
            forecast = eligible[-1] if eligible else None
            halves = [self.actuals.get(target + timedelta(minutes=m)) for m in (0, 30)]
            actual = (
                sum(record.generation_mw for record in halves) / 2
                if all(record is not None and record.generation_mw is not None for record in halves)
                else None
            )
            value = forecast.generation_mw if forecast else None
            rows.append(
                HourRow(
                    start_time=target,
                    forecast_mw=value,
                    actual_mw=actual,
                    publish_time=forecast.publish_time if forecast else None,
                    error_mw=value - actual if value is not None and actual is not None else None,
                )
            )
        return rows

    def analysis(self, decision: date, cutoff: str) -> Analysis:
        cutoff_at = cutoff_time(decision, cutoff)
        month_rows: list[HourRow] = []
        days = []
        selected: list[HourRow] = []
        for offset in range(31):
            day = FIRST_DECISION + timedelta(days=offset)
            rows = self.rows_for_day(day, cutoff)
            metrics = calculate_metrics(rows)
            month_rows.extend(rows)
            if day == decision:
                selected = rows
            days.append(
                DaySummary(
                    decision_date=day,
                    delivery_date=day + timedelta(days=1),
                    mae_mw=metrics.mae_mw,
                    bias_mw=metrics.bias_mw,
                    coverage_pct=metrics.coverage_pct,
                )
            )
        return Analysis(
            decision_date=decision,
            delivery_date=decision + timedelta(days=1),
            cutoff=cutoff,
            cutoff_at=cutoff_at,
            rows=selected,
            metrics=calculate_metrics(selected),
            month_metrics=calculate_metrics(month_rows),
            days=days,
            metadata={
                **self.snapshot.metadata,
                "timezone": "Europe/London",
                "cutoff_assumption": (
                    "Configurable business assumption; not a verified market deadline"
                ),
                "forecast_selection": (
                    "Latest publication per target with publishTime <= decision cutoff"
                ),
                "actual_aggregation": "Arithmetic mean of exactly two FUELHH WIND half-hours",
                "error_sign": "forecast minus actual",
                "percentile_method": "Linear interpolation at (n-1)*0.90",
                "missing_data": "Null; never zero-filled; metrics use matched hours only",
                "actual_revision_policy": "Latest retrieved publication per half-hour",
                "scope": "Elexon WINDFOR forecasts compared with FUELHH WIND outturn",
                "data_scope_warning": (
                    "Not total GB wind generation. Elexon describes WINDFOR as forecasting "
                    "wind farms visible to NESO with operational metering and explicitly "
                    "compares it with Generation by Fuel Type outturn. FUELHH excludes "
                    "embedded generation and wind farms without operational meters. "
                    "The observed positive bias alone does not establish a scope mismatch "
                    "or its cause."
                ),
                "scope_documentation": ["https://bmrs.elexon.co.uk/static/js/main.8ee28d09.js"],
            },
        )

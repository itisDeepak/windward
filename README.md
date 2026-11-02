# Windward

A small web app that shows a UK energy buyer which wind forecast was available when they had to decide on day-ahead power, and how far off those forecasts turned out to be.

It only uses two Elexon datasets (national level, Great Britain):

- `FUELHH`, filtered to `WIND`, for actual generation
- `WINDFOR` for wind forecasts

Scope is purchase decisions made in January 2026 (1-31 Jan), which cover deliveries from 2 Jan to 1 Feb 2026.

- Live app: _add Vercel URL_
- Demo video: _add YouTube URL_

## What it does

- Pick a decision date and a cutoff time (Europe/London, default 10:00).
- For each hour of the next day, use the latest forecast published at or before the cutoff.
- Compare it with the actual generation and show MAE, RMSE, bias, 90th percentile absolute error and overforecast MWh.
- Show the same numbers for the whole month, plus matched/expected hours so gaps are visible.
- Hourly and daily tables, charts and a CSV export.

The 10:00 cutoff is my assumption, not an official gate closure. It can be changed in the UI.

## Stack

- Backend: Python, FastAPI
- Frontend: React, TypeScript, Vite, Recharts
- Docker for local runs, Vercel for hosting

## Running it

### Docker

```powershell
docker compose up --build
```

Then open http://localhost:8000. API docs are at `/docs`, health check at `/api/health`.

### Without Docker

Needs Python 3.11+, [uv](https://docs.astral.sh/uv/) and Node 22.

```powershell
# terminal 1
cd backend
uv sync --frozen
uv run uvicorn app.main:app --reload

# terminal 2
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to port 8000. For a production-style run, `npm run build` in `frontend` and FastAPI will serve `frontend/dist` itself.

### Lint and type check

```powershell
cd backend
uv run ruff check .
```

`npm run build` in `frontend` also type-checks the frontend.

## Environment variables

Nothing is required. See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Port used inside the Docker image |
| `WIND_SNAPSHOT_PATH` | `backend/data/snapshot.json` | Alternative snapshot file |

There are no API keys: the Elexon data is public and already saved in the repo.

## Deploying to Vercel

The whole app is one Vercel project (FastAPI function plus the built frontend), not the Docker image.

```powershell
npx vercel login
npx vercel          # preview
npx vercel --prod
```

Or import the GitHub repo in the Vercel dashboard. Keep the root directory at the repo root.

## Project layout

```text
backend/
  app/
    main.py          API routes and static file serving
    domain.py        forecast selection, hourly alignment, metrics
    acquire.py       downloads Elexon data into the snapshot
  data/snapshot.json saved Elexon data for the evaluation window
frontend/
  src/main.tsx       dashboard
  src/styles.css
Dockerfile           multi-stage build (Node build, Python runtime)
compose.yaml
main.py              Vercel entrypoint
pyproject.toml       Vercel entrypoint and build command
requirements.txt     runtime dependencies for Vercel
vercel.json          files to bundle with the function
.env.example
```

API endpoints:

- `GET /api/analysis?decision_date=2026-01-15&cutoff=10:00`
- `GET /api/export?decision_date=2026-01-15&cutoff=10:00` (CSV)
- `GET /api/health`

## How the numbers are calculated

**Forecast choice.** For decision date D the delivery day is D+1. Each delivery hour uses the forecast with the latest `publishTime` that is not after the cutoff on D. Later forecasts are ignored even if they are more accurate, otherwise the evaluation would look better than what a buyer could actually have seen.

**Actuals.** `FUELHH` is half-hourly and `WINDFOR` is hourly, so each hourly actual is the mean of its two half-hours. If either half-hour is missing, the hour is left out rather than filled with zero.

**Errors.** `error = forecast - actual`, so a positive error means the forecast was too high.

| Metric | Definition |
|---|---|
| MAE | mean of `abs(error)` |
| RMSE | square root of mean of `error^2` |
| Bias | mean of `error` |
| P90 absolute error | 90th percentile of `abs(error)` |
| Overforecast energy | sum of positive errors, in MWh |
| Coverage | matched hours / expected hours |

Month figures pool the hourly errors instead of averaging the daily metrics. I left out MAPE because actual wind can get close to zero.

**Snapshot.** The data was downloaded once (`cd backend; uv run python -m app.acquire`) and saved in `backend/data/snapshot.json`. All forecast versions are kept so the cutoff can be applied later. At the default cutoff all 744 delivery hours match; month MAE is roughly 2,000 MW and bias is positive (forecasts higher than actuals).

## Limitations

- Elexon covers Great Britain, not the whole UK, and may not include all embedded wind.
- This is national wind only. Demand, contracts, prices and other generation are not included, so it does not give a procurement quantity.
- Month metrics are looked at in hindsight; they are not a guarantee of future accuracy.
- Actuals are as downloaded and may have been revised since.

## AI usage

I used AI tools (GitHub Copilot) while building this: for planning, writing code and docs. I reviewed and checked the result myself.

## Data

Data comes from the [Elexon Insights API](https://bmrs.elexon.co.uk/api-documentation) ([FUELHH](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream), [WINDFOR](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream)). This project is not affiliated with Elexon.

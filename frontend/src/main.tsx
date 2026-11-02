import React, { useEffect, useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart,
} from 'recharts'
import { ArrowDownToLine, ArrowUpRight, CalendarDays, Check, ChevronRight, Clock3, Info, Leaf, Menu, Wind } from 'lucide-react'
import './styles.css'

type Metrics = {
  mae_mw: number | null; rmse_mw: number | null; bias_mw: number | null
  p90_absolute_error_mw: number | null; overforecast_mwh: number | null
  matched_hours: number; expected_hours: number; coverage_pct: number
}
type Row = {
  start_time: string; forecast_mw: number | null; actual_mw: number | null
  publish_time: string | null; error_mw: number | null
}
type Analysis = {
  decision_date: string; delivery_date: string; cutoff: string; cutoff_at: string
  rows: Row[]; metrics: Metrics; month_metrics: Metrics
  days: { decision_date: string; delivery_date: string; mae_mw: number | null; bias_mw: number | null; coverage_pct: number }[]
  metadata: { retrieved_at: string; sources: string[]; data_scope_warning?: string }
}

const number = (value: number | null | undefined, digits = 0) =>
  value == null ? 'Not available' : value.toLocaleString('en-GB', { maximumFractionDigits: digits })
const dateLabel = (value: string) =>
  new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' })
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })

function App() {
  const [decisionDate, setDecisionDate] = useState('2026-01-15')
  const [cutoff, setCutoff] = useState('10:00')
  const [data, setData] = useState<Analysis | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'overview' | 'accuracy' | 'methodology'>('overview')
  const [showTable, setShowTable] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const gradientId = useId().replaceAll(':', '')
  const query = new URLSearchParams({ decision_date: decisionDate, cutoff }).toString()

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setData(null)
    fetch(`/api/analysis?${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          const detail: { detail?: unknown } = await response.json().catch(() => ({}))
          throw new Error(typeof detail.detail === 'string' ? detail.detail : `Analysis unavailable (${response.status}). Check the data snapshot and backend logs.`)
        }
        return response.json() as Promise<Analysis>
      })
      .then(setData)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load analysis.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, attempt])

  const chartRows = data?.rows.map(row => ({ ...row, hour: row.start_time.slice(11, 16) })) ?? []
  const paired = data?.rows.filter(row => row.forecast_mw !== null && row.actual_mw !== null) ?? []
  const forecastEnergy = data?.rows.some(row => row.forecast_mw !== null)
    ? data.rows.reduce((total, row) => total + (row.forecast_mw ?? 0), 0) : null
  const forecastHours = data?.rows.filter(row => row.forecast_mw !== null).length ?? 0
  const days = data?.days.map(day => ({ ...day, day: day.decision_date.slice(-2) })) ?? []

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <a href="/" className="brand"><span className="brand-icon"><Wind size={25} /></span>windward<span className="brand-dot">.</span></a>
      <div className="workspace"><span className="workspace-mark">GB</span><div>Great Britain<span>Wind forecasts</span></div><ChevronRight size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => { setTab('overview'); setMobileNav(false) }}><Wind size={18} />Wind overview<ChevronRight size={15} /></button>
        <button className={tab === 'accuracy' ? 'active' : ''} onClick={() => { setTab('accuracy'); setMobileNav(false) }}><CalendarDays size={18} />Forecast accuracy</button>
        <button className={tab === 'methodology' ? 'active' : ''} onClick={() => { setTab('methodology'); setMobileNav(false) }}><Info size={18} />Methodology & sources</button>
      </nav>
      <div className="pilot-card"><Leaf size={22} /><h3>A clearer view of tomorrow.</h3><p>Wind intelligence for more informed day-ahead decisions.</p><span>JANUARY 2026 PILOT <ArrowUpRight size={14} /></span></div>
      <div className="sidebar-footer"><span className="source-dot" />Elexon Insights data<span>Public, read-only data</span></div>
    </aside>

    <div className="main-shell">
      <header className="topbar">
        <button className="mobile-toggle" aria-label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)}><Menu /></button>
        <div className="breadcrumb">Workspace <ChevronRight size={13} /><span>{tab === 'overview' ? 'Wind overview' : tab === 'accuracy' ? 'Forecast accuracy' : 'Methodology & sources'}</span></div>
        <div className="topbar-right"><span className="pilot-badge">PILOT</span><span className="avatar">GB</span></div>
      </header>
      <main>
        <div className="page-heading">
          <div>          <div className="eyebrow">DAY-AHEAD WIND FORECASTS</div><h1>{tab === 'overview' ? 'Latest forecast at decision time' : tab === 'accuracy' ? 'Forecast accuracy' : 'Method and data'}</h1>
                    <p>{tab === 'overview' ? 'Wind forecast available at the chosen cutoff, compared with actual generation.' : tab === 'accuracy' ? 'Forecast error for the selected day and for the full month.' : 'Data sources, assumptions and limitations.'}</p></div>
          <span className="national-badge"><span />GB national wind</span>
        </div>

        <section className="filter-bar" aria-label="Analysis controls">
          <label><span>Purchase decision date</span><div><CalendarDays size={17} /><input aria-label="Purchase decision date" type="date" min="2026-01-01" max="2026-01-31" value={decisionDate} onChange={event => { if (event.target.value >= '2026-01-01' && event.target.value <= '2026-01-31') setDecisionDate(event.target.value) }} /></div></label>
          <label><span>Decision cutoff <span className="muted">(London)</span></span><div><Clock3 size={17} /><input aria-label="Decision cutoff London time" type="time" value={cutoff} onChange={event => { if (event.target.value) setCutoff(event.target.value) }} /></div></label>
          <div className="delivery"><span>Delivery day</span><strong>{data ? dateLabel(data.delivery_date) : 'Next calendar day'}</strong></div>
          <a className={`export-button ${!data || loading ? 'disabled' : ''}`} href={data && !loading ? `/api/export?${query}` : undefined} aria-disabled={!data || loading}><ArrowDownToLine size={16} />Export CSV</a>
        </section>

        <div className="assumption-note"><Info size={15} /><span><strong>Decision-time view.</strong> Latest forecast per delivery hour, published at or before {cutoff} on the decision date. Cutoff is a pilot assumption, not a confirmed auction deadline.</span></div>
        {loading && <div className="state-card" role="status"><span className="spinner" /><h2>Building your decision-time view</h2><p>Matching forecast vintages with observed wind generation.</p></div>}
        {error && <div className="state-card error" role="alert"><Info size={28} /><h2>We couldn't load the analysis</h2><p>{error}</p><button className="primary-button" onClick={() => setAttempt(attempt + 1)}>Try again</button></div>}

        {data && !loading && tab !== 'methodology' && <>
          {data.metrics.coverage_pct < 100 && <div className="warning" role="status">Incomplete coverage: {data.metrics.matched_hours} of {data.metrics.expected_hours} hours can be evaluated. Missing values are excluded, never treated as zero.</div>}
          <section className="metric-grid" aria-label="Key metrics">
            <Metric title={tab === 'overview' ? 'Forecast wind energy' : 'Mean absolute error'} value={number(tab === 'overview' ? forecastEnergy === null ? null : forecastEnergy / 1000 : data.month_metrics.mae_mw, 1)} unit={tab === 'overview' ? 'GWh' : 'MW'} subtitle={tab === 'overview' ? `${forecastHours}/24 forecast hours on delivery day` : 'All January decision dates'} accent />
            <Metric title="Mean absolute error" value={number(data.metrics.mae_mw)} unit="MW" subtitle="Selected day · average error magnitude" />
            <Metric title="Forecast bias" value={data.metrics.bias_mw == null ? 'Not available' : `${data.metrics.bias_mw > 0 ? '+' : ''}${number(data.metrics.bias_mw)}`} unit="MW" subtitle="Forecast minus actual · positive = overforecast" />
            <Metric title="Matched coverage" value={number(data.metrics.coverage_pct, 1)} unit="%" subtitle={`${data.metrics.matched_hours} of ${data.metrics.expected_hours} hourly pairs`} />
          </section>

          {tab === 'overview' ? <section className="panel generation-panel">
            <div className="panel-heading"><div><h2>Wind generation outlook</h2><p>{dateLabel(data.delivery_date)} <span className="dot-separator">/</span> Hourly average power · MW</p></div><div className="legend"><span><i className="forecast-line" />As-of forecast</span><span><i className="actual-line" />Actual generation</span></div></div>
            <div className="chart" role="img" aria-label="Hourly wind forecast and actual generation. Exact values are available in the data table below.">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 16, right: 18, bottom: 4, left: 4 }}>
                  <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f806a" stopOpacity={0.19} /><stop offset="100%" stopColor="#2f806a" stopOpacity={0.01} /></linearGradient></defs>
                  <CartesianGrid vertical={false} stroke="#edf0ed" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11, fill: '#78827d' }} tickLine={false} axisLine={false} interval={3} dy={10} />
                  <YAxis tick={{ fontSize: 11, fill: '#78827d' }} tickLine={false} axisLine={false} tickFormatter={value => number(Number(value))} width={60} />
                  <Tooltip formatter={(value, name) => [value == null ? 'Missing' : `${number(Number(value))} MW`, name]} contentStyle={{ borderRadius: 10, border: '1px solid #e1e7e2', fontSize: 12 }} />
                  <Area type="linear" dataKey="forecast_mw" name="As-of forecast" stroke="#28745d" strokeWidth={2.5} fill={`url(#${gradientId})`} connectNulls={false} />
                  <Line type="linear" dataKey="actual_mw" name="Actual generation" stroke="#b69456" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-footer"><span><Clock3 size={14} />All times Europe/London (GMT in January)</span><span>{paired.length} matched hourly observations</span></div>
          </section> : <section className="panel">
            <div className="panel-heading"><div><h2>How accurate was the decision-time forecast?</h2><p>Mean absolute error by purchase-decision date · January 2026</p></div><span className="small-tag">31 DECISIONS</span></div>
            <div className="chart" role="img" aria-label="Daily mean absolute error in megawatts; exact values in the daily results table."><ResponsiveContainer width="100%" height="100%"><BarChart data={days} margin={{ top: 16, right: 18, left: 4, bottom: 4 }}><CartesianGrid vertical={false} stroke="#edf0ed" /><XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} interval={2} /><YAxis width={60} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} /><Tooltip formatter={value => [`${number(Number(value))} MW`, 'MAE']} labelFormatter={label => `Decision: ${label} Jan`} /><ReferenceLine y={0} stroke="#dce4df" /><Bar dataKey="mae_mw" fill="#397d66" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
            <div className="chart-footer">Same cutoff applied to all 31 decisions. Incomplete days retain explicit coverage.</div>
          </section>}

          <div className="bottom-grid">
            <section className="panel risk-panel"><div className="section-kicker">ERROR SUMMARY</div><h2>{data.metrics.bias_mw == null ? 'More data is needed.' : data.metrics.bias_mw > 0 ? 'Wind was overforecast on average.' : data.metrics.bias_mw < 0 ? 'Wind was underforecast on average.' : 'No net directional bias.'}</h2><p>Overforecast wind can leave a buyer short of expected renewable output. Underforecast wind can lead to excess procurement. Neither metric is a purchase recommendation.</p><div className="risk-stats"><div><span>Root mean square error</span><strong>{number(data.metrics.rmse_mw)} <small>MW</small></strong></div><div><span>Overforecast energy</span><strong>{number(data.metrics.overforecast_mwh)} <small>MWh</small></strong></div></div><p className="footnote">RMSE highlights larger misses. Overforecast energy sums positive hourly errors, not net bias or required procurement.</p></section>
            <section className="panel confidence-panel"><div className="section-kicker">MONTH SUMMARY</div><h2>January decision benchmark</h2><p>For deliveries 2 January to 1 February 2026.</p><div className="benchmark-row"><span>Month MAE</span><strong>{number(data.month_metrics.mae_mw)} MW</strong></div><div className="benchmark-row"><span>Month RMSE</span><strong>{number(data.month_metrics.rmse_mw)} MW</strong></div><div className="benchmark-row"><span>90th percentile absolute error</span><strong>{number(data.month_metrics.p90_absolute_error_mw)} MW</strong></div><div className="benchmark-row"><span>Matched hours</span><strong>{data.month_metrics.matched_hours} / {data.month_metrics.expected_hours}</strong></div><div className="confidence-note"><Check size={15} />Publication-time filtering prevents lookahead.</div><p className="footnote">Retrospective descriptive benchmark, not a calibrated prediction interval or information available during January.</p></section>
          </div>

          <section className="panel table-panel"><button className="table-toggle" onClick={() => setShowTable(!showTable)} aria-expanded={showTable}><span><h2>{tab === 'overview' ? 'Explore the underlying data' : 'Daily evaluation results'}</h2><p>{tab === 'overview' ? 'Hourly values, selected publication times and signed errors' : 'Per-day accuracy and completeness for all January decisions'}</p></span><ChevronRight className={showTable ? 'rotated' : ''} size={20} /></button>
            {showTable && <div className="table-scroll">{tab === 'overview' ? <table><caption>Delivery {dateLabel(data.delivery_date)}. Power and errors in MW; timestamps in London time.</caption><thead><tr><th>Delivery hour</th><th>Forecast MW</th><th>Actual MW</th><th>Error MW</th><th>Forecast published</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.start_time}><td>{row.start_time.slice(11, 16)}</td><td>{number(row.forecast_mw, 1)}</td><td>{number(row.actual_mw, 1)}</td><td>{number(row.error_mw, 1)}</td><td>{row.publish_time ? timestamp(row.publish_time) : 'Not available'}</td></tr>)}</tbody></table> : <table><caption>January 2026 purchase-decision dates, evaluated at {cutoff} London time.</caption><thead><tr><th>Decision</th><th>Delivery</th><th>MAE MW</th><th>Bias MW</th><th>Coverage</th></tr></thead><tbody>{data.days.map(day => <tr key={day.decision_date}><td>{dateLabel(day.decision_date)}</td><td>{dateLabel(day.delivery_date)}</td><td>{number(day.mae_mw)}</td><td>{number(day.bias_mw)}</td><td>{number(day.coverage_pct, 1)}%</td></tr>)}</tbody></table>}</div>}
          </section>
        </>}

        {tab === 'methodology' && <section className="panel methodology">
          <div className="section-kicker">METHOD</div><h2>How the numbers are calculated</h2>
          <h3>1. Decision time</h3><p>For each decision date in January 2026, evaluate the next calendar day's 24 delivery hours. Include only forecasts with publication timestamps at or before the chosen cutoff in Europe/London, then select the latest available forecast for each hour.</p>
          <h3>2. Aligning forecasts and actuals</h3><p>Elexon WINDFOR provides forecast average power in MW. FUELHH WIND reports half-hourly average power. Each hourly actual is the arithmetic mean of both half-hours. If either half-hour is absent, the hourly actual is missing, not zero. This is Great Britain system-level data, not all of the UK and not the client's wind portfolio.</p>
          <h3>3. Error metrics</h3><p>Error = forecast - actual. MAE = mean absolute error; RMSE = square root of mean squared error; bias = mean signed error. The 90th percentile describes historical absolute errors. Metrics use matched hours only; coverage uses all expected hours. January metrics pool hourly pairs, rather than averaging daily metrics.</p>
          <h3>4. Limitations</h3><p>10:00 is an agreed pilot assumption, not a verified market gate closure. Historical actuals may have been revised since delivery. Snapshot retrieval time is not the original publication time. Full-month metrics are retrospective and must not be used as an ex-ante risk estimate for an earlier January decision. No demand, contracted positions, prices or other renewable sources are included; residual procurement cannot be calculated.</p>
          {data?.metadata.data_scope_warning && <p className="warning">{data.metadata.data_scope_warning}</p>}
          <h3>Sources</h3><ul><li><a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream" target="_blank" rel="noreferrer">Elexon FUELHH: generation by fuel type <ArrowUpRight size={13} /></a></li><li><a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream" target="_blank" rel="noreferrer">Elexon WINDFOR: wind generation forecasts <ArrowUpRight size={13} /></a></li></ul>
          <p>Only Elexon national wind data is used. This public research pilot is not a trading or financial advisory service.</p>
        </section>}
        <footer className="page-footer"><span>windward<span className="brand-dot">.</span> <span className="footer-divider">/</span> Better context. Informed decisions.</span><span>{data ? `Source snapshot retrieved ${timestamp(data.metadata.retrieved_at)}` : 'Elexon Insights · January 2026 pilot'}</span></footer>
      </main>
    </div>
  </div>
}

function Metric({ title, value, unit, subtitle, accent = false }: { title: string; value: string; unit: string; subtitle: string; accent?: boolean }) {
  return <article className={`metric-card ${accent ? 'metric-accent' : ''}`}><h2>{title}</h2><div className="metric-value">{value}<span>{value === 'Not available' ? '' : unit}</span></div><p>{subtitle}</p></article>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)

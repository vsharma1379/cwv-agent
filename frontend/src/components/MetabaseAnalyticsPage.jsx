import { useState } from 'react';
import axios from 'axios';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';

const API = '/api';

const PAGE_NAMES = [
  'companyReviews',
  'companyOverview',
  'companyJobs',
  'companySalaries',
  'companyInterviews',
  'companyBenefits',
  'companyPhotos',
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const LABEL_COLORS = { INP: '#ea4335', CLS: '#fbbc04' };

export default function MetabaseAnalyticsPage() {
  const [form, setForm] = useState({
    clickLabel: 'INP',
    entityIdFilter: 'null',
    pageName: 'companyReviews',
    fromDate: daysAgoStr(100),
    toDate: todayStr(),
  });
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const [fetched, setFetched] = useState(false);
  // Snapshot of params used for the last successful fetch — drives chart title/color
  const [fetchedParams, setFetchedParams] = useState(null);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleFetch = async () => {
    const snapshot = { ...form };
    setLoading(true);
    setError('');
    setData([]);
    setFetched(false);
    try {
      const { data: res } = await axios.post(`${API}/metabase-query`, snapshot);
      setData(res.data);
      setLastQuery(res.query);
      setFetchedParams(snapshot);
      setFetched(true);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const total = data.reduce((s, r) => s + r.count, 0);
  const avg = data.length ? Math.round(total / data.length) : 0;
  const max = data.length ? Math.max(...data.map(r => r.count)) : 0;
  const barColor = LABEL_COLORS[fetchedParams?.clickLabel] || '#4285F4';

  // True when the form has drifted from what's currently displayed
  const isStale = fetched && fetchedParams && (
    form.clickLabel !== fetchedParams.clickLabel ||
    form.entityIdFilter !== fetchedParams.entityIdFilter ||
    form.pageName !== fetchedParams.pageName ||
    form.fromDate !== fetchedParams.fromDate ||
    form.toDate !== fetchedParams.toDate
  );

  return (
    <div className="mb-page">
      <div className="mb-header">
        <h2 className="mb-title">CWV Analytics</h2>
        <p className="mb-subtitle">Query core web vitals data from the analytics database</p>
      </div>

      {/* Filter Form */}
      <div className="mb-form-card">
        <div className="mb-form-grid">
          <div className="mb-field">
            <label className="mb-label">Click Label</label>
            <div className="mb-segmented">
              {['INP', 'CLS'].map(v => (
                <button
                  key={v}
                  className={`mb-seg-btn ${form.clickLabel === v ? 'active' : ''}`}
                  style={form.clickLabel === v ? { background: LABEL_COLORS[v], borderColor: LABEL_COLORS[v], color: '#fff' } : {}}
                  onClick={() => set('clickLabel', v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-field">
            <label className="mb-label">Entity ID</label>
            <div className="mb-segmented">
              {[
                { value: 'null',     label: 'IS NULL' },
                { value: 'not_null', label: 'IS NOT NULL' },
                { value: 'any',      label: 'No Filter' },
              ].map(({ value, label }) => (
                <button
                  key={value}
                  className={`mb-seg-btn ${form.entityIdFilter === value ? 'active' : ''}`}
                  style={form.entityIdFilter === value && value === 'any'
                    ? { background: '#34a853', borderColor: '#34a853', color: '#fff' }
                    : {}}
                  onClick={() => set('entityIdFilter', value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-field">
            <label className="mb-label">Page Name</label>
            <div className="mb-input-row">
              <select
                className="mb-select"
                value={PAGE_NAMES.includes(form.pageName) ? form.pageName : '__custom__'}
                onChange={e => {
                  if (e.target.value !== '__custom__') set('pageName', e.target.value);
                }}
              >
                {PAGE_NAMES.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
              {!PAGE_NAMES.includes(form.pageName) || form.pageName === '' ? null : null}
            </div>
            {/* Custom input shown when typed */}
            <input
              className="mb-input"
              style={{ marginTop: 6 }}
              placeholder="Or type a custom page name"
              value={PAGE_NAMES.includes(form.pageName) ? '' : form.pageName}
              onChange={e => set('pageName', e.target.value)}
            />
          </div>

          <div className="mb-field">
            <label className="mb-label">Date Range</label>
            <div className="mb-date-row">
              <div className="mb-date-group">
                <span className="mb-date-label">From</span>
                <input
                  type="date"
                  className="mb-input"
                  value={form.fromDate}
                  max={form.toDate}
                  onChange={e => set('fromDate', e.target.value)}
                />
              </div>
              <span className="mb-date-sep">→</span>
              <div className="mb-date-group">
                <span className="mb-date-label">To</span>
                <input
                  type="date"
                  className="mb-input"
                  value={form.toDate}
                  min={form.fromDate}
                  max={todayStr()}
                  onChange={e => set('toDate', e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="mb-run-btn"
            onClick={handleFetch}
            disabled={loading || !form.pageName}
          >
            {loading ? <><span className="mb-spinner" /> Running…</> : 'Run Query'}
          </button>
          {isStale && (
            <span className="mb-stale-badge">Filters changed — re-run to update</span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && <div className="error-banner" style={{ margin: '0 24px 16px' }}>{error}</div>}

      {/* Results */}
      {fetched && !loading && (
        <>
          {/* Summary cards */}
          <div className="mb-summary-row">
            <div className="mb-stat-card">
              <div className="mb-stat-label">Total Count</div>
              <div className="mb-stat-value">{total.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <div className="mb-stat-label">Daily Average</div>
              <div className="mb-stat-value">{avg.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <div className="mb-stat-label">Peak Day</div>
              <div className="mb-stat-value">{max.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <div className="mb-stat-label">Days</div>
              <div className="mb-stat-value">{data.length}</div>
            </div>
          </div>

          {data.length === 0 ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <p>No data found for the selected filters.</p>
            </div>
          ) : (
            <div className="mb-chart-card">
              <div className="mb-chart-header">
                <span className="mb-chart-title">
                  {fetchedParams.clickLabel} · {fetchedParams.pageName} · entityId{' '}
                  {fetchedParams.entityIdFilter === 'null' ? 'IS NULL' : fetchedParams.entityIdFilter === 'not_null' ? 'IS NOT NULL' : '(all)'}
                </span>
                <span className="mb-chart-range">{fetchedParams.fromDate} → {fetchedParams.toDate}</span>
              </div>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: '#5f6368' }}
                    tickLine={false}
                    angle={data.length > 10 ? -35 : 0}
                    textAnchor={data.length > 10 ? 'end' : 'middle'}
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#5f6368' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                    width={56}
                  />
                  <Tooltip
                    formatter={v => [v.toLocaleString(), 'Count']}
                    labelFormatter={d => `Date: ${d}`}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e0e0e0' }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} fill={barColor} fillOpacity={0.85} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* SQL query */}
          {lastQuery && (
            <details className="mb-query-details">
              <summary className="mb-query-summary">View SQL Query</summary>
              <pre className="mb-query-pre">{lastQuery}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

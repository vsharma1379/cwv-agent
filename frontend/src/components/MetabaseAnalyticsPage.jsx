import { useState } from 'react';
import axios from 'axios';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';

const API = '/api';


function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const LABEL_COLORS = { INP: '#ea4335', CLS: '#fbbc04' };

const DEVICE_TYPE_OPTIONS = ['WAP', 'WEB'];
const LOGIN_STATUS_OPTIONS = [
  { value: 1, label: 'Logged In' },
  { value: 0, label: 'Logged Out' },
];

function toggleArrayItem(arr, item) {
  return arr.includes(item) ? arr.filter(v => v !== item) : [...arr, item];
}

export default function MetabaseAnalyticsPage() {
  const [form, setForm] = useState({
    clickLabel: 'INP',
    entityIdFilter: 'any',
    pageName: 'companyReviews',
    fromDate: daysAgoStr(100),
    toDate: todayStr(),
    deviceTypes: [],
    loginStatuses: [],
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
    form.toDate !== fetchedParams.toDate ||
    JSON.stringify(form.deviceTypes) !== JSON.stringify(fetchedParams.deviceTypes) ||
    JSON.stringify(form.loginStatuses) !== JSON.stringify(fetchedParams.loginStatuses)
  );

  return (
    <div className="mb-page">
      <div className="mb-header">
        <div className="mb-header-inner">
          <div className="mb-header-badge"><span className="mb-header-dot" /> Live Analytics</div>
          <h2 className="mb-title">CWV Analytics</h2>
          <p className="mb-subtitle">Query core web vitals data from the analytics database</p>
        </div>
      </div>

      {/* Filter Form */}
      <div className="mb-form-card">
        <div className="mb-form-card-title">Query Filters</div>
        {/* Row 1: Click Label | Entity | Device Type | Login Status */}
        <div className="mb-filter-row">
          <div className="mb-filter-group">
            <label className="mb-label">🏷 Click Label</label>
            <div className="mb-segmented">
              {['INP', 'CLS'].map(v => (
                <button
                  key={v}
                  className={`mb-seg-btn ${form.clickLabel === v ? 'active' : ''}`}
                  style={form.clickLabel === v ? { background: LABEL_COLORS[v], color: '#fff' } : {}}
                  onClick={() => set('clickLabel', v)}
                >{v}</button>
              ))}
            </div>
          </div>

          <div className="mb-filter-divider" />

          <div className="mb-filter-group">
            <label className="mb-label">🔑 Entity</label>
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
                    ? { background: '#34a853', color: '#fff' } : {}}
                  onClick={() => set('entityIdFilter', value)}
                >{label}</button>
              ))}
            </div>
          </div>

          <div className="mb-filter-divider" />

          <div className="mb-filter-group">
            <label className="mb-label">📱 Device Type</label>
            <div className="mb-segmented">
              {DEVICE_TYPE_OPTIONS.map(v => (
                <button
                  key={v}
                  className={`mb-seg-btn ${form.deviceTypes.includes(v) ? 'active' : ''}`}
                  style={form.deviceTypes.includes(v) ? { background: '#4285f4', color: '#fff' } : {}}
                  onClick={() => set('deviceTypes', toggleArrayItem(form.deviceTypes, v))}
                >{v}</button>
              ))}
              <button
                className={`mb-seg-btn ${form.deviceTypes.length === 0 ? 'active' : ''}`}
                style={form.deviceTypes.length === 0 ? { background: '#9e9e9e', color: '#fff' } : {}}
                onClick={() => set('deviceTypes', [])}
              >All</button>
            </div>
          </div>

          <div className="mb-filter-divider" />

          <div className="mb-filter-group">
            <label className="mb-label">🔐 Login Status</label>
            <div className="mb-segmented">
              {LOGIN_STATUS_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  className={`mb-seg-btn ${form.loginStatuses.includes(value) ? 'active' : ''}`}
                  style={form.loginStatuses.includes(value) ? { background: '#34a853', color: '#fff' } : {}}
                  onClick={() => set('loginStatuses', toggleArrayItem(form.loginStatuses, value))}
                >{label}</button>
              ))}
              <button
                className={`mb-seg-btn ${form.loginStatuses.length === 0 ? 'active' : ''}`}
                style={form.loginStatuses.length === 0 ? { background: '#9e9e9e', color: '#fff' } : {}}
                onClick={() => set('loginStatuses', [])}
              >All</button>
            </div>
          </div>
        </div>

        {/* Row 2: Page Name | Date Range | Run Query */}
        <div className="mb-filter-row mb-filter-row--bottom">
          <div className="mb-filter-group mb-filter-group--page">
            <label className="mb-label">📄 Page Name</label>
            <input
              className="mb-input"
              placeholder="e.g. companyReviews"
              value={form.pageName}
              onChange={e => set('pageName', e.target.value)}
            />
          </div>

          <div className="mb-filter-divider" />

          <div className="mb-filter-group">
            <label className="mb-label">📅 Date Range</label>
            <div className="mb-date-inline">
              <div className="mb-date-inline-group">
                <span className="mb-date-label">From</span>
                <input type="date" className="mb-input mb-date-input"
                  value={form.fromDate} max={form.toDate}
                  onChange={e => set('fromDate', e.target.value)} />
              </div>
              <span className="mb-date-sep">→</span>
              <div className="mb-date-inline-group">
                <span className="mb-date-label">To</span>
                <input type="date" className="mb-input mb-date-input"
                  value={form.toDate} min={form.fromDate} max={todayStr()}
                  onChange={e => set('toDate', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="mb-filter-divider" />

          <div className="mb-filter-group mb-filter-group--btn">
            <label className="mb-label" style={{ visibility: 'hidden' }}>Run</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="mb-run-btn" onClick={handleFetch} disabled={loading || !form.pageName}>
                {loading ? <><span className="mb-spinner" /> Running…</> : <>▶ Run Query</>}
              </button>
              {isStale && <span className="mb-stale-badge">Filters changed</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && <div className="error-banner" style={{ margin: '0 24px 16px' }}>{error}</div>}

      {/* Results */}
      {fetched && !loading && (
        <div className="mb-results">
          {/* Summary cards */}
          <div className="mb-summary-row">
            <div className="mb-stat-card">
              <span className="mb-stat-icon">📊</span>
              <div className="mb-stat-label">Total Count</div>
              <div className="mb-stat-value">{total.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <span className="mb-stat-icon">📈</span>
              <div className="mb-stat-label">Daily Average</div>
              <div className="mb-stat-value">{avg.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <span className="mb-stat-icon">🔥</span>
              <div className="mb-stat-label">Peak Day</div>
              <div className="mb-stat-value">{max.toLocaleString()}</div>
            </div>
            <div className="mb-stat-card">
              <span className="mb-stat-icon">🗓</span>
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
                  <span className="mb-chart-title-dot" style={{ background: barColor }} />
                  {fetchedParams.clickLabel} · {fetchedParams.pageName} · Entity{' '}
                  {fetchedParams.entityIdFilter === 'null' ? 'IS NULL' : fetchedParams.entityIdFilter === 'not_null' ? 'IS NOT NULL' : '(all)'}
                  {` · ${fetchedParams.deviceTypes?.length ? fetchedParams.deviceTypes.join('+') : 'All devices'}`}
                  {` · ${fetchedParams.loginStatuses?.length ? fetchedParams.loginStatuses.map(s => s === 1 ? 'LoggedIn' : 'LoggedOut').join('+') : 'All users'}`}
                </span>
                <span className="mb-chart-range">📅 {fetchedParams.fromDate} → {fetchedParams.toDate}</span>
              </div>
              <div className="mb-chart-body">
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
                      contentStyle={{ fontSize: 12, borderRadius: 10, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.12)' }}
                      cursor={{ fill: 'rgba(66,133,244,0.06)' }}
                    />
                    <Bar dataKey="count" radius={[5, 5, 0, 0]} fill={barColor} fillOpacity={0.88} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* SQL query */}
          {lastQuery && (
            <div className="mb-query-details">
              <div className="mb-query-summary">🔍 SQL Query</div>
              <pre className="mb-query-pre">{lastQuery}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

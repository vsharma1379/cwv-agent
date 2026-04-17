import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

const API = '/api';

const METRICS = [
  { key: 'lcp', label: 'LCP', color: '#4285F4', unit: 's',  threshold: { good: 2.5, poor: 4.0 },
    parse: v => v ? parseFloat(v) : null },   // stored as "2.5s" → strip unit
  { key: 'inp', label: 'INP', color: '#ea4335', unit: 'ms', threshold: { good: 200, poor: 500 },
    parse: v => v ? parseInt(v) : null },     // stored as "180ms"
  { key: 'cls', label: 'CLS', color: '#fbbc04', unit: '',   threshold: { good: 0.1, poor: 0.25 },
    parse: v => v ? parseFloat(v) : null },   // stored as "0.05"
];

function parseVal(raw) {
  if (!raw || raw === '—') return null;
  // strip any trailing unit letters so parseFloat/parseInt work cleanly
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

export default function GSCTrendChart({ siteUrl, urlPattern, device, status, onClose }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeMetrics, setActiveMetrics] = useState(['lcp', 'inp', 'cls']);

  useEffect(() => {
    setLoading(true);
    setError('');
    axios.get(`${API}/cwv-db/trend`, { params: { siteUrl, urlPattern, device, status } })
      .then(({ data: rows }) => {
        setData(rows.map(r => ({
          date: r.gsc_date,
          population: r.population,
          lcp: parseVal(r.lcp),
          inp: parseVal(r.inp),
          cls: parseVal(r.cls),
        })));
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [siteUrl, urlPattern, device, status]);

  const statusColor = { good: '#1e8e3e', 'needs-improvement': '#f29900', poor: '#d93025' };
  const statusLabel = { good: 'Good', 'needs-improvement': 'Needs Improvement', poor: 'Poor' };

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-modal" onClick={e => e.stopPropagation()}>
        <div className="history-header">
          <div>
            <h3 className="history-title">Daily Trend</h3>
            <p className="history-pattern">{urlPattern}</p>
            <p className="history-sub">
              {device} ·{' '}
              <span style={{ color: statusColor[status] }}>{statusLabel[status]}</span>
              {data.length > 0 && <span style={{ color: '#9aa0a6' }}> · {data.length} data point{data.length !== 1 ? 's' : ''}</span>}
            </p>
          </div>
          <button className="history-close" onClick={onClose}>✕</button>
        </div>

        {loading && (
          <div className="loading-state" style={{ padding: 40 }}>
            <div className="spinner" /><p>Loading trend data...</p>
          </div>
        )}
        {error && <div className="error-banner" style={{ margin: 16 }}>{error}</div>}

        {!loading && !error && data.length > 0 && (
          <>
            <div className="history-metric-toggles">
              {METRICS.map(({ key, label, color }) => (
                <button
                  key={key}
                  className={`metric-toggle ${activeMetrics.includes(key) ? 'on' : 'off'}`}
                  onClick={() => setActiveMetrics(prev =>
                    prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
                  )}
                >
                  <span className="toggle-dot" style={{ background: activeMetrics.includes(key) ? color : '#ccc' }} />
                  {label}
                </button>
              ))}
            </div>

            {METRICS.filter(m => activeMetrics.includes(m.key)).map(({ key, label, color, unit, threshold }) => {
              const vals = data.map(d => d[key]).filter(v => v != null);
              const dMin = vals.length ? Math.min(...vals) : 0;
              const dMax = vals.length ? Math.max(...vals) : threshold.poor;
              // Pad by at least 15% of the value or the full range if values are identical
              const range = dMax - dMin;
              const pad = range > 0 ? range * 0.4 : Math.max(dMax * 0.15, 1);
              const yDomain = [Math.max(0, Math.floor(dMin - pad)), Math.ceil(dMax + pad)];

              return (
                <div key={key} className="history-chart-block">
                  <div className="chart-metric-label" style={{ color }}>{label}</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9aa0a6' }} tickLine={false} />
                      <YAxis
                        domain={yDomain}
                        tick={{ fontSize: 11, fill: '#9aa0a6' }}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={v => `${v}${unit}`}
                        width={52}
                      />
                      <Tooltip
                        formatter={v => v != null ? [`${v}${unit}`, label] : ['—', label]}
                        labelFormatter={d => `Date: ${d}`}
                        labelStyle={{ fontWeight: 600, fontSize: 12 }}
                        contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e0e0e0' }}
                      />
                      <ReferenceLine y={threshold.good} stroke="#1e8e3e" strokeDasharray="4 2"
                        label={{ value: 'Good', fontSize: 10, fill: '#1e8e3e', position: 'right' }} />
                      <ReferenceLine y={threshold.poor} stroke="#d93025" strokeDasharray="4 2"
                        label={{ value: 'Poor', fontSize: 10, fill: '#d93025', position: 'right' }} />
                      <Line
                        type="monotone" dataKey={key} stroke={color} strokeWidth={2}
                        dot={{ r: 4, fill: color }} activeDot={{ r: 6 }} connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })}

            {/* Population trend */}
            <div className="history-chart-block">
              <div className="chart-metric-label" style={{ color: '#9aa0a6' }}>URL Group Size</div>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={data} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9aa0a6' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#9aa0a6' }} tickLine={false} axisLine={false}
                    tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : v} width={52} />
                  <Tooltip
                    formatter={v => [v?.toLocaleString(), 'URLs']}
                    labelFormatter={d => `Date: ${d}`}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e0e0e0' }}
                  />
                  <Line type="monotone" dataKey="population" stroke="#9aa0a6" strokeWidth={1.5}
                    dot={{ r: 2, fill: '#9aa0a6' }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="empty-state" style={{ padding: 40 }}>
            <p>No trend data yet — needs at least 2 days of scraped data.</p>
          </div>
        )}
      </div>
    </div>
  );
}

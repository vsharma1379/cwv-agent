import { useState } from 'react';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

const API = '/api';

const METRICS = [
  {
    key: 'lcp', label: 'LCP', color: '#4285F4', unit: 'ms',
    threshold: { good: 2500, poor: 4000 },
    format: v => v != null ? `${(v / 1000).toFixed(2)}s` : '—',
    yFormat: v => `${(v / 1000).toFixed(1)}s`,
  },
  {
    key: 'inp', label: 'INP', color: '#ea4335', unit: 'ms',
    threshold: { good: 200, poor: 500 },
    format: v => v != null ? `${v}ms` : '—',
    yFormat: v => `${v}ms`,
  },
  {
    key: 'cls', label: 'CLS', color: '#fbbc04', unit: '',
    threshold: { good: 0.1, poor: 0.25 },
    format: v => v != null ? v.toFixed(3) : '—',
    yFormat: v => v.toFixed(2),
  },
];

const FORM_FACTORS = [
  { value: '', label: 'All' },
  { value: 'PHONE', label: 'Mobile' },
  { value: 'DESKTOP', label: 'Desktop' },
];

export default function URLSpeedPage() {
  const [inputUrl, setInputUrl] = useState('');
  const [formFactor, setFormFactor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const fetchData = async () => {
    const url = inputUrl.trim();
    if (!url) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const { data } = await axios.get(`${API}/crux-history`, { params: { url, formFactor: formFactor || undefined } });
      setResult(data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = e => { if (e.key === 'Enter') fetchData(); };

  const latestPoint = result?.points?.at(-1);

  return (
    <div style={{ maxWidth: 900, margin: '32px auto', padding: '0 24px' }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20, color: '#202124' }}>URL Page Speed (CrUX)</h2>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          type="url"
          placeholder="https://www.ambitionbox.com/..."
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1, padding: '10px 14px', fontSize: 14, borderRadius: 8,
            border: '1px solid #dadce0', outline: 'none', fontFamily: 'inherit',
          }}
        />
        <div style={{ display: 'flex', border: '1px solid #dadce0', borderRadius: 8, overflow: 'hidden' }}>
          {FORM_FACTORS.map(ff => (
            <button
              key={ff.value}
              onClick={() => setFormFactor(ff.value)}
              style={{
                padding: '10px 16px', fontSize: 13, cursor: 'pointer', border: 'none',
                background: formFactor === ff.value ? '#4285F4' : '#fff',
                color: formFactor === ff.value ? '#fff' : '#5f6368',
                fontWeight: formFactor === ff.value ? 600 : 400,
                transition: 'all 0.15s',
              }}
            >
              {ff.label}
            </button>
          ))}
        </div>
        <button
          onClick={fetchData}
          disabled={loading || !inputUrl.trim()}
          style={{
            padding: '10px 22px', fontSize: 14, fontWeight: 600, borderRadius: 8,
            border: 'none', background: '#4285F4', color: '#fff', cursor: 'pointer',
            opacity: loading || !inputUrl.trim() ? 0.6 : 1,
          }}
        >
          {loading ? 'Loading…' : 'Fetch'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, background: '#fce8e6',
          color: '#c5221f', fontSize: 13, marginBottom: 24,
        }}>
          {error}
        </div>
      )}

      {result && (
        <>
          {/* Header */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: '#5f6368', marginBottom: 4 }}>
              {result.url} &middot; {result.formFactor || 'ALL'} &middot; {result.points.length} weekly data points
            </div>
            {latestPoint && (
              <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                {METRICS.map(m => {
                  const v = latestPoint[m.key];
                  const status = v == null ? null
                    : v <= m.threshold.good ? 'good'
                    : v <= m.threshold.poor ? 'needs-improvement'
                    : 'poor';
                  const statusColor = { good: '#1e8e3e', 'needs-improvement': '#f29900', poor: '#d93025' };
                  return (
                    <div key={m.key} style={{
                      padding: '8px 14px', borderRadius: 8, background: '#f8f9fa',
                      display: 'flex', flexDirection: 'column', gap: 2,
                    }}>
                      <span style={{ fontSize: 11, color: '#9aa0a6', fontWeight: 600 }}>{m.label} (latest)</span>
                      <span style={{
                        fontSize: 18, fontWeight: 700,
                        color: status ? statusColor[status] : '#202124',
                      }}>
                        {m.format(v)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Charts */}
          {METRICS.map(({ key, label, color, threshold, format, yFormat }) => {
            const vals = result.points.map(p => p[key]).filter(v => v != null);
            if (!vals.length) return null;
            const dMin = Math.min(...vals);
            const dMax = Math.max(...vals);
            const range = dMax - dMin;
            const pad = range > 0 ? range * 0.4 : Math.max(dMax * 0.15, 1);
            const yDomain = [Math.max(0, dMin - pad), dMax + pad];

            return (
              <div key={key} style={{
                marginBottom: 28, padding: '16px 20px', borderRadius: 12,
                border: '1px solid #e8eaed', background: '#fff',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 12 }}>{label}</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={result.points} margin={{ top: 8, right: 32, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: '#9aa0a6' }}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={yDomain}
                      tick={{ fontSize: 11, fill: '#9aa0a6' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={yFormat}
                      width={56}
                    />
                    <Tooltip
                      formatter={(v) => [format(v), label]}
                      labelFormatter={d => `Week ending ${d}`}
                      labelStyle={{ fontWeight: 600, fontSize: 12 }}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e0e0e0' }}
                    />
                    <ReferenceLine y={threshold.good} stroke="#1e8e3e" strokeDasharray="4 2"
                      label={{ value: 'Good', fontSize: 10, fill: '#1e8e3e', position: 'right' }} />
                    <ReferenceLine y={threshold.poor} stroke="#d93025" strokeDasharray="4 2"
                      label={{ value: 'Poor', fontSize: 10, fill: '#d93025', position: 'right' }} />
                    <Line
                      type="monotone" dataKey={key} stroke={color} strokeWidth={2}
                      dot={{ r: 3, fill: color }} activeDot={{ r: 5 }} connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </>
      )}

      {!loading && !error && !result && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#9aa0a6', fontSize: 14 }}>
          Enter a URL above to see its Core Web Vitals trend over the last 90 days (CrUX data).
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

const API = '/api';

const METRICS = [
  { key: 'lcp',  label: 'LCP',  color: '#4285F4', cruxKey: 'largest_contentful_paint',   unit: 's',  divisor: 1000, threshold: { good: 2.5, poor: 4 } },
  { key: 'inp',  label: 'INP',  color: '#ea4335', cruxKey: 'interaction_to_next_paint',   unit: 'ms', divisor: 1,    threshold: { good: 200, poor: 500 } },
  { key: 'cls',  label: 'CLS',  color: '#fbbc04', cruxKey: 'cumulative_layout_shift',     unit: '',   divisor: 1,    threshold: { good: 0.1, poor: 0.25 } },
  { key: 'fcp',  label: 'FCP',  color: '#34a853', cruxKey: 'first_contentful_paint',      unit: 'ms', divisor: 1,    threshold: { good: 1800, poor: 3000 } },
];

function parseHistory(cruxData) {
  if (!cruxData?.record?.metrics) return [];

  const metrics = cruxData.record.metrics;
  const firstMetricKey = Object.keys(metrics)[0];
  if (!firstMetricKey) return [];

  // Use collectionPeriods for x-axis dates
  const periods = cruxData.record.collectionPeriods || [];

  return periods.map((period, i) => {
    const point = { date: period.lastDate ? `${String(period.lastDate.day).padStart(2,'0')}-${String(period.lastDate.month).padStart(2,'0')}-${period.lastDate.year}` : `Week ${i+1}` };
    METRICS.forEach(({ key, cruxKey, divisor }) => {
      const p75 = metrics[cruxKey]?.percentilesTimeseries?.p75s?.[i];
      const val = p75 != null ? Number((p75 / divisor).toFixed(key === 'cls' ? 3 : 2)) : null;
      point[key] = (val === null || isNaN(val)) ? null : val;
    });
    return point;
  });
}

export default function CWVHistoryChart({ pattern, sampleUrl, topUrls, formFactor, onClose }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [resolvedUrl, setResolvedUrl] = useState('');
  const [activeMetrics, setActiveMetrics] = useState(['lcp', 'inp', 'cls', 'fcp']);

  useEffect(() => {
    setLoading(true);
    setError('');
    axios.post(`${API}/cwv-history`, { url: sampleUrl, topUrls, formFactor })
      .then(({ data: res }) => {
        setSource(res.source);
        setResolvedUrl(res.data?.record?.key?.url || res.data?.record?.key?.origin || sampleUrl);
        const parsed = parseHistory(res.data);
        console.log('[chart] source:', res.source, 'periods:', res.data?.record?.collectionPeriods?.length, 'parsed points:', parsed.length, 'sample:', parsed.slice(-3));
        setData(parsed);
      })
      .catch((e) => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [sampleUrl, formFactor]);

  const toggleMetric = (key) => {
    setActiveMetrics((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };


  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="history-header">
          <div>
            <h3 className="history-title">CWV History</h3>
            <p className="history-pattern">{pattern}</p>
            <p className="history-sub">
              Sample: <span className="history-url">{resolvedUrl.replace(/^https?:\/\/[^/]+/, '')}</span>
              {source && <span className="history-source"> · {source === 'aggregated' ? `aggregated across ${topUrls?.length || 1} URLs` : `${source}-level data`}</span>}
            </p>
          </div>
          <button className="history-close" onClick={onClose}>✕</button>
        </div>

        {loading && (
          <div className="loading-state" style={{ padding: '40px' }}>
            <div className="spinner" />
            <p>Loading history...</p>
          </div>
        )}

        {error && <div className="error-banner" style={{ margin: '16px' }}>{error}</div>}

        {!loading && !error && data.length > 0 && (
          <>
            <div className="history-metric-toggles">
              {METRICS.map(({ key, label, color }) => (
                <button
                  key={key}
                  className={`metric-toggle ${activeMetrics.includes(key) ? 'on' : 'off'}`}
                  style={{ '--m-color': color }}
                  onClick={() => toggleMetric(key)}
                >
                  <span className="toggle-dot" style={{ background: activeMetrics.includes(key) ? color : '#ccc' }} />
                  {label}
                </button>
              ))}
            </div>

            {METRICS.filter((m) => activeMetrics.includes(m.key)).map(({ key, label, color, unit, threshold }) => (
              <div key={key} className="history-chart-block">
                <div className="chart-metric-label" style={{ color }}>{label}</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={data} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f4" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9aa0a6' }} tickLine={false} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#9aa0a6' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `${v}${unit}`}
                      width={48}
                    />
                    <Tooltip
                      formatter={(v) => v != null ? [`${v}${unit}`, label] : ['—', label]}
                      labelStyle={{ fontWeight: 600, fontSize: 12 }}
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e0e0e0' }}
                    />
                    <ReferenceLine y={threshold.good} stroke="#1e8e3e" strokeDasharray="4 2" label={{ value: 'Good', fontSize: 10, fill: '#1e8e3e', position: 'right' }} />
                    <ReferenceLine y={threshold.poor} stroke="#d93025" strokeDasharray="4 2" label={{ value: 'Poor', fontSize: 10, fill: '#d93025', position: 'right' }} />
                    <Line
                      type="monotone"
                      dataKey={key}
                      stroke={color}
                      strokeWidth={2}
                      dot={{ r: 3, fill: color }}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ))}
          </>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="empty-state" style={{ padding: '40px' }}>
            <p>No historical data available for this URL.</p>
          </div>
        )}
      </div>
    </div>
  );
}

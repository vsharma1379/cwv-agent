import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import SiteSelector from './SiteSelector';
import CWVTable from './CWVTable';

const API = '/api';

// CWV thresholds
const thresholds = {
  lcp:  { good: 2500, poor: 4000 },  // ms
  inp:  { good: 200,  poor: 500 },   // ms
  cls:  { good: 0.1,  poor: 0.25 },  // score
  fcp:  { good: 1800, poor: 3000 },  // ms
  ttfb: { good: 800,  poor: 1800 },  // ms
};

export function getStatus(metric, value) {
  if (value === null || value === undefined) return 'unknown';
  const num = Number(value);
  if (isNaN(num)) return 'unknown';
  const t = thresholds[metric];
  if (!t) return 'unknown';
  if (num <= t.good) return 'good';
  if (num <= t.poor) return 'needs-improvement';
  return 'poor';
}

export function overallStatus(metrics) {
  const statuses = ['lcp', 'inp', 'cls'].map((m) => {
    const val = metrics?.[m];
    return getStatus(m, val);
  });
  if (statuses.includes('poor')) return 'poor';
  if (statuses.includes('needs-improvement')) return 'needs-improvement';
  if (statuses.every((s) => s === 'good')) return 'good';
  return 'unknown';
}

function extractMetrics(cruxMetrics) {
  if (!cruxMetrics) return null;
  const get = (key) => cruxMetrics[key]?.percentiles?.p75 ?? null;
  return {
    lcp:  get('largest_contentful_paint'),
    inp:  get('interaction_to_next_paint'),
    cls:  get('cumulative_layout_shift'),
    fcp:  get('first_contentful_paint'),
    ttfb: get('experimental_time_to_first_byte'),
  };
}

export default function Dashboard({ auth, onLogout }) {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState('');
  const [urlData, setUrlData] = useState([]); // [{url, metrics, status, source}]
  const [formFactor, setFormFactor] = useState('PHONE');
  const [filterStatus, setFilterStatus] = useState('all');

  const headers = { 'x-access-token': auth.access_token };

  // Load sites on mount
  useEffect(() => {
    axios.get(`${API}/sites`, { headers })
      .then(({ data }) => setSites(data))
      .catch((e) => setError('Failed to load sites: ' + (e.response?.data?.error || e.message)));
  }, []);

  const fetchCWV = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    setError('');
    setUrlData([]);

    try {
      setLoadingMsg('Fetching top URLs from Search Console...');
      const { data: rows } = await axios.get(`${API}/urls`, {
        headers,
        params: { siteUrl: selectedSite },
      });

      if (!rows.length) {
        setError('No URLs found for this site in the selected date range.');
        setLoading(false);
        return;
      }

      const urls = rows.map((r) => r.keys[0]);
      setLoadingMsg(`Fetching CWV data for ${urls.length} URLs via CrUX...`);

      const { data: cwvResults } = await axios.post(`${API}/cwv-bulk`, {
        urls,
        formFactor,
      });

      const processed = cwvResults.map((item) => {
        const metrics = extractMetrics(item.metrics);
        return {
          url: item.url,
          metrics,
          status: metrics ? overallStatus(metrics) : 'unknown',
          source: item.source,
        };
      });

      setUrlData(processed);
    } catch (e) {
      setError('Error fetching CWV data: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }, [selectedSite, formFactor]);

  const counts = {
    good: urlData.filter((d) => d.status === 'good').length,
    'needs-improvement': urlData.filter((d) => d.status === 'needs-improvement').length,
    poor: urlData.filter((d) => d.status === 'poor').length,
    unknown: urlData.filter((d) => d.status === 'unknown').length,
  };

  const filtered = filterStatus === 'all' ? urlData : urlData.filter((d) => d.status === filterStatus);

  return (
    <div className="dashboard">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo-mark">CWV</div>
          <div>
            <h1 className="header-title">Core Web Vitals Dashboard</h1>
            <p className="header-sub">Google Search Console · CrUX Field Data</p>
          </div>
        </div>
        <div className="header-right">
          {auth.picture && <img src={auth.picture} alt="" className="avatar" />}
          <span className="user-email">{auth.name || auth.email}</span>
          <button className="btn-logout" onClick={onLogout}>Logout</button>
        </div>
      </header>

      {/* Controls */}
      <div className="controls-bar">
        <SiteSelector sites={sites} value={selectedSite} onChange={setSelectedSite} />

        <select className="select" value={formFactor} onChange={(e) => setFormFactor(e.target.value)}>
          <option value="PHONE">Mobile</option>
          <option value="DESKTOP">Desktop</option>
          <option value="">All Devices</option>
        </select>

        <button
          className="btn-primary"
          onClick={fetchCWV}
          disabled={!selectedSite || loading}
        >
          {loading ? 'Loading...' : 'Fetch CWV Data'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && (
        <div className="loading-state">
          <div className="spinner" />
          <p>{loadingMsg}</p>
        </div>
      )}

      {/* Summary cards */}
      {urlData.length > 0 && !loading && (
        <>
          <div className="summary-cards">
            {[
              { key: 'good',             label: 'Good',              color: '#1e8e3e' },
              { key: 'needs-improvement', label: 'Needs Improvement', color: '#f29900' },
              { key: 'poor',             label: 'Poor',              color: '#d93025' },
              { key: 'unknown',          label: 'No Data',           color: '#9aa0a6' },
            ].map(({ key, label, color }) => (
              <button
                key={key}
                className={`summary-card ${filterStatus === key ? 'active' : ''}`}
                style={{ '--card-color': color }}
                onClick={() => setFilterStatus(filterStatus === key ? 'all' : key)}
              >
                <span className="card-count" style={{ color }}>{counts[key]}</span>
                <span className="card-label">{label}</span>
                <span className="card-pct">
                  {urlData.length ? Math.round((counts[key] / urlData.length) * 100) : 0}%
                </span>
              </button>
            ))}
            <button
              className={`summary-card ${filterStatus === 'all' ? 'active' : ''}`}
              style={{ '--card-color': '#4285F4' }}
              onClick={() => setFilterStatus('all')}
            >
              <span className="card-count" style={{ color: '#4285F4' }}>{urlData.length}</span>
              <span className="card-label">Total URLs</span>
              <span className="card-pct">100%</span>
            </button>
          </div>

          <CWVTable data={filtered} />
        </>
      )}

      {!loading && !urlData.length && selectedSite && !error && (
        <div className="empty-state">
          <p>Select a site and click <strong>Fetch CWV Data</strong> to load results.</p>
        </div>
      )}

      {!selectedSite && !loading && (
        <div className="empty-state">
          <p>Select a Search Console property above to get started.</p>
        </div>
      )}
    </div>
  );
}

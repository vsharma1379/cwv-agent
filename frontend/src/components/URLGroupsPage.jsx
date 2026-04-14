import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import SiteSelector from './SiteSelector';
import URLGroupsTable from './URLGroupsTable';
import { overallStatus } from './Dashboard';

const API = '/api';

function extractMetrics(cruxMetrics) {
  if (!cruxMetrics) return null;
  const get = (key) => cruxMetrics[key]?.percentiles?.p75 ?? null;
  return {
    lcp: get('largest_contentful_paint'),
    inp: get('interaction_to_next_paint'),
    cls: get('cumulative_layout_shift'),
    fcp: get('first_contentful_paint'),
  };
}

export default function URLGroupsPage({ auth, onLogout }) {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState('');
  const [formFactor, setFormFactor] = useState('PHONE');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState('');
  const [groups, setGroups] = useState([]);
  const [filterStatus, setFilterStatus] = useState('all');

  const headers = { 'x-access-token': auth.access_token };

  useEffect(() => {
    axios.get(`${API}/sites`, { headers })
      .then(({ data }) => setSites(data))
      .catch((e) => setError('Failed to load sites: ' + (e.response?.data?.error || e.message)));
  }, []);

  const fetchGroups = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    setError('');
    setGroups([]);

    try {
      setLoadingMsg('Fetching top 1000 URLs from Search Console & grouping by pattern...');
      const { data } = await axios.get(`${API}/url-groups`, {
        headers,
        params: { siteUrl: selectedSite, formFactor },
      });

      const processed = data.map((group) => {
        const metrics = extractMetrics(group.metrics);
        return { ...group, metrics, status: metrics ? overallStatus(metrics) : 'unknown' };
      });

      setGroups(processed);
    } catch (e) {
      setError('Error fetching URL groups: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }, [selectedSite, formFactor]);

  const counts = {
    good: groups.filter((g) => g.status === 'good').length,
    'needs-improvement': groups.filter((g) => g.status === 'needs-improvement').length,
    poor: groups.filter((g) => g.status === 'poor').length,
    unknown: groups.filter((g) => g.status === 'unknown').length,
  };

  const filtered = filterStatus === 'all' ? groups : groups.filter((g) => g.status === filterStatus);

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-left">
          <div className="logo-mark">CWV</div>
          <div>
            <h1 className="header-title">URL Groups</h1>
            <p className="header-sub">Top 1000 URLs grouped by pattern · CrUX Field Data</p>
          </div>
        </div>
        <div className="header-right">
          {auth.picture && <img src={auth.picture} alt="" className="avatar" />}
          <span className="user-email">{auth.name || auth.email}</span>
          <button className="btn-logout" onClick={onLogout}>Logout</button>
        </div>
      </header>

      <div className="controls-bar">
        <SiteSelector sites={sites} value={selectedSite} onChange={setSelectedSite} />
        <select className="select" value={formFactor} onChange={(e) => setFormFactor(e.target.value)}>
          <option value="PHONE">Mobile</option>
          <option value="DESKTOP">Desktop</option>
          <option value="">All Devices</option>
        </select>
        <button className="btn-primary" onClick={fetchGroups} disabled={!selectedSite || loading}>
          {loading ? 'Loading...' : 'Fetch URL Groups'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && (
        <div className="loading-state">
          <div className="spinner" />
          <p>{loadingMsg}</p>
        </div>
      )}

      {groups.length > 0 && !loading && (
        <>
          <div className="summary-cards">
            {[
              { key: 'good',              label: 'Good',              color: '#1e8e3e' },
              { key: 'needs-improvement', label: 'Needs Improvement', color: '#f29900' },
              { key: 'poor',              label: 'Poor',              color: '#d93025' },
              { key: 'unknown',           label: 'No Data',           color: '#9aa0a6' },
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
                  {groups.length ? Math.round((counts[key] / groups.length) * 100) : 0}%
                </span>
              </button>
            ))}
            <button
              className={`summary-card ${filterStatus === 'all' ? 'active' : ''}`}
              style={{ '--card-color': '#4285F4' }}
              onClick={() => setFilterStatus('all')}
            >
              <span className="card-count" style={{ color: '#4285F4' }}>{groups.length}</span>
              <span className="card-label">Total Groups</span>
              <span className="card-pct">100%</span>
            </button>
          </div>

          <URLGroupsTable data={filtered} formFactor={formFactor} />
        </>
      )}

      {!loading && !groups.length && selectedSite && !error && (
        <div className="empty-state">
          <p>Select a site and click <strong>Fetch URL Groups</strong> to load results.</p>
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

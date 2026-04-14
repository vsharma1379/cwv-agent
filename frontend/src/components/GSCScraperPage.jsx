import { useState, useEffect } from 'react';
import axios from 'axios';
import SiteSelector from './SiteSelector';

const API = '/api';

export default function GSCScraperPage({ auth, onLogout }) {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState('');
  const [setupStatus, setSetupStatus] = useState(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [drilldown, setDrilldown] = useState(null);  // { device, status, urlGroups, loading }

  const headers = { 'x-access-token': auth.access_token };

  useEffect(() => {
    axios.get(`${API}/sites`, { headers }).then(({ data }) => setSites(data)).catch(() => {});
    axios.get(`${API}/gsc-auth-status`)
      .then(({ data }) => setSetupStatus(data.ready ? 'ready' : 'not-ready'))
      .catch(() => setSetupStatus('not-ready'));
  }, []);

  const runSetup = async () => {
    setSetupLoading(true);
    setError('');
    try {
      await axios.post(`${API}/gsc-setup`);
      setSetupStatus('ready');
    } catch (e) {
      setError('Setup failed: ' + (e.response?.data?.error || e.message));
    } finally {
      setSetupLoading(false);
    }
  };

  const runScrape = async () => {
    if (!selectedSite) return;
    setScraping(true);
    setError('');
    setResult(null);
    setDrilldown(null);
    try {
      const { data } = await axios.post(`${API}/gsc-scrape`, { siteUrl: selectedSite });
      setResult(data);
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      if (msg.includes('Session expired') || msg.includes('setup')) setSetupStatus('not-ready');
      setError(msg);
    } finally {
      setScraping(false);
    }
  };

  const openDrilldown = (device, status, href) => {
    setDrilldown({ device, status, urlGroups: [], loading: true, href });
    setError('');

    const params = new URLSearchParams({ siteUrl: selectedSite, device, status });
    const es = new EventSource(`${API}/gsc-scrape-drilldown?${params}`);

    es.addEventListener('group', (e) => {
      const group = JSON.parse(e.data);
      setDrilldown((prev) => prev ? { ...prev, urlGroups: [...prev.urlGroups, group] } : prev);
    });

    es.addEventListener('status', (e) => {
      console.log('[drilldown]', JSON.parse(e.data).message);
    });

    es.addEventListener('done', () => {
      es.close();
      setDrilldown((prev) => prev ? { ...prev, loading: false } : prev);
    });

    es.addEventListener('error', (e) => {
      // SSE 'error' fires both for actual errors AND when stream closes normally
      // Only treat as error if e.data exists (actual error event from server)
      if (e.data) {
        try {
          const msg = JSON.parse(e.data)?.error || 'Drilldown failed';
          setError(msg);
          if (msg.includes('Session expired')) setSetupStatus('not-ready');
        } catch {}
      }
      es.close();
      setDrilldown((prev) => prev ? { ...prev, loading: false } : prev);
    });
  };

  const grouped = result ? groupByFormFactor(result.groups) : {};

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-left">
          <div className="logo-mark">CWV</div>
          <div>
            <h1 className="header-title">Core Web Vitals</h1>
            <p className="header-sub">
              Source: Google Search Console
              {result?.gscDate && <span> · Data as of: <strong>{result.gscDate}</strong></span>}
              {result && <span style={{ color: '#9aa0a6' }}> · Fetched: {new Date(result.scrapedAt).toLocaleDateString('en-GB')}</span>}
            </p>
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
        {setupStatus === 'not-ready' && (
          <button className="btn-setup" onClick={runSetup} disabled={setupLoading}>
            {setupLoading ? 'Opening browser...' : 'Setup Browser Login'}
          </button>
        )}
        {setupStatus === 'ready' && (
          <>
            <span className="setup-badge ready">Browser ready</span>
            <button className="btn-primary" onClick={runScrape} disabled={!selectedSite || scraping}>
              {scraping ? 'Fetching...' : 'Fetch Data'}
            </button>
            {drilldown && (
              <button className="btn-secondary" onClick={() => setDrilldown(null)}>
                ← Back to Overview
              </button>
            )}
          </>
        )}
      </div>

      {setupStatus === 'not-ready' && !setupLoading && (
        <div className="scraper-info">
          <strong>One-time setup required:</strong> Click <em>Setup Browser Login</em> — a Chrome window opens. Log in to Google → navigate to Search Console. Session is saved for future scrapes.
        </div>
      )}
      {setupLoading && (
        <div className="loading-state">
          <div className="spinner" />
          <p>Chrome window opened. Please log in to Google Search Console, then wait...</p>
        </div>
      )}

      {error && <div className="error-banner" style={{ margin: '16px 24px' }}>{error}</div>}
      {scraping && <div className="loading-state"><div className="spinner" /><p>Loading Core Web Vitals from Search Console...</p></div>}

      {/* ── Drilldown View ── */}
      {drilldown && !scraping && (
        <DrilldownTable drilldown={drilldown} />
      )}

      {/* ── Overview View ── */}
      {result && !scraping && !drilldown && (
        <div className="gsc-cwv-sections">
          {['Mobile', 'Desktop'].map((ff) => {
            const section = grouped[ff];
            if (!section) return (
              <div key={ff} className="gsc-cwv-section">
                <div className="gsc-section-header"><h2 className="gsc-section-title">{ff}</h2></div>
                <div className="gsc-no-data">No data available</div>
              </div>
            );

            const total = section.poor + section.needsImprovement + section.good;
            const poorPct = total ? (section.poor / total) * 100 : 0;
            const niPct   = total ? (section.needsImprovement / total) * 100 : 0;
            const goodPct = total ? (section.good / total) * 100 : 0;

            return (
              <div key={ff} className="gsc-cwv-section">
                <div className="gsc-section-header">
                  <h2 className="gsc-section-title">{ff}</h2>
                  {section.reportHref && (
                    <a href={section.reportHref} target="_blank" rel="noreferrer" className="gsc-open-report">
                      OPEN REPORT &rsaquo;
                    </a>
                  )}
                </div>

                <div className="gsc-bar-wrap">
                  <div className="gsc-bar">
                    {poorPct > 0 && <div className="gsc-bar-poor" style={{ width: `${poorPct}%` }} />}
                    {niPct   > 0 && <div className="gsc-bar-ni"   style={{ width: `${niPct}%` }} />}
                    {goodPct > 0 && <div className="gsc-bar-good" style={{ width: `${goodPct}%` }} />}
                  </div>
                </div>

                <div className="gsc-legend">
                  <span className="gsc-legend-item poor"><span className="gsc-dot poor" /><strong>{section.poor.toLocaleString()}</strong> poor URLs</span>
                  <span className="gsc-legend-sep">·</span>
                  <span className="gsc-legend-item ni"><span className="gsc-dot ni" /><strong>{section.needsImprovement.toLocaleString()}</strong> needs improvement</span>
                  <span className="gsc-legend-sep">·</span>
                  <span className="gsc-legend-item good"><span className="gsc-dot good" /><strong>{section.good.toLocaleString()}</strong> good URLs</span>
                </div>

                <div className="gsc-cards">
                  {section.poor > 0 && (
                    <div className="gsc-card poor clickable" onClick={() => openDrilldown(ff, 'poor', section.reportHref)}>
                      <div className="gsc-card-count">{section.poor.toLocaleString()}</div>
                      <div className="gsc-card-label">Poor</div>
                      <div className="gsc-card-pct">{poorPct.toFixed(1)}% · View groups →</div>
                    </div>
                  )}
                  {section.needsImprovement > 0 && (
                    <div className="gsc-card ni clickable" onClick={() => openDrilldown(ff, 'needs-improvement', section.reportHref)}>
                      <div className="gsc-card-count">{section.needsImprovement.toLocaleString()}</div>
                      <div className="gsc-card-label">Needs Improvement</div>
                      <div className="gsc-card-pct">{niPct.toFixed(1)}% · View groups →</div>
                    </div>
                  )}
                  {section.good > 0 && (
                    <div className="gsc-card good clickable" onClick={() => openDrilldown(ff, 'good', section.reportHref)}>
                      <div className="gsc-card-count">{section.good.toLocaleString()}</div>
                      <div className="gsc-card-label">Good</div>
                      <div className="gsc-card-pct">{goodPct.toFixed(1)}% · View groups →</div>
                    </div>
                  )}
                  <div className="gsc-card total">
                    <div className="gsc-card-count">{total.toLocaleString()}</div>
                    <div className="gsc-card-label">Total URLs</div>
                    <div className="gsc-card-pct">100%</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!result && !scraping && setupStatus === 'ready' && !error && (
        <div className="empty-state">
          <p>Select a site and click <strong>Fetch Data</strong> to load CWV data from Search Console.</p>
        </div>
      )}
    </div>
  );
}

function DrilldownTable({ drilldown }) {
  const { device, status, urlGroups, loading } = drilldown;
  const statusLabel = { good: 'Good', 'needs-improvement': 'Needs Improvement', poor: 'Poor' };
  const statusColor = { good: '#1e8e3e', 'needs-improvement': '#f29900', poor: '#d93025' };

  if (loading) return (
    <>
      <div className="loading-state">
        <div className="spinner" />
        <p>Scraping URL groups from Search Console — {urlGroups.length} loaded so far...</p>
      </div>
      {urlGroups.length > 0 && <DrilldownResults urlGroups={urlGroups} statusColor={statusColor} statusLabel={statusLabel} device={device} status={status} />}
    </>
  );

  return <DrilldownResults urlGroups={urlGroups} statusColor={statusColor} statusLabel={statusLabel} device={device} status={status} />;
}

function DrilldownResults({ urlGroups, statusColor, statusLabel, device, status }) {
  const [filterPattern, setFilterPattern] = useState('');

  let regexError = '';
  let filtered = urlGroups;
  if (filterPattern) {
    try {
      const re = new RegExp(filterPattern, 'i');
      filtered = urlGroups.filter(g => re.test(g.exampleUrl));
    } catch (e) {
      regexError = e.message;
    }
  }

  const totalUrls = urlGroups.reduce((s, g) => s + (g.population || 0), 0);
  const filteredUrls = filtered.reduce((s, g) => s + (g.population || 0), 0);

  return (
    <div style={{ margin: '0 24px 24px' }}>
      <div className="table-wrapper">
        <div className="table-header-row">
          <h2 className="table-title">
            {device} · <span style={{ color: statusColor[status] }}>{statusLabel[status]}</span> URL Groups
          </h2>
          <div className="table-header-meta">
            <span className="table-count">
              {filterPattern
                ? <>{filtered.length} / {urlGroups.length} groups · {filteredUrls.toLocaleString()} / {totalUrls.toLocaleString()} URLs</>
                : <>{urlGroups.length} groups · {totalUrls.toLocaleString()} URLs</>}
            </span>
          </div>
        </div>

        <div className="filter-bar">
          <input
            className={`filter-input${regexError ? ' filter-input-error' : ''}`}
            type="text"
            placeholder="Filter by URL regex  e.g. /salary|/overview"
            value={filterPattern}
            onChange={e => setFilterPattern(e.target.value)}
            spellCheck={false}
          />
          {regexError && <span className="filter-error">{regexError}</span>}
          {filterPattern && !regexError && (
            <button className="filter-clear" onClick={() => setFilterPattern('')}>✕</button>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: '40px' }}>
            <p>{filterPattern ? 'No groups match the filter.' : 'No URL groups found.'}</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="cwv-table">
              <thead>
                <tr>
                  <th className="th-url">Example URL</th>
                  <th className="th-metric">Group Size</th>
                  <th className="th-metric">LCP</th>
                  <th className="th-metric">CLS</th>
                  <th className="th-metric">INP</th>
                  <th className="th-metric">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((g, i) => (
                  <tr key={i} className="tr-row">
                    <td className="td-url" title={g.exampleUrl}>
                      <a href={g.exampleUrl} target="_blank" rel="noreferrer">
                        {g.exampleUrl.replace(/^https?:\/\/[^/]+/, '') || '/'}
                      </a>
                    </td>
                    <td className="td-source">{g.population?.toLocaleString() ?? '—'}</td>
                    <td className="td-source">{g.lcp ?? '—'}</td>
                    <td className="td-source">{g.cls ?? '—'}</td>
                    <td className="td-source">{g.inp ?? '—'}</td>
                    <td>
                      {g.status ? (
                        <span className="status-dot" style={{
                          background: (statusColor[g.status] || '#9aa0a6') + '20',
                          color: statusColor[g.status] || '#9aa0a6',
                        }}>
                          {statusLabel[g.status] || g.status}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function groupByFormFactor(groups) {
  const map = {};
  for (const g of groups) {
    const ff = g.formFactor || 'unknown';
    if (!map[ff]) map[ff] = { poor: 0, needsImprovement: 0, good: 0, reportHref: g.href };
    if (g.status === 'poor') map[ff].poor = g.affectedCount || 0;
    else if (g.status === 'needs-improvement') map[ff].needsImprovement = g.affectedCount || 0;
    else if (g.status === 'good') map[ff].good = g.affectedCount || 0;
    if (g.href && !map[ff].reportHref) map[ff].reportHref = g.href;
  }
  return map;
}

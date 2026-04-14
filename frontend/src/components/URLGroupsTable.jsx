import { useState } from 'react';
import MetricBadge, { StatusDot } from './MetricBadge';
import CWVHistoryChart from './CWVHistoryChart';
import SearchBar from './SearchBar';

const STATUS_ORDER = { poor: 0, 'needs-improvement': 1, good: 2, unknown: 3 };

function CoverageBadge({ urlsWithData, urlsFetched, population, source }) {
  if (source === 'origin') {
    return <span className="coverage-badge origin" title="No URL-level data — showing origin-level CWV">origin</span>;
  }
  if (!urlsFetched) return null;
  const pct = Math.round((urlsWithData / population) * 100);
  const level = pct >= 30 ? 'high' : pct >= 10 ? 'medium' : 'low';
  return (
    <span
      className={`coverage-badge ${level}`}
      title={`${urlsWithData} of ${urlsFetched} sampled URLs had CrUX data (${pct}% of ${population} total URLs)`}
    >
      {urlsWithData}/{urlsFetched} URLs
    </span>
  );
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export default function URLGroupsTable({ data, formFactor }) {
  const [sortKey, setSortKey] = useState('impressions');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState(null);
  const [chartRow, setChartRow] = useState(null);
  const [search, setSearch] = useState('');

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = (() => {
    if (!search) return data;
    try { const re = new RegExp(search, 'i'); return data.filter((r) => re.test(r.pattern)); }
    catch { return data; }
  })();

  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortKey === 'status') {
      va = STATUS_ORDER[a.status] ?? 9;
      vb = STATUS_ORDER[b.status] ?? 9;
    } else if (sortKey === 'pattern') {
      va = a.pattern; vb = b.pattern;
    } else if (sortKey === 'population') {
      va = a.population; vb = b.population;
    } else if (sortKey === 'impressions') {
      va = a.totalImpressions; vb = b.totalImpressions;
    } else {
      va = a.metrics?.[sortKey] ?? Infinity;
      vb = b.metrics?.[sortKey] ?? Infinity;
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const SortIcon = ({ col }) => {
    if (sortKey !== col) return <span className="sort-icon inactive">↕</span>;
    return <span className="sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <>
    {chartRow && (
      <CWVHistoryChart
        pattern={chartRow.pattern}
        sampleUrl={chartRow.usedUrl || chartRow.sampleUrl}
        topUrls={chartRow.topUrls}
        formFactor={formFactor}
        onClose={() => setChartRow(null)}
      />
    )}
    <div className="table-wrapper">
      <div className="table-header-row">
        <h2 className="table-title">URL Groups by Pattern</h2>
        <div className="table-header-right">
          <SearchBar value={search} onChange={setSearch} placeholder="Filter by pattern (regex ok)" />
          <span className="table-count">{sorted.length} / {data.length} groups</span>
        </div>
      </div>

      <div className="table-scroll">
        <table className="cwv-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('status')} className="th-sortable">
                Status <SortIcon col="status" />
              </th>
              <th onClick={() => handleSort('pattern')} className="th-sortable th-url">
                URL Pattern <SortIcon col="pattern" />
              </th>
              <th onClick={() => handleSort('population')} className="th-sortable th-metric">
                URLs <SortIcon col="population" />
              </th>
              <th onClick={() => handleSort('impressions')} className="th-sortable th-metric">
                Impressions <SortIcon col="impressions" />
              </th>
              <th onClick={() => handleSort('lcp')} className="th-sortable th-metric">
                LCP <SortIcon col="lcp" />
                <span className="th-hint">p75</span>
              </th>
              <th onClick={() => handleSort('inp')} className="th-sortable th-metric">
                INP <SortIcon col="inp" />
                <span className="th-hint">p75</span>
              </th>
              <th onClick={() => handleSort('cls')} className="th-sortable th-metric">
                CLS <SortIcon col="cls" />
                <span className="th-hint">p75</span>
              </th>
              <th onClick={() => handleSort('fcp')} className="th-sortable th-metric">
                FCP <SortIcon col="fcp" />
                <span className="th-hint">p75</span>
              </th>
              <th className="th-metric">Coverage</th>
              <th className="th-metric">Source</th>
              <th className="th-metric"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <>
                <tr
                  key={row.pattern}
                  className={`tr-row ${expanded === i ? 'expanded' : ''}`}
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <td><StatusDot status={row.status} /></td>
                  <td className="td-url" title={row.pattern}>
                    <span className="pattern-text">{row.pattern}</span>
                  </td>
                  <td className="td-source">{row.population.toLocaleString()}</td>
                  <td className="td-source">{fmtNum(row.totalImpressions)}</td>
                  <td><MetricBadge metric="lcp" value={row.metrics?.lcp} /></td>
                  <td><MetricBadge metric="inp" value={row.metrics?.inp} /></td>
                  <td><MetricBadge metric="cls" value={row.metrics?.cls} /></td>
                  <td><MetricBadge metric="fcp" value={row.metrics?.fcp} /></td>
                  <td><CoverageBadge urlsWithData={row.urlsWithData} urlsFetched={row.urlsFetched} population={row.population} source={row.source} /></td>
                  <td className="td-source">{row.source}</td>
                  <td>
                    <button
                      className="btn-history"
                      title="View history"
                      onClick={(e) => { e.stopPropagation(); setChartRow(row); }}
                    >
                      📈
                    </button>
                  </td>
                </tr>
                {expanded === i && row.sampleUrls?.length > 0 && (
                  <tr key={`${row.pattern}-expanded`} className="expanded-row">
                    <td colSpan={10}>
                      <div className="sample-urls">
                        <span className="sample-label">Sample URLs:</span>
                        {row.sampleUrls.map((url) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer" className="sample-url">
                            {url.replace(/^https?:\/\/[^/]+/, '')}
                          </a>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-legend">
        <span className="legend-item"><span className="legend-dot good" /> Good</span>
        <span className="legend-item"><span className="legend-dot ni" /> Needs Improvement</span>
        <span className="legend-item"><span className="legend-dot poor" /> Poor</span>
        <span className="legend-sep" />
        <span className="legend-note">CWV fetched for representative URL per group · LCP &lt;2.5s · INP &lt;200ms · CLS &lt;0.1 = Good</span>
      </div>
    </div>
    </>
  );
}

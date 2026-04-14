import { useState } from 'react';
import MetricBadge, { StatusDot } from './MetricBadge';
import SearchBar from './SearchBar';

const STATUS_ORDER = { poor: 0, 'needs-improvement': 1, good: 2, unknown: 3 };

export default function CWVTable({ data }) {
  const [sortKey, setSortKey] = useState('status');
  const [sortDir, setSortDir] = useState('asc');
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(null);

  const copyUrl = (e, url) => {
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = (() => {
    if (!search) return data;
    try { const re = new RegExp(search, 'i'); return data.filter((r) => re.test(r.url)); }
    catch { return data; }
  })();

  const sorted = [...filtered].sort((a, b) => {
    let va, vb;
    if (sortKey === 'status') {
      va = STATUS_ORDER[a.status] ?? 9;
      vb = STATUS_ORDER[b.status] ?? 9;
    } else if (sortKey === 'url') {
      va = a.url;
      vb = b.url;
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
    <div className="table-wrapper">
      <div className="table-header-row">
        <h2 className="table-title">URL Groups by CWV Status</h2>
        <div className="table-header-right">
          <SearchBar value={search} onChange={setSearch} placeholder="Filter by URL (regex ok)" />
          <span className="table-count">{sorted.length} / {data.length} URLs</span>
        </div>
      </div>

      <div className="table-scroll">
        <table className="cwv-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('status')} className="th-sortable">
                Status <SortIcon col="status" />
              </th>
              <th onClick={() => handleSort('url')} className="th-sortable th-url">
                URL <SortIcon col="url" />
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
              <th className="th-metric">Source</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr
                key={row.url}
                className={`tr-row ${expanded === i ? 'expanded' : ''}`}
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <td><StatusDot status={row.status} /></td>
                <td className="td-url" title={row.url}>
                  <div className="td-url-inner">
                    <a href={row.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {row.url.replace(/^https?:\/\/[^/]+/, '') || '/'}
                    </a>
                    <button className="btn-copy" onClick={(e) => copyUrl(e, row.url)} title="Copy URL">
                      {copied === row.url ? '✓' : '⎘'}
                    </button>
                  </div>
                </td>
                <td><MetricBadge metric="lcp" value={row.metrics?.lcp} /></td>
                <td><MetricBadge metric="inp" value={row.metrics?.inp} /></td>
                <td><MetricBadge metric="cls" value={row.metrics?.cls} /></td>
                <td><MetricBadge metric="fcp" value={row.metrics?.fcp} /></td>
                <td className="td-source">{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-legend">
        <span className="legend-item"><span className="legend-dot good" /> Good</span>
        <span className="legend-item"><span className="legend-dot ni" /> Needs Improvement</span>
        <span className="legend-item"><span className="legend-dot poor" /> Poor</span>
        <span className="legend-sep" />
        <span className="legend-note">LCP &lt;2.5s · INP &lt;200ms · CLS &lt;0.1 = Good</span>
      </div>
    </div>
  );
}

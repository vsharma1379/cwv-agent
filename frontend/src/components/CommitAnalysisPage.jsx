import { useState } from 'react';
import axios from 'axios';

const API = '/api';

const RISK = {
  high:    { color: '#c5221f', bg: '#fce8e6', dot: '#ea4335', label: 'High' },
  medium:  { color: '#b06000', bg: '#fef3cd', dot: '#fbbc04', label: 'Medium' },
  low:     { color: '#1557b0', bg: '#e8f0fe', dot: '#4285f4', label: 'Low' },
  none:    { color: '#5f6368', bg: '#f1f3f4', dot: '#9e9e9e', label: 'Clean' },
  unknown: { color: '#5f6368', bg: '#f1f3f4', dot: '#bdbdbd', label: '—' },
};
const METRIC_COLOR = { CLS: '#b06000', INP: '#c5221f' };
const SEV_COLOR    = { high: '#c5221f', medium: '#b06000', low: '#1557b0' };

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function shortPath(p) {
  const parts = p.split('/');
  const name = parts.pop();
  const dir = parts.slice(-2).join('/');
  return { name, dir: dir ? dir + '/' : '' };
}

// ── Raw diff viewer ──────────────────────────────────────────────────────────
function RawDiff({ rawDiff }) {
  if (!rawDiff) return <p style={{ color: '#9e9e9e', fontSize: 12, margin: 0 }}>No diff available.</p>;
  return (
    <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid #e0e0e0', fontSize: 12, fontFamily: '"SFMono-Regular", Consolas, monospace', maxHeight: 420, overflowY: 'auto', background: '#fafafa' }}>
      {rawDiff.split('\n').map((line, i) => {
        const isAdd  = line.startsWith('+') && !line.startsWith('+++');
        const isRem  = line.startsWith('-') && !line.startsWith('---');
        const isHunk = line.startsWith('@@');
        return (
          <div key={i} style={{
            display: 'flex',
            background: isAdd ? '#e6f4ea' : isRem ? '#fce8e6' : isHunk ? '#e8f0fe' : 'transparent',
            minHeight: 20,
          }}>
            <span style={{
              width: 20, flexShrink: 0, textAlign: 'center', lineHeight: '20px',
              color: isAdd ? '#137333' : isRem ? '#c5221f' : '#9e9e9e',
              borderRight: '1px solid #e8eaed', userSelect: 'none', fontSize: 11,
            }}>
              {isAdd ? '+' : isRem ? '-' : ''}
            </span>
            <span style={{
              padding: '0 12px', lineHeight: '20px',
              color: isHunk ? '#1557b0' : isAdd ? '#137333' : isRem ? '#c5221f' : '#3c4043',
              wordBreak: 'break-all', whiteSpace: 'pre-wrap', flex: 1,
            }}>
              {line.slice(isHunk ? 0 : 1) || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Flagged pattern row ──────────────────────────────────────────────────────
function FindingRow({ finding }) {
  const [open, setOpen] = useState(false);
  const mColor = METRIC_COLOR[finding.metric] || '#5f6368';
  const sColor = SEV_COLOR[finding.severity] || '#5f6368';
  return (
    <div style={{ borderLeft: `3px solid ${sColor}`, background: '#fff', borderRadius: '0 6px 6px 0', marginBottom: 6, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, background: mColor + '18', color: mColor, padding: '1px 6px', borderRadius: 3, letterSpacing: 0.5 }}>{finding.metric}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#202124', flex: 1 }}>{finding.description}</span>
        {finding.matchCount > 1 && <span style={{ fontSize: 11, color: '#9e9e9e' }}>{finding.matchCount}×</span>}
        <span style={{ fontSize: 11, color: '#9e9e9e' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {finding.occurrences?.map((occ, i) => occ.matchedLine && (
            <div key={i} style={{ marginBottom: 6 }}>
              {finding.occurrences.length > 1 && <div style={{ fontSize: 10, color: '#9e9e9e', marginBottom: 2 }}>Match {i + 1}</div>}
              <pre style={{ margin: 0, padding: '6px 10px', background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#3c4043' }}>{occ.matchedLine}</pre>
              {occ.suggestedFix && <pre style={{ margin: '3px 0 0', padding: '6px 10px', background: '#f0fff4', border: '1px solid #b7dfbf', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#3c4043' }}>{occ.suggestedFix}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MR info strip ────────────────────────────────────────────────────────────
function MRStrip({ mr }) {
  const [open, setOpen] = useState(false);
  if (!mr) return null;
  const stateColor = mr.state === 'merged' ? '#137333' : mr.state === 'opened' ? '#1557b0' : '#5f6368';
  return (
    <div style={{ background: '#f8f9ff', border: '1px solid #c5cae9', borderRadius: 8, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: stateColor, padding: '2px 7px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0 }}>
          MR !{mr.id}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1a2e', flex: 1, minWidth: 0 }}>{mr.title}</span>
        {mr.labels?.map((l, i) => (
          <span key={i} style={{ fontSize: 10, background: '#e8eaed', color: '#5f6368', padding: '1px 7px', borderRadius: 10 }}>{l}</span>
        ))}
        <a href={mr.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#1557b0', textDecoration: 'none', flexShrink: 0 }}>Open ↗</a>
        {mr.description && (
          <button onClick={() => setOpen(v => !v)} style={{ fontSize: 11, color: '#5f6368', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {open ? 'hide desc ▲' : 'why? ▼'}
          </button>
        )}
      </div>
      {open && mr.description && (
        <pre style={{ margin: 0, padding: '10px 14px', borderTop: '1px solid #e8eaed', fontSize: 12, color: '#5f6368', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', lineHeight: 1.6, background: '#fff' }}>{mr.description}</pre>
      )}
    </div>
  );
}

// ── Create Fix MR (streams progress) ────────────────────────────────────────
function CreateFixMR({ filePath, metric, analysisText }) {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null); // { mrUrl, mrIid, mrTitle, branch }
  const [error, setError] = useState('');

  const run = async () => {
    setState('running'); setStatus('Starting...'); setError('');
    try {
      const res = await fetch(`${API}/commit-analysis/create-fix-mr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, metric, analysisText }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === 'status') setStatus(evt.text);
            else if (evt.type === 'done') { setResult(evt); setState('done'); }
            else if (evt.type === 'error') { setError(evt.text); setState('error'); }
          } catch { /* skip */ }
        }
      }
    } catch (e) { setError(e.message); setState('error'); }
  };

  if (state === 'idle') {
    return (
      <button onClick={run} style={{
        marginTop: 10, padding: '7px 16px',
        background: 'linear-gradient(135deg,#1e8e3e,#137333)', color: '#fff',
        border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 7,
      }}>
        🚀 Apply fix &amp; create MR
      </button>
    );
  }
  if (state === 'running') {
    return (
      <div style={{ marginTop: 10, padding: '10px 14px', background: '#f0fff4', border: '1px solid #b7dfbf', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#137333' }}>
        <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #b7dfbf', borderTop: '2px solid #137333', borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
        {status}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ marginTop: 10, padding: '10px 14px', background: '#fce8e6', border: '1px solid #f5c6c6', borderRadius: 8, fontSize: 12, color: '#c5221f', display: 'flex', gap: 10, alignItems: 'center' }}>
        ⚠ {error}
        <button onClick={() => setState('idle')} style={{ fontSize: 11, color: '#c5221f', background: 'none', border: '1px solid #c5221f', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>Retry</button>
      </div>
    );
  }
  // done
  return (
    <div style={{ marginTop: 10, padding: '12px 16px', background: '#e6f4ea', border: '1px solid #b7dfbf', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 18 }}>✅</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#137333' }}>MR created — !{result.mrIid}</div>
        <div style={{ fontSize: 12, color: '#3c4043', marginTop: 2 }}>{result.mrTitle}</div>
      </div>
      <a href={result.mrUrl} target="_blank" rel="noopener noreferrer" style={{
        padding: '6px 16px', background: '#137333', color: '#fff',
        borderRadius: 6, fontSize: 12, fontWeight: 700, textDecoration: 'none', flexShrink: 0,
      }}>
        Open MR ↗
      </a>
    </div>
  );
}

// ── Per-file AI analysis (streaming) ────────────────────────────────────────
function FileAIAnalysis({ commitSha, filePath, metric }) {
  const [state, setState] = useState('idle');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const run = async () => {
    setState('streaming'); setText(''); setStatus('Starting...'); setError('');
    try {
      const res = await fetch(`${API}/commit-analysis/ai-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitSha, filePath, metric }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === 'status') setStatus(evt.text);
            else if (evt.type === 'token') setText(t => t + evt.text);
            else if (evt.type === 'done') setState('done');
            else if (evt.type === 'error') { setError(evt.text); setState('error'); }
          } catch { /* skip */ }
        }
      }
      setState(s => s === 'streaming' ? 'done' : s);
    } catch (e) { setError(e.message); setState('error'); }
  };

  if (state === 'idle') {
    return (
      <button onClick={run} style={{
        marginTop: 10, padding: '6px 14px', background: '#1a1a2e', color: '#e6edf3',
        border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        🧠 Ask AI about this file
      </button>
    );
  }
  if (state === 'error') {
    return (
      <div style={{ marginTop: 10, padding: '8px 12px', background: '#fce8e6', borderRadius: 6, fontSize: 12, color: '#c5221f', display: 'flex', gap: 10, alignItems: 'center' }}>
        ⚠ {error}
        <button onClick={() => setState('idle')} style={{ fontSize: 11, color: '#c5221f', background: 'none', border: '1px solid #c5221f', borderRadius: 4, padding: '1px 8px', cursor: 'pointer' }}>Retry</button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10, background: '#0d1117', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', background: '#161b22', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #30363d' }}>
        <span>🧠</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#e6edf3', flex: 1 }}>AI Analysis</span>
        {state === 'streaming' && (
          <span style={{ fontSize: 11, color: '#58a6ff', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, border: '2px solid #1f6feb', borderTop: '2px solid #58a6ff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            {status}
          </span>
        )}
        {state === 'done' && <span style={{ fontSize: 11, color: '#3fb950' }}>✓ Done</span>}
        <button onClick={() => setState('idle')} style={{ fontSize: 12, color: '#8b949e', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ padding: '12px 16px', maxHeight: 480, overflowY: 'auto' }}>
        {text ? text.split('\n').map((line, i) => {
          const isH = /^#{1,3} /.test(line);
          const isNum = /^\d+\./.test(line.trim());
          const isBullet = /^[-*] /.test(line.trim());
          return (
            <p key={i} style={{
              margin: (isH || isNum) ? '12px 0 3px' : isBullet ? '3px 0 3px 14px' : '1px 0',
              fontSize: 12, lineHeight: 1.7,
              fontWeight: (isH || isNum) ? 700 : 400,
              color: isH ? '#e6edf3' : (isNum || isBullet) ? '#c9d1d9' : '#8b949e',
              whiteSpace: 'pre-wrap',
              fontFamily: line.includes('`') ? 'monospace' : 'inherit',
            }}>{line || ' '}</p>
          );
        }) : <p style={{ color: '#484f58', fontSize: 12, fontStyle: 'italic', margin: 0 }}>Waiting for Claude...</p>}
        {state === 'streaming' && text && (
          <span style={{ display: 'inline-block', width: 7, height: 13, background: '#58a6ff', animation: 'blink 1s step-end infinite', verticalAlign: 'text-bottom', marginLeft: 2 }} />
        )}
      </div>
      {state === 'done' && text && (
        <div style={{ padding: '0 16px 14px', borderTop: '1px solid #21262d' }}>
          <CreateFixMR filePath={filePath} metric={metric} analysisText={text} />
        </div>
      )}
    </div>
  );
}

// ── File row inside a commit ─────────────────────────────────────────────────
function FileRow({ cf, fr, commitId, metric }) {
  const [open, setOpen] = useState(false);
  const { name, dir } = shortPath(cf.file);
  const hasFlagged = fr?.findings?.length > 0;

  return (
    <div style={{ borderBottom: '1px solid #f1f3f4' }}>
      {/* Collapsed header — always visible */}
      <div
        onClick={() => setOpen(v => !v)}
        style={{ padding: '9px 18px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', background: open ? '#f8f9fa' : '#fff' }}
      >
        <span style={{ fontSize: 13, flexShrink: 0 }}>📄</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#202124' }}>{name}</span>
          <span style={{ fontSize: 11, color: '#9e9e9e', marginLeft: 6 }}>{dir}</span>
        </span>
        <span style={{ fontSize: 11, color: '#137333', fontWeight: 700, flexShrink: 0 }}>+{cf.addedLineCount}</span>
        <span style={{ fontSize: 11, color: '#c5221f', fontWeight: 700, flexShrink: 0 }}>-{cf.removedLineCount ?? 0}</span>
        {cf.isNew      && <span style={badge('#e6f4ea','#137333')}>new</span>}
        {cf.isDeleted  && <span style={badge('#fce8e6','#c5221f')}>del</span>}
        {cf.isRenamed  && <span style={badge('#fef3cd','#b06000')}>ren</span>}
        {hasFlagged && (
          <span style={badge('#fce8e6','#c5221f')}>
            ⚑ {fr.findings.length}
          </span>
        )}
        <span style={{ fontSize: 12, color: '#9e9e9e', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* Expanded body */}
      {open && (
        <div style={{ padding: '12px 18px 16px', background: '#fafafa', borderTop: '1px solid #f1f3f4' }}>
          <RawDiff rawDiff={cf.rawDiff} />

          {hasFlagged && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#5f6368', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
                Flagged patterns
              </div>
              {fr.findings.map((f, i) => <FindingRow key={i} finding={f} />)}
            </div>
          )}

          <FileAIAnalysis commitSha={commitId} filePath={cf.file} metric={metric} />
        </div>
      )}
    </div>
  );
}

function badge(bg, color) {
  return { fontSize: 10, fontWeight: 700, background: bg, color, padding: '1px 6px', borderRadius: 3, flexShrink: 0 };
}

// ── Commit card ──────────────────────────────────────────────────────────────
function CommitCard({ commit, metric }) {
  const [open, setOpen] = useState(false);
  const r = RISK[commit.riskLevel] || RISK.unknown;
  const allFiles = commit.changedFiles || [];
  const findingsMap = Object.fromEntries((commit.fileResults || []).map(fr => [fr.file, fr]));
  const flaggedCount = commit.fileResults?.length ?? 0;

  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: 10, background: '#fff', marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      {/* Commit row */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        {/* Risk dot */}
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.dot, flexShrink: 0, marginTop: 2 }} />

        {/* SHA + title */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <code style={{ fontSize: 11, color: '#9e9e9e', background: '#f1f3f4', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>{commit.shortId}</code>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#202124', wordBreak: 'break-word' }}>{commit.title}</span>
          </div>
          <div style={{ fontSize: 11, color: '#9e9e9e', marginTop: 3, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>{commit.author}</span>
            <span>{fmtTime(commit.committedAt)}</span>
            {allFiles.length > 0 && <span>{allFiles.length} frontend file{allFiles.length > 1 ? 's' : ''}</span>}
            {commit.mrInfo && <span style={{ color: '#1557b0' }}>MR !{commit.mrInfo.id}</span>}
          </div>
        </div>

        {/* Right side badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {flaggedCount > 0 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: r.color, background: r.bg, padding: '2px 8px', borderRadius: 12 }}>
              {r.label} · {commit.riskScore}pt
            </span>
          )}
          {commit.webUrl && (
            <a href={commit.webUrl} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ fontSize: 11, color: '#1557b0', textDecoration: 'none' }}>↗</a>
          )}
          <span style={{ fontSize: 13, color: '#bdbdbd' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded */}
      {open && (
        <div style={{ borderTop: '1px solid #f1f3f4' }}>
          {commit.mrInfo && (
            <div style={{ padding: '12px 16px 0' }}>
              <MRStrip mr={commit.mrInfo} />
            </div>
          )}
          {allFiles.length === 0
            ? <div style={{ padding: '16px', fontSize: 12, color: '#9e9e9e', fontStyle: 'italic' }}>No frontend files changed.</div>
            : allFiles.map((cf, i) => (
                <FileRow key={i} cf={cf} fr={findingsMap[cf.file]} commitId={commit.id} metric={metric} />
              ))
          }
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function CommitAnalysisPage() {
  const [form, setForm]     = useState({ date: todayStr(), metric: 'both' });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleAnalyze = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const { data } = await axios.post(`${API}/commit-analysis`, form);
      setResult(data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const riskCounts = result
    ? result.commits.reduce((acc, c) => { acc[c.riskLevel] = (acc[c.riskLevel] || 0) + 1; return acc; }, {})
    : null;

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 20px 60px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* ── Top bar ── */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#202124' }}>Commit Impact Analyser</h2>
        <p style={{ margin: 0, fontSize: 13, color: '#5f6368' }}>
          Pick a spike date — scans commits on <strong>monorepo-web-native</strong>, shows every changed file with diff and AI analysis.
        </p>
      </div>

      {/* ── Controls ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 20, padding: '16px 20px', background: '#fff', borderRadius: 10, border: '1px solid #e0e0e0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#5f6368', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Date</label>
          <input type="date" value={form.date} max={todayStr()}
            onChange={e => set('date', e.target.value)}
            style={{ fontSize: 13, padding: '7px 10px', border: '1px solid #dadce0', borderRadius: 7, color: '#202124', outline: 'none', background: '#fff' }} />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#5f6368', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Metric</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { v: 'both', l: 'CLS + INP' },
              { v: 'cls',  l: 'CLS' },
              { v: 'inp',  l: 'INP' },
            ].map(o => (
              <button key={o.v} onClick={() => set('metric', o.v)} style={{
                padding: '7px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                border: '1px solid',
                borderColor: form.metric === o.v ? '#1a73e8' : '#dadce0',
                background: form.metric === o.v ? '#1a73e8' : '#fff',
                color: form.metric === o.v ? '#fff' : '#5f6368',
                fontWeight: form.metric === o.v ? 700 : 400,
              }}>{o.l}</button>
            ))}
          </div>
        </div>

        <button onClick={handleAnalyze} disabled={loading || !form.date} style={{
          padding: '8px 22px', background: loading ? '#9e9e9e' : '#1a73e8', color: '#fff',
          border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700,
          cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 7, alignSelf: 'flex-end',
        }}>
          {loading ? (
            <><span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #fff4', borderTop: '2px solid #fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Analysing...</>
          ) : 'Analyse'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fce8e6', border: '1px solid #f5c6c6', borderRadius: 8, padding: '10px 14px', color: '#c5221f', fontSize: 13, marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      {result && (
        <>
          {/* ── Summary strip ── */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Commits',     value: result.totalCommits,    c: '#5f6368' },
              { label: 'Flagged',     value: result.affectedCommits,  c: '#c5221f' },
              { label: 'High risk',   value: riskCounts?.high   ?? 0, c: '#c5221f' },
              { label: 'Medium risk', value: riskCounts?.medium ?? 0, c: '#b06000' },
              { label: 'Low risk',    value: riskCounts?.low    ?? 0, c: '#1557b0' },
            ].map((s, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '8px 16px', textAlign: 'center', minWidth: 80 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.c }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#9e9e9e', marginTop: 1 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {result.commits.length === 0
            ? <div style={{ textAlign: 'center', padding: 60, color: '#9e9e9e', fontSize: 14 }}>No commits found on {result.date}.</div>
            : result.commits.map(c => <CommitCard key={c.id} commit={c} metric={result.metric} />)
          }
        </>
      )}

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }
      `}</style>
    </div>
  );
}

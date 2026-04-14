import { getStatus } from './Dashboard';

const STATUS_COLORS = {
  good:               { bg: '#e6f4ea', text: '#1e8e3e' },
  'needs-improvement': { bg: '#fef7e0', text: '#f29900' },
  poor:               { bg: '#fce8e6', text: '#d93025' },
  unknown:            { bg: '#f1f3f4', text: '#9aa0a6' },
};

const STATUS_LABELS = {
  good:               'Good',
  'needs-improvement': 'NI',
  poor:               'Poor',
  unknown:            'N/A',
};

function fmt(metric, value) {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (isNaN(num)) return '—';
  if (metric === 'cls') return num.toFixed(3);
  if (metric === 'lcp') return `${(num / 1000).toFixed(2)}s`;
  return `${Math.round(num)}ms`;
}

export default function MetricBadge({ metric, value }) {
  const status = getStatus(metric, value);
  const { bg, text } = STATUS_COLORS[status];

  return (
    <span
      className="metric-badge"
      style={{ background: bg, color: text }}
      title={`${metric.toUpperCase()}: ${fmt(metric, value)}`}
    >
      {fmt(metric, value)}
    </span>
  );
}

export function StatusDot({ status }) {
  const { bg, text } = STATUS_COLORS[status] || STATUS_COLORS.unknown;
  const label = STATUS_LABELS[status] || 'N/A';
  return (
    <span className="status-dot" style={{ background: bg, color: text }}>
      {label}
    </span>
  );
}

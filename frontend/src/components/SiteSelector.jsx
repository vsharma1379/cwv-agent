export default function SiteSelector({ sites, value, onChange }) {
  if (!sites.length) {
    return <div className="select-placeholder">Loading sites...</div>;
  }

  return (
    <select
      className="select site-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">-- Select Search Console Property --</option>
      {sites.map((site) => (
        <option key={site.siteUrl} value={site.siteUrl}>
          {site.siteUrl}
        </option>
      ))}
    </select>
  );
}

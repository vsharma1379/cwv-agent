export default function SearchBar({ value, onChange, placeholder }) {
  const isValidRegex = (() => {
    if (!value) return true;
    try { new RegExp(value); return true; } catch { return false; }
  })();

  return (
    <div className="search-bar-wrap">
      <input
        className={`search-input ${!isValidRegex ? 'invalid' : ''}`}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Search or regex…'}
        spellCheck={false}
      />
      {value && (
        <button className="search-clear" onClick={() => onChange('')}>✕</button>
      )}
      {!isValidRegex && <span className="search-error">Invalid regex</span>}
    </div>
  );
}

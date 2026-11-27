const TOOL = {
  open: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  update: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  pretranslate: <><path d="M4 7h10M4 12h7M4 17h5" /><path d="M15 13l3 3 4-6" /></>,
  validate: <><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><path d="M9 12l2 2 4-4" /></>,
  props: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  build: <><path d="M14 4l6 6-10 10H4v-6z" /><path d="M12 6l6 6" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  ai: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>
};

export function Icon({ name, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TOOL[name]}
    </svg>
  );
}

export function StatusIcon({ st }) {
  if (st === 'done') return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F5BD3" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Done"><path d="M5 12l5 5 9-10" /></svg>;
  if (st === 'review') return <svg width="14" height="14" viewBox="0 0 24 24" role="img" aria-label="Needs review"><circle cx="12" cy="12" r="7" fill="#E08A3C" /></svg>;
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A94A6" strokeWidth="2" role="img" aria-label="Untranslated"><circle cx="12" cy="12" r="6.5" /></svg>;
}

export function WarnIcon({ size = 14, label = 'Has a warning' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#B42318" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      <path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" />
    </svg>
  );
}

export function PageSkeleton({ label = "Loading operational data" }: { label?: string }) {
  return (
    <div className="skeleton-page" role="status" aria-label={label}>
      <span className="sr-only">{label}…</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-strip" />
      <div className="skeleton-grid"><div className="skeleton skeleton-panel" /><div className="skeleton skeleton-panel" /></div>
    </div>
  );
}

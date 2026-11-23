// Placeholders shown while code or data is on its way: the shape of the screen, not a blank one.

export function PageSkeleton() {
  return (
    <div className="shell" aria-busy="true" aria-label="Loading">
      <header className="topbar page-topbar" />
      <main className="page"><div className="skeleton skeleton-title" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton skeleton-short" /></main>
    </div>
  );
}

/** Before we know who is signed in. Matches the static placeholder in index.html. */
export function BootSkeleton() {
  return <div className="boot" aria-busy="true" aria-label="Loading"><div className="boot-side" /><div className="boot-main"><div className="skeleton skeleton-title" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton skeleton-short" /></div></div>;
}

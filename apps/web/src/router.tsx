import { useEffect, useState } from 'react';

// A tiny history router: /, /login, /p/:pageId, /s/:shareToken
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return loc;
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

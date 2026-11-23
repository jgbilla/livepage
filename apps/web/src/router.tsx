import { createContext, useContext, useEffect, useState } from 'react';

// A tiny history router: /, /login, /p/:pageId, /s/:shareToken
//
// Workspace tabs (tabs.ts) plug in through `routerHooks`: they tag each history entry with the
// open tab it belongs to, turn a link clicked in a pinned tab into a new tab, and handle
// "open in new tab". Without them this is a plain history router.
export type OpenTabOptions = { background?: boolean; split?: boolean };
export const routerHooks: {
  state?: () => unknown;
  beforePush?: (to: string) => boolean;
  openTab?: (to: string, opts?: OpenTabOptions) => void;
} = {};

export function navigate(to: string, replace = false) {
  if (!replace && routerHooks.beforePush?.(to)) return;
  const state = routerHooks.state?.() ?? null;
  if (replace) history.replaceState(state, '', to);
  else history.pushState(state, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

/** Open a path in a new workspace tab (a new browser tab when there are no workspace tabs). */
export function openTab(to: string, opts?: OpenTabOptions) {
  if (routerHooks.openTab) routerHooks.openTab(to, opts);
  else window.open(to, '_blank');
}

/** Cmd/Ctrl-click opens a new tab, Cmd/Ctrl+Alt-click opens it side by side. Returns true when handled. */
export function openTabFromClick(e: React.MouseEvent | MouseEvent, to: string): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return false;
  e.preventDefault();
  openTab(to, { split: e.altKey });
  return true;
}

/** Props that make an element open `to` in a background tab on middle-click. */
export function middleClickOpens(to: string) {
  return {
    onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); }, // no autoscroll
    onAuxClick: (e: React.MouseEvent) => { if (e.button !== 1) return; e.preventDefault(); openTab(to, { background: true }); },
  };
}

/**
 * Each open workspace tab renders its screen inside a Pane, with its own location. A tab in the
 * background, or in the other half of a split, keeps its own path instead of following the URL bar.
 */
export type Pane = { path: string; search: string; focused: boolean; navigate: (to: string, replace?: boolean) => void };
export const PaneContext = createContext<Pane | null>(null);

function useWindowLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc((l) => (l.path === location.pathname && l.search === location.search ? l : { path: location.pathname, search: location.search }));
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return loc;
}

/** The location of the tab this component is in (the URL bar's, outside tabs). */
export function useLocation() {
  const pane = useContext(PaneContext);
  const win = useWindowLocation();
  return pane ? { path: pane.path, search: pane.search } : win;
}

/** navigate() for the tab this component is in: a tab that is not focused changes only its own path. */
export function useNavigate(): (to: string, replace?: boolean) => void {
  return useContext(PaneContext)?.navigate ?? navigate;
}

export function Link({ to, children, className, title }: { to: string; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <a href={to} className={className} title={title} {...middleClickOpens(to)}
      onClick={(e) => { if (openTabFromClick(e, to) || e.shiftKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

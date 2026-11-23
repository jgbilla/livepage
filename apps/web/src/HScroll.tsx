// A row that scrolls sideways (page tabs, open tabs): edge fades with arrow buttons where there is
// more to see, the active item kept in view, and no rubber-banding into empty space.
// The fades are separate elements over the row, never a mask-image on the scroller itself: iOS Safari
// stops painting a masked scroller's content mid-scroll, which left an empty strip on phones.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './design/Icon';

type Edges = { start: boolean; end: boolean };
const ACTIVE = '[aria-selected="true"], .tab-active';

/** `active` changes when the selected item changes; it is then scrolled into view. */
export function useHScroll<T extends HTMLElement>(active?: unknown) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { start: el.scrollLeft > 2, end: el.scrollLeft < max - 2 };
      setEdges((e) => (e.start === next.start && e.end === next.end ? e : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update); // tabs added, removed or renamed
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); mo.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    const a = el?.querySelector<HTMLElement>(ACTIVE);
    if (!el || !a || el.scrollWidth <= el.clientWidth) return;
    const er = el.getBoundingClientRect(), ar = a.getBoundingClientRect(), pad = 40; // clear of the fades
    if (ar.left < er.left + pad) el.scrollLeft += ar.left - er.left - pad;
    else if (ar.right > er.right - pad) el.scrollLeft += ar.right - er.right + pad;
  }, [active]);
  const nudge = (dir: 1 | -1) => { const el = ref.current; el?.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' }); };
  return { ref, edges, nudge };
}

/** The fade and arrow at each end that has more to scroll to. Put inside a `.hscroll` wrapper, after the row. */
export function HScrollEdges({ edges, nudge }: { edges: Edges; nudge: (dir: 1 | -1) => void }) {
  return (
    <>
      <button type="button" className={`hscroll-edge hscroll-start ${edges.start ? 'on' : ''}`} tabIndex={-1} aria-hidden="true" onClick={() => nudge(-1)}>
        <Icon name="chevron-right" style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button type="button" className={`hscroll-edge hscroll-end ${edges.end ? 'on' : ''}`} tabIndex={-1} aria-hidden="true" onClick={() => nudge(1)}>
        <Icon name="chevron-right" />
      </button>
    </>
  );
}

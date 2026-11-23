// Obsidian-style graph of how your pages link together. Each dot is a page you can open (bigger
// = more links), each line is a [[link]]. Hover to see a page's neighbours, click to open it,
// drag dots around, scroll or pinch to zoom, drag the background to pan.
// /graph shows everything; /graph?page=<id> is the local graph around one page.
import { Icon } from '../design/Icon';
import { onThemeChange } from '../design/theme';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { api } from '../api';
import { Link, navigate, useLocation } from '../router';
import { SidebarToggle } from '../Sidebar';

type ApiGraph = {
  nodes: { id: string; title: string; tags: string[]; links: number }[];
  edges: { source: string; target: string; count: number }[];
};
type N = SimulationNodeDatum & { id: string; title: string; kind: 'page' | 'tag'; tags: string[]; degree: number };
type E = SimulationLinkDatum<N> & { kind: 'link' | 'tag' };

// Categorical tag hues (DESIGN.md --lp-cat-1..8): never the accent, which marks the focused or hovered page, nor agent violet.
const TAG_COLORS = ['#1b6ec2', '#2b8a3e', '#c2255c', '#b5650a', '#0b7d8f', '#d4520f', '#4f7a12', '#8a6d3b'];
const tagColor = (tag: string) => {
  let h = 0;
  for (const c of tag.split('/')[0]) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
};
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function GraphScreen() {
  const { search } = useLocation();
  const focus = new URLSearchParams(search).get('page');
  const [data, setData] = useState<ApiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showTags, setShowTags] = useState(() => store.get('lp.graph.tags') === '1');
  const [showOrphans, setShowOrphans] = useState(() => store.get('lp.graph.orphans') !== '0');
  const [depth, setDepth] = useState(() => Number(store.get('lp.graph.depth') ?? 1) || 1);

  useEffect(() => { api<ApiGraph>('/graph').then(setData).catch((e) => setError(e.message)); }, []);

  const graph = useMemo(() => {
    if (!data) return null;
    let pages = data.nodes;
    let edges = data.edges;
    if (focus) {
      // Local graph: pages within `depth` links of the focused page, in either direction.
      const adj = new Map<string, Set<string>>();
      for (const e of edges) {
        if (!adj.has(e.source)) adj.set(e.source, new Set());
        if (!adj.has(e.target)) adj.set(e.target, new Set());
        adj.get(e.source)!.add(e.target);
        adj.get(e.target)!.add(e.source);
      }
      const keep = new Set([focus]);
      let frontier = [focus];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) { keep.add(n); next.push(n); }
        frontier = next;
      }
      pages = pages.filter((p) => keep.has(p.id));
      edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    } else if (!showOrphans) {
      pages = pages.filter((p) => p.links > 0 || (showTags && p.tags.length > 0));
    }
    const nodes: N[] = pages.map((p) => ({ id: p.id, title: p.title || 'Untitled', kind: 'page', tags: p.tags, degree: 0 }));
    const links: E[] = edges.map((e) => ({ source: e.source, target: e.target, kind: 'link' }));
    if (showTags) {
      const tags = new Set(pages.flatMap((p) => p.tags));
      for (const t of tags) nodes.push({ id: `#${t}`, title: `#${t}`, kind: 'tag', tags: [t], degree: 0 });
      for (const p of pages) for (const t of p.tags) links.push({ source: p.id, target: `#${t}`, kind: 'tag' });
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const l of links) {
      byId.get(l.source as string)!.degree++;
      byId.get(l.target as string)!.degree++;
    }
    return { nodes, links };
  }, [data, focus, depth, showTags, showOrphans]);

  const focusTitle = focus ? data?.nodes.find((n) => n.id === focus)?.title || 'Untitled' : null;
  const pageCount = graph?.nodes.filter((n) => n.kind === 'page').length ?? 0;
  const linkCount = graph?.links.filter((l) => l.kind === 'link').length ?? 0;

  return (
    <div className="graph-screen">
      <header className="topbar">
        <SidebarToggle />
        <h1 className="panel-title"><Icon name="graph" />{focus ? <>Graph around <Link to={`/p/${focus}`}>{focusTitle}</Link></> : 'Graph'}</h1>
        {graph && <span className="muted small graph-count">{pageCount} pages · {linkCount} links</span>}
        <span style={{ flex: 1 }} />
        <input className="name-input graph-filter" placeholder="Filter by title or #tag" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {focus ? (
          <>
            <label className="small graph-opt">Depth
              <select value={depth} onChange={(e) => { setDepth(Number(e.target.value)); store.set('lp.graph.depth', e.target.value); }}>
                {[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <Link to="/graph" className="small">All pages</Link>
          </>
        ) : (
          <label className="small graph-opt">
            <input type="checkbox" checked={showOrphans} onChange={(e) => { setShowOrphans(e.target.checked); store.set('lp.graph.orphans', e.target.checked ? '1' : '0'); }} />
            Unlinked pages
          </label>
        )}
        <label className="small graph-opt">
          <input type="checkbox" checked={showTags} onChange={(e) => { setShowTags(e.target.checked); store.set('lp.graph.tags', e.target.checked ? '1' : '0'); }} />
          Tags
        </label>
      </header>
      {error ? <div className="center"><p>{error}</p></div>
        : !graph ? <div className="center muted">Loading…</div>
        : !graph.nodes.length ? (
          <div className="center muted"><p>No pages to show yet. Link pages with <code>[[</code> and they show up here.</p></div>
        )
        : <GraphCanvas key={`${focus}|${depth}|${showTags}|${showOrphans}`} graph={graph} focus={focus} filter={filter} />}
    </div>
  );
}

function GraphCanvas({ graph, focus, filter }: { graph: { nodes: N[]; links: E[] }; focus: string | null; filter: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const nodes = graph.nodes;
    const links = graph.links;
    const neighbours = new Map<string, Set<string>>();
    for (const n of nodes) neighbours.set(n.id, new Set());
    for (const l of links) {
      neighbours.get(l.source as string)?.add(l.target as string);
      neighbours.get(l.target as string)?.add(l.source as string);
    }
    const radius = (n: N) => (n.kind === 'tag' ? 3.5 : 4 + Math.sqrt(n.degree) * 2.2);

    let width = 0, height = 0, dpr = 1;
    const view = { x: 0, y: 0, k: 1 }; // screen = world * k + (x, y)
    let hover: N | null = null;
    let dragging: N | null = null;
    let panning: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let moved = false;
    let fitted = false;

    const colors = () => {
      const cs = getComputedStyle(document.documentElement);
      const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
      return { fg: v('--lp-text', '#1f1d1a'), muted: v('--lp-text-tertiary', '#8a857c'), line: v('--lp-border-strong', '#d4d0c8'), accent: v('--lp-accent', '#2f5bd3'), bg: v('--lp-bg', '#fcfbf9') };
    };
    let pal = colors();
    const offTheme = onThemeChange(() => { pal = colors(); draw(); });

    const sim: Simulation<N, E> = forceSimulation(nodes)
      .force('link', forceLink<N, E>(links).id((n) => n.id).distance((l) => (l.kind === 'tag' ? 40 : 60)).strength((l) => (l.kind === 'tag' ? 0.3 : 0.6)))
      .force('charge', forceManyBody<N>().strength(-120).distanceMax(400))
      .force('center', forceCenter(0, 0))
      .force('x', forceX<N>(0).strength(0.04))
      .force('y', forceY<N>(0).strength(0.04))
      .force('collide', forceCollide<N>((n) => radius(n) + 3))
      .on('tick', () => { if (!fitted && sim.alpha() < 0.3) fit(); draw(); });
    if (focus) {
      const f = nodes.find((n) => n.id === focus);
      if (f) { f.fx = 0; f.fy = 0; }
    }

    function fit() {
      fitted = true;
      if (!nodes.length) return;
      const xs = nodes.map((n) => n.x ?? 0), ys = nodes.map((n) => n.y ?? 0);
      const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40, minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + 40;
      view.k = Math.max(0.2, Math.min(2, Math.min(width / (maxX - minX), height / (maxY - minY))));
      view.x = width / 2 - ((minX + maxX) / 2) * view.k;
      view.y = height / 2 - ((minY + maxY) / 2) * view.k;
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = devicePixelRatio || 1;
      const first = !width;
      width = r.width; height = r.height;
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      if (first) { view.x = width / 2; view.y = height / 2; }
      draw();
    }

    const matches = (n: N) => {
      const f = filterRef.current.trim().toLowerCase();
      if (!f) return true;
      if (f.startsWith('#')) return n.tags.some((t) => t === f.slice(1) || t.startsWith(f.slice(1)));
      return n.title.toLowerCase().includes(f);
    };

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);
      const lit = hover ? neighbours.get(hover.id)! : null;
      const filtering = !!filterRef.current.trim();
      const on = (n: N) => (hover ? n === hover || lit!.has(n.id) : !filtering || matches(n));

      for (const l of links) {
        const s = l.source as N, t = l.target as N;
        const active = hover && (s === hover || t === hover);
        ctx.globalAlpha = hover ? (active ? 0.9 : 0.08) : filtering ? (on(s) && on(t) ? 0.6 : 0.08) : 0.5;
        ctx.strokeStyle = active ? pal.accent : l.kind === 'tag' ? pal.line : pal.muted;
        ctx.lineWidth = (active ? 1.6 : 1) / Math.sqrt(view.k);
        ctx.setLineDash(l.kind === 'tag' ? [3 / view.k, 3 / view.k] : []);
        ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.lineTo(t.x!, t.y!); ctx.stroke();
        if (l.kind === 'link' && (active || view.k > 1.2)) arrow(s, t);
      }
      ctx.setLineDash([]);

      for (const n of nodes) {
        const r = radius(n);
        ctx.globalAlpha = on(n) ? 1 : 0.15;
        ctx.fillStyle = n === hover || n.id === focus ? pal.accent : n.kind === 'tag' ? tagColor(n.tags[0]) : n.tags.length ? tagColor(n.tags[0]) : pal.muted;
        ctx.beginPath();
        if (n.kind === 'tag') { ctx.rect(n.x! - r, n.y! - r, r * 2, r * 2); } else { ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2); }
        ctx.fill();
        if (n.id === focus) { ctx.strokeStyle = pal.accent; ctx.lineWidth = 2 / view.k; ctx.beginPath(); ctx.arc(n.x!, n.y!, r + 3, 0, Math.PI * 2); ctx.stroke(); }
      }

      // Labels: always for the hovered page and its neighbours, the focus, filter hits and big hubs; for everyone when zoomed in.
      ctx.font = `500 ${12 / view.k}px ${getComputedStyle(document.documentElement).getPropertyValue('--lp-font-sans') || 'system-ui, sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of nodes) {
        const show = view.k > 1.1 || n === hover || n.id === focus || (lit && lit.has(n.id)) || (filtering && matches(n)) || n.degree >= 6 || nodes.length < 25;
        if (!show) continue;
        ctx.globalAlpha = on(n) ? (n === hover ? 1 : 0.85) : 0.15;
        const label = n.title.length > 40 ? `${n.title.slice(0, 39)}…` : n.title;
        const y = n.y! + radius(n) + 3 / view.k;
        ctx.lineWidth = 3 / view.k; ctx.strokeStyle = pal.bg; ctx.strokeText(label, n.x!, y);
        ctx.fillStyle = n === hover ? pal.fg : n.kind === 'tag' ? tagColor(n.tags[0]) : pal.fg;
        ctx.fillText(label, n.x!, y);
      }
      ctx.globalAlpha = 1;
    }
    drawRef.current = draw;

    function arrow(s: N, t: N) {
      const dx = t.x! - s.x!, dy = t.y! - s.y!, len = Math.hypot(dx, dy) || 1;
      const r = radius(t) + 2;
      const x = t.x! - (dx / len) * r, y = t.y! - (dy / len) * r;
      const a = Math.atan2(dy, dx), size = 5 / Math.sqrt(view.k);
      ctx.fillStyle = ctx.strokeStyle as string;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - size * Math.cos(a - 0.45), y - size * Math.sin(a - 0.45));
      ctx.lineTo(x - size * Math.cos(a + 0.45), y - size * Math.sin(a + 0.45));
      ctx.fill();
    }

    const toWorld = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
    };
    const nodeAt = (e: { clientX: number; clientY: number }) => {
      const p = toWorld(e);
      let best: N | null = null, bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < radius(n) + 6 / view.k && d < bestD) { best = n; bestD = d; }
      }
      return best;
    };

    // Two fingers pinch to zoom on touch screens.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; k: number; vx: number; vy: number; mx: number; my: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      const r = canvas.getBoundingClientRect();
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          if (dragging) { dragging.fx = null; dragging.fy = null; sim.alphaTarget(0); dragging = null; }
          panning = null; moved = true;
          pinch = { ...pinchState(), k: view.k, vx: view.x, vy: view.y };
          return;
        }
      }
      moved = false;
      const n = nodeAt(e);
      if (n) { dragging = n; n.fx = n.x; n.fy = n.y; sim.alphaTarget(0.25).restart(); }
      else panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    };
    const onMove = (e: PointerEvent) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const now = pinchState();
        const k = Math.max(0.1, Math.min(6, pinch.k * (now.d / pinch.d)));
        view.k = k;
        view.x = now.mx - ((pinch.mx - pinch.vx) / pinch.k) * k;
        view.y = now.my - ((pinch.my - pinch.vy) / pinch.k) * k;
        draw();
        return;
      }
      if (dragging) {
        const p = toWorld(e);
        dragging.fx = p.x; dragging.fy = p.y; moved = true;
      } else if (panning) {
        view.x = panning.vx + e.clientX - panning.sx; view.y = panning.vy + e.clientY - panning.sy;
        if (Math.abs(e.clientX - panning.sx) + Math.abs(e.clientY - panning.sy) > 3) moved = true;
        draw();
      } else {
        const n = nodeAt(e);
        if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; canvas.title = n ? n.title : ''; draw(); }
      }
    };
    const onUp = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (pinch) { if (touches.size < 2) pinch = null; panning = null; return; }
      const n = dragging;
      if (n) {
        sim.alphaTarget(0);
        if (n.id !== focus) { n.fx = null; n.fy = null; }
      }
      dragging = null; panning = null;
      if (n && !moved) {
        if (n.kind === 'tag') navigate(`/tag/${encodeURIComponent(n.tags[0])}`);
        else if (e.metaKey || e.ctrlKey) window.open(`/p/${n.id}`, '_blank');
        else navigate(`/p/${n.id}`);
      }
    };
    const onLeave = () => { if (hover && !dragging) { hover = null; draw(); } };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.max(0.1, Math.min(6, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
      view.x = mx - ((mx - view.x) / view.k) * k;
      view.y = my - ((my - view.y) / view.k) * k;
      view.k = k;
      draw();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      sim.stop();
      ro.disconnect();
      offTheme();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [graph, focus]);

  useEffect(() => { drawRef.current(); }, [filter]);

  return <canvas ref={canvasRef} className="graph-canvas" aria-label="Graph of links between pages" style={{ cursor: 'grab' }} />;
}

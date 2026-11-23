// Search across every page a person can open, and the graph of links between those pages.
// Both read the Postgres projections the collab server keeps up to date on each save
// (pages.title, blocks.text, page_tags, page_links), so neither opens a live document.
import type { Db } from './db.ts';
import type { Principal } from './auth.ts';

export type SearchHit = {
  id: string;
  title: string;
  updated_at: string;
  tags: string[];
  /** Where the first match in the body is, so the switcher can jump to its tab. */
  tab: string | null;
  block: string | null;
  snippet: string;
  in_title: boolean;
};

/** "book  notes" -> ['%book%', '%notes%'] with LIKE wildcards in the words escaped. At most 8 words. */
export function searchTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
    .map((w) => `%${w.slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** SQL: can the person open page `alias`? $super is the dev-agent flag, $user their id. */
const canOpen = (alias: string, sup: string, user: string) =>
  `(${sup}::boolean or exists (select 1 from page_members m where m.page_id = ${alias}.id and m.user_id = ${user}))`;
const LINK_TOKEN = /\[\[(p_[\w-]{8,40})(?:#[\w-]{1,60})?(?:\|([^\]\n]{0,200}))?\]\]/g;

/**
 * Pages where every word of the query appears in the title, the tags or the text of any block
 * (paragraphs, headings, tables, mind maps, and the code of HTML blocks). Title matches first,
 * then the most recently edited. Only pages this person is a member of (or any page for the dev agent).
 */
export async function searchPages(db: Db, who: Principal, q: string, limit = 20): Promise<SearchHit[]> {
  const terms = searchTerms(q);
  if (!terms.length) return [];
  limit = Math.max(1, Math.min(50, limit));
  const rows = await db.query(
    `select p.id, p.title, p.updated_at, (p.title ilike all($1::text[])) as in_title, coalesce(g.tags, '{}') as tags
       from pages p
       left join lateral (select string_agg(b.text, ' ') as body from blocks b where b.doc_name = p.id) d on true
       left join lateral (select array_agg(t.tag order by t.tag) as tags from page_tags t where t.page_id = p.id) g on true
      where ${canOpen('p', '$2', '$3')}
        and (p.title || ' ' || coalesce(d.body, '') || ' ' || coalesce(array_to_string(g.tags, ' '), '')) ilike all($1::text[])
      order by in_title desc, p.updated_at desc
      limit $4`,
    [terms, !!who.superAgent, who.id, limit],
  );
  if (!rows.length) return [];

  // The first block in each page that holds any of the words: writing before HTML code, main tab first.
  const ids = rows.map((r) => r.id);
  const blocks = await db.query(
    `select distinct on (doc_name) doc_name, id, tab, text from blocks
      where doc_name = any($1::text[]) and text ilike any($2::text[])
      order by doc_name, (type = 'htmlBlock'), (tab <> 'main'), position`,
    [ids, terms],
  );
  const firstBlock = new Map(blocks.map((b) => [b.doc_name as string, b]));

  // Show [[p_id]] link tokens in snippets as the linked page's title.
  const linked = new Set<string>();
  for (const b of blocks) for (const m of String(b.text).matchAll(LINK_TOKEN)) linked.add(m[1]);
  const titles = new Map<string, string>(
    linked.size ? (await db.query('select id, title from pages where id = any($1::text[])', [[...linked]])).map((r) => [r.id, r.title]) : [],
  );

  const words = terms.map((t) => t.slice(1, -1).replace(/\\(.)/g, '$1'));
  return rows.map((r) => {
    const b = firstBlock.get(r.id);
    const text = b ? String(b.text).replace(LINK_TOKEN, (_, id, label) => label || titles.get(id) || 'Untitled') : '';
    return {
      id: r.id, title: r.title, updated_at: r.updated_at, in_title: !!r.in_title,
      tags: Array.isArray(r.tags) ? r.tags : [],
      tab: b?.tab ?? null, block: b?.id ?? null,
      snippet: snippetAround(text, words),
    };
  });
}

/** About 160 characters of text around the first word found, on one line. */
export function snippetAround(text: string, words: string[], width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), flat.length);
  if (at >= flat.length) return `${flat.slice(0, width).trimEnd()}…`;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

export type GraphNode = { id: string; title: string; tags: string[]; updated_at: string; links: number };
export type GraphEdge = { source: string; target: string; count: number };

/**
 * Pages this person can open and the links between them (one edge per pair of pages and direction,
 * with how many links it stands for). Links to pages they cannot open are left out, so the graph
 * never reveals a page's title or existence to someone without access.
 */
export async function linkGraph(db: Db, who: Principal): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const params = [!!who.superAgent, who.id];
  const access = (alias: string) => canOpen(alias, '$1', '$2');
  const [nodes, edges, tags] = await Promise.all([
    db.query(`select p.id, p.title, p.updated_at from pages p where ${access('p')} order by p.updated_at desc limit 5000`, params),
    db.query(
      `select l.from_page as source, l.to_page as target, count(*)::int as count
         from page_links l join pages p on p.id = l.from_page join pages t on t.id = l.to_page
        where ${access('p')} and ${access('t')} and l.from_page <> l.to_page
        group by l.from_page, l.to_page`,
      params,
    ),
    db.query(`select t.page_id, t.tag from page_tags t join pages p on p.id = t.page_id where ${access('p')} order by t.tag`, params),
  ]);
  const tagMap = new Map<string, string[]>();
  for (const t of tags) tagMap.set(t.page_id, [...(tagMap.get(t.page_id) ?? []), t.tag]);
  const known = new Set(nodes.map((n) => n.id as string));
  const kept = edges.filter((e) => known.has(e.source) && known.has(e.target)).map((e) => ({ ...e, count: Number(e.count) }));
  const degree = new Map<string, number>();
  for (const e of kept) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: nodes.map((n) => ({ id: n.id, title: n.title, updated_at: n.updated_at, tags: tagMap.get(n.id) ?? [], links: degree.get(n.id) ?? 0 })),
    edges: kept,
  };
}

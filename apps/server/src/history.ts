// Version history: saved snapshots of a page, who changed it between them, diffs, and restore.
//
// How versions are cut. For every open page the server keeps a "shadow" copy of the Y.Doc that
// lags the live doc by the changes not yet saved in a version. Every change is credited to the
// person or agent whose connection made it. A version is saved:
//   - when someone of a different kind starts editing (a person after an agent, or an agent after
//     a person): the shadow, which is the page just before their first change, is saved first, so
//     an agent's edits always land in their own version and are easy to review or roll back;
//   - after the page has been quiet for IDLE_MS, and at least every MAX_SPAN_MS while editing goes on;
//   - when the page is unloaded from memory (everyone left), and before and after a restore.
//
// Storage stays small (Neon's free plan is 0.5 GB): each version is the full Yjs state, deflated,
// and old versions are thinned out (see prune) so a page keeps at most MAX_VERSIONS.
import { deflateSync, inflateSync } from 'node:zlib';
import * as Y from 'yjs';
import { diffArrays, diffWords } from 'diff';
import { FRAGMENT, listBlocks, listTabs, META, type BlockRow } from '@livepage/schema';
import type { Db } from './db.ts';
import { randomId } from './auth.ts';

export type Author = { id: string; name: string; kind: 'human' | 'agent' };
export type VersionReason = 'baseline' | 'edit' | 'restore' | 'before-restore';

const IDLE_MS = Number(process.env.VERSION_IDLE_MS ?? 3 * 60_000);
const MAX_SPAN_MS = Number(process.env.VERSION_MAX_SPAN_MS ?? 15 * 60_000);
const MAX_VERSIONS = 200;
const DAY = 86_400_000;

export const VERSIONS_SQL = `
create table if not exists page_versions (
  id          text primary key,
  page_id     text not null references pages(id) on delete cascade,
  created_at  timestamptz not null default now(),
  reason      text not null default 'edit',
  authors     jsonb not null default '[]',
  summary     jsonb not null default '{}',
  restored_from text,
  bytes       int not null default 0,
  data        bytea not null
);
create index if not exists page_versions_page_idx on page_versions (page_id, created_at desc);
`;

type Pending = {
  shadow: Y.Doc;
  authors: Map<string, Author>;
  since: number; // first unsaved change
  idle?: NodeJS.Timeout;
  chain: Promise<unknown>; // saves for one page run one after another
  inMemory: boolean; // false once Hocuspocus unloaded the page; tracking ends at the next save
};

const authorKey = (a: Author) => `${a.kind}:${a.id}:${a.name}`;
const pack = (state: Uint8Array) => deflateSync(state, { level: 9 });
const unpack = (data: Uint8Array) => new Uint8Array(inflateSync(data));

function docFrom(state: Uint8Array, gc = true): Y.Doc {
  const d = new Y.Doc({ gc });
  Y.applyUpdate(d, state);
  return d;
}

/** Plain content of a doc, used for summaries, diffs and change detection. */
function contentOf(doc: Y.Doc) {
  return {
    title: String(doc.getMap(META).get('title') ?? ''),
    tabs: listTabs(doc),
    // Empty paragraphs (the editor keeps one after a block) are not worth showing as changes.
    blocks: listBlocks(doc).filter((b) => !(b.type === 'paragraph' && !b.text.trim())),
  };
}
type Content = ReturnType<typeof contentOf>;
const sameContent = (a: Content, b: Content) =>
  a.title === b.title && JSON.stringify(a.tabs) === JSON.stringify(b.tabs) &&
  JSON.stringify(a.blocks.map(blockKey)) === JSON.stringify(b.blocks.map(blockKey));

// Two blocks are "the same" when type, text and visible attributes match. Positions are ignored.
function blockKey(b: BlockRow): string {
  const { blockId: _id, ...attrs } = b.attrs as Record<string, unknown>;
  return `${b.tab}\u0000${b.type}\u0000${b.text}\u0000${JSON.stringify(attrs)}`;
}

export type BlockChange =
  | { op: 'same'; block: BlockRow }
  | { op: 'added'; block: BlockRow }
  | { op: 'removed'; block: BlockRow }
  | { op: 'changed'; block: BlockRow; before: BlockRow; words: { value: string; added?: boolean; removed?: boolean }[] };

export type PageDiff = {
  title: { before: string; after: string } | null;
  tabs: { id: string; title: string; changes: BlockChange[] }[];
  counts: { added: number; removed: number; changed: number };
};

/** Block-level diff of two page states (per tab), with a word diff for edited blocks. */
export function diffContent(before: Content, after: Content): PageDiff {
  const tabIds = [...new Set([...after.tabs.map((t) => t.id), ...before.tabs.map((t) => t.id)])];
  const tabTitle = (id: string) => after.tabs.find((t) => t.id === id)?.title ?? before.tabs.find((t) => t.id === id)?.title ?? id;
  const counts = { added: 0, removed: 0, changed: 0 };
  const tabs = tabIds.map((id) => {
    const a = before.blocks.filter((b) => b.tab === id);
    const b = after.blocks.filter((x) => x.tab === id);
    const parts = diffArrays(a.map(blockKey), b.map(blockKey));
    const changes: BlockChange[] = [];
    let ia = 0, ib = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.added && !p.removed) {
        for (let k = 0; k < p.count!; k++) changes.push({ op: 'same', block: b[ib + k] });
        ia += p.count!; ib += p.count!;
        continue;
      }
      // A removed run followed by an added run: pair blocks of the same type as edits.
      const next = parts[i + 1];
      if (p.removed && next?.added) {
        const removed = a.slice(ia, ia + p.count!);
        const added = b.slice(ib, ib + next.count!);
        const n = Math.max(removed.length, added.length);
        for (let k = 0; k < n; k++) {
          const r = removed[k], x = added[k];
          if (r && x && r.type === x.type) {
            changes.push({ op: 'changed', block: x, before: r, words: diffWords(r.text, x.text).map(({ value, added, removed }) => ({ value, added, removed })) });
            counts.changed++;
          } else {
            if (r) { changes.push({ op: 'removed', block: r }); counts.removed++; }
            if (x) { changes.push({ op: 'added', block: x }); counts.added++; }
          }
        }
        ia += p.count!; ib += next.count!; i++;
        continue;
      }
      if (p.removed) {
        for (let k = 0; k < p.count!; k++) changes.push({ op: 'removed', block: a[ia + k] });
        counts.removed += p.count!; ia += p.count!;
      } else {
        for (let k = 0; k < p.count!; k++) changes.push({ op: 'added', block: b[ib + k] });
        counts.added += p.count!; ib += p.count!;
      }
    }
    return { id, title: tabTitle(id), changes };
  });
  const title = before.title !== after.title ? { before: before.title, after: after.title } : null;
  return { title, tabs, counts };
}

export function createHistory(db: Db) {
  const open = new Map<string, Pending>();

  async function latest(pageId: string): Promise<{ id: string; state: Uint8Array } | null> {
    const [row] = await db.query('select id, data from page_versions where page_id = $1 order by created_at desc limit 1', [pageId]);
    return row ? { id: row.id, state: unpack(row.data) } : null;
  }

  /** Save `state` as a version unless it matches the latest one. Returns the new id (or null). */
  async function save(pageId: string, state: Uint8Array, authors: Author[], reason: VersionReason, restoredFrom?: string): Promise<string | null> {
    const [page] = await db.query('select 1 from pages where id = $1', [pageId]);
    if (!page) return null; // page was deleted
    const prev = await latest(pageId);
    const now = contentOf(docFrom(state));
    const before = prev ? contentOf(docFrom(prev.state)) : { title: '', tabs: now.tabs, blocks: [] };
    if (prev && reason !== 'restore' && sameContent(before, now)) {
      // Nothing visible changed (e.g. only cursor moves or a no-op): credit the authors to the latest version.
      if (authors.length) await mergeAuthors(prev.id, authors);
      return null;
    }
    const d = diffContent(before, now);
    const summary = { ...d.counts, title: d.title ? true : undefined, words: wordCount(now.blocks) };
    const data = pack(state);
    const id = randomId('v', 9);
    await db.query(
      `insert into page_versions (id, page_id, reason, authors, summary, restored_from, bytes, data)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, pageId, reason, JSON.stringify(authors), JSON.stringify(summary), restoredFrom ?? null, data.length, data],
    );
    await prune(pageId);
    return id;
  }

  async function mergeAuthors(versionId: string, extra: Author[]) {
    const [row] = await db.query('select authors from page_versions where id = $1', [versionId]);
    if (!row) return;
    const all = new Map<string, Author>((row.authors as Author[]).map((a) => [authorKey(a), a]));
    extra.forEach((a) => all.set(authorKey(a), a));
    await db.query('update page_versions set authors = $2 where id = $1', [versionId, JSON.stringify([...all.values()])]);
  }

  /** Keep every version from the last 2 days, then one per hour up to 30 days, then one per day,
   *  and at most MAX_VERSIONS. Authors of a dropped version move to the next kept one. */
  async function prune(pageId: string) {
    const rows = await db.query<{ id: string; created_at: Date; reason: string; authors: Author[] }>(
      'select id, created_at, reason, authors from page_versions where page_id = $1 order by created_at asc', [pageId]);
    const now = Date.now();
    const bucket = (t: number) => {
      const age = now - t;
      if (age < 2 * DAY) return `all:${t}`;
      if (age < 30 * DAY) return `h:${Math.floor(t / 3_600_000)}`;
      return `d:${Math.floor(t / DAY)}`;
    };
    // Within a bucket keep the newest version (the state at the end of that hour or day).
    const keep = new Set<string>();
    const lastIn = new Map<string, string>();
    rows.forEach((r) => lastIn.set(bucket(new Date(r.created_at).getTime()), r.id));
    lastIn.forEach((id) => keep.add(id));
    keep.add(rows[0]?.id); // the oldest one is the baseline for diffs
    const kept = rows.filter((r) => keep.has(r.id));
    const overflow = kept.length - MAX_VERSIONS;
    if (overflow > 0) kept.slice(1, 1 + overflow).forEach((r) => keep.delete(r.id));
    const drop = rows.filter((r) => !keep.has(r.id));
    if (!drop.length) return;
    let carry: Author[] = [];
    await db.tx(async (q) => {
      for (const r of rows) {
        if (!keep.has(r.id)) { carry = [...carry, ...(r.authors ?? [])]; continue; }
        if (carry.length) {
          const all = new Map<string, Author>([...carry, ...(r.authors ?? [])].map((a) => [authorKey(a), a]));
          await q('update page_versions set authors = $2 where id = $1', [r.id, JSON.stringify([...all.values()])]);
          carry = [];
        }
      }
      await q('delete from page_versions where id = any($1)', [drop.map((r) => r.id)]);
    });
  }

  function enqueue<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
    const p = open.get(pageId);
    const run = (p?.chain ?? Promise.resolve()).then(fn, fn);
    if (p) p.chain = run.catch((e) => console.warn('[history]', pageId, (e as Error).message));
    return run;
  }

  /** Save what is pending for a page (the shadow, which equals the live doc unless called mid-change). */
  function cut(pageId: string, reason: VersionReason = 'edit'): Promise<string | null> {
    const p = open.get(pageId);
    if (!p || !p.authors.size) return Promise.resolve(null);
    const state = Y.encodeStateAsUpdate(p.shadow);
    const authors = [...p.authors.values()];
    p.authors.clear();
    clearTimeout(p.idle);
    const saved = enqueue(pageId, () => save(pageId, state, authors, reason));
    if (!p.inMemory) forget(pageId);
    return saved;
  }

  function forget(pageId: string) {
    const p = open.get(pageId);
    if (!p) return;
    clearTimeout(p.idle);
    open.delete(pageId);
    void p.chain.finally(() => p.shadow.destroy());
  }

  return {
    /** A page was loaded into memory. Make sure it has a baseline version and start tracking. */
    async loaded(pageId: string, doc: Y.Doc) {
      const kept = open.get(pageId);
      if (kept) { kept.inMemory = true; return; } // reloaded before its pending changes were saved
      const shadow = docFrom(Y.encodeStateAsUpdate(doc));
      open.set(pageId, { shadow, authors: new Map(), since: Date.now(), chain: Promise.resolve(), inMemory: true });
      const [any] = await db.query('select 1 from page_versions where page_id = $1 limit 1', [pageId]);
      if (!any && listBlocks(shadow).some((b) => b.text.trim() || b.type !== 'paragraph')) {
        await enqueue(pageId, () => save(pageId, Y.encodeStateAsUpdate(shadow), [], 'baseline'));
      }
    },

    /** Called for every change, with who made it. */
    changed(pageId: string, update: Uint8Array, who: Author | undefined) {
      const p = open.get(pageId);
      if (!p) return;
      if (who) {
        const kinds = new Set([...p.authors.values()].map((a) => a.kind));
        const switching = p.authors.size > 0 && !p.authors.has(authorKey(who)) && !kinds.has(who.kind);
        const tooLong = p.authors.size > 0 && Date.now() - p.since > MAX_SPAN_MS;
        if (switching || tooLong) void cut(pageId); // saves the shadow: the page just before this change
        if (!p.authors.size) p.since = Date.now();
        p.authors.set(authorKey(who), who);
      }
      Y.applyUpdate(p.shadow, update);
      clearTimeout(p.idle);
      p.idle = setTimeout(() => void cut(pageId), IDLE_MS);
      p.idle.unref?.();
    },

    /** The page left memory (everyone disconnected, or an HTTP agent call ended). Pending changes
     *  are still saved when the idle timer fires, so a burst of agent API calls is one version. */
    unloaded(pageId: string) {
      const p = open.get(pageId);
      if (!p) return;
      p.inMemory = false;
      if (!p.authors.size) forget(pageId);
    },

    cut,

    /** Save a given state right away (used around a restore). */
    snapshot(pageId: string, state: Uint8Array, authors: Author[], reason: VersionReason, restoredFrom?: string) {
      const p = open.get(pageId);
      if (p) { p.authors.clear(); clearTimeout(p.idle); }
      return enqueue(pageId, () => save(pageId, state, authors, reason, restoredFrom));
    },

    async list(pageId: string) {
      return db.query(
        `select id, created_at, reason, authors, summary, restored_from, bytes
           from page_versions where page_id = $1 order by created_at desc limit $2`, [pageId, MAX_VERSIONS]);
    },

    async state(pageId: string, versionId: string): Promise<Uint8Array | null> {
      const [row] = await db.query('select data from page_versions where page_id = $1 and id = $2', [pageId, versionId]);
      return row ? unpack(row.data) : null;
    },

    /** A version's content and its diff against the version before it (or against `against`). */
    async show(pageId: string, versionId: string, against: Y.Doc | 'previous') {
      const [row] = await db.query('select id, created_at, data from page_versions where page_id = $1 and id = $2', [pageId, versionId]);
      if (!row) return null;
      const now = contentOf(docFrom(unpack(row.data)));
      let base: Content;
      if (against === 'previous') {
        const [prev] = await db.query(
          'select data from page_versions where page_id = $1 and created_at < $2 order by created_at desc limit 1', [pageId, row.created_at]);
        base = prev ? contentOf(docFrom(unpack(prev.data))) : { title: '', tabs: now.tabs, blocks: [] };
        return { content: now, diff: diffContent(base, now) };
      }
      // Compare with the live page: what restoring this version would change.
      return { content: now, diff: diffContent(contentOf(against), now) };
    },

    flushAll() {
      return Promise.all([...open.keys()].map((id) => cut(id).catch(() => null)));
    },
  };
}

export type History = ReturnType<typeof createHistory>;

function wordCount(blocks: BlockRow[]) {
  return blocks.filter((b) => b.type !== 'htmlBlock').reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0);
}

/** Turn `live` back into the state saved in `oldState`, as one new change on top of the current one.
 *  Works by replaying the current page on a copy of the old version and undoing exactly that, which
 *  brings back deleted blocks and removes newer ones, across every tab, HTML block and mind map. */
export function revertUpdate(live: Y.Doc, oldState: Uint8Array): Uint8Array {
  const target = docFrom(oldState, false);
  const ORIGIN = 'livepage-restore';
  // Top-level types stay untyped until first read, so name their real types: block trees are
  // XmlFragments ("default" and "tab:<id>"), everything else in the page model is a Map.
  const names = new Set([...live.share.keys(), ...target.share.keys()]);
  const typed = (d: Y.Doc, name: string) => (name === FRAGMENT || name.startsWith('tab:') ? d.getXmlFragment(name) : d.getMap(name));
  names.forEach((n) => typed(live, n));
  const scope = [...names].map((n) => typed(target, n));
  const um = new Y.UndoManager(scope, { trackedOrigins: new Set([ORIGIN]), captureTimeout: 0 });
  Y.applyUpdate(target, Y.encodeStateAsUpdate(live, Y.encodeStateVector(target)), ORIGIN);
  um.undo();
  const out = Y.encodeStateAsUpdate(target, Y.encodeStateVector(live));
  um.destroy();
  target.destroy();
  return out;
}

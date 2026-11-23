// Version history API (people and agents, same auth as the rest of /api):
//
//   GET  /api/pages/:page/versions                         -> { versions: [...], canRestore }
//   GET  /api/pages/:page/versions/:id?compare=previous    -> { content, diff }   what changed in this version
//   GET  /api/pages/:page/versions/:id?compare=current     -> { content, diff }   what restoring it would change
//   POST /api/pages/:page/versions/:id/restore             -> { ok, version }     page goes back to that version
//
// History is for editors and owners: old versions can hold text that was later removed, so
// viewers and commenters (for example people with a view-only share link) do not see it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { Db } from './db.ts';
import { bearer, resolvePrincipal } from './auth.ts';
import { canEdit, isPageId, roleFor } from './pages.ts';
import { send } from './agent-api.ts';
import { revertUpdate, type Author, type History } from './history.ts';

const ROUTE = /^\/api\/pages\/(p_[\w-]{8,40})\/versions(?:\/(v_[\w-]+))?(?:\/(restore))?\/?(?:\?.*)?$/;
export const isVersionsPath = (url: string | undefined) => ROUTE.test(url ?? '');

export async function handleVersions(req: IncomingMessage, res: ServerResponse, db: Db, hp: Hocuspocus, history: History) {
  const url = new URL(req.url ?? '/', 'http://x');
  const [, pageId, versionId, action] = url.pathname.match(ROUTE) ?? (req.url ?? '').match(ROUTE)!;
  const method = req.method ?? 'GET';
  try {
    if (method !== 'GET' && req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'cross-site request blocked' }); }
      catch { return send(res, 403, { error: 'cross-site request blocked' }); }
    }
    const who = await resolvePrincipal(db, { cookie: req.headers.cookie, token: bearer(req) });
    if (!who) return send(res, 401, { error: 'Sign in first.' });
    if (!isPageId(pageId)) return send(res, 404, { error: 'not found' });
    const role = await roleFor(db, who, pageId);
    if (!role) return send(res, 404, { error: 'Page not found, or you do not have access.' });
    if (!canEdit(role)) return send(res, 403, { error: 'Version history is available to people who can edit this page.' });

    if (!versionId && method === 'GET') {
      // Save what is pending first, so the list includes the latest edits.
      await history.cut(pageId);
      return send(res, 200, { versions: await history.list(pageId), canRestore: true });
    }

    if (versionId && !action && method === 'GET') {
      const compare = url.searchParams.get('compare') === 'current' ? 'current' : 'previous';
      let out;
      if (compare === 'current') {
        const conn = await hp.openDirectConnection(pageId, { user: who });
        try {
          let live!: Y.Doc;
          await conn.transact((d) => { live = d as unknown as Y.Doc; });
          out = await history.show(pageId, versionId, live);
        } finally { await conn.disconnect(); }
      } else {
        out = await history.show(pageId, versionId, 'previous');
      }
      return out ? send(res, 200, { compare, ...out }) : send(res, 404, { error: 'No such version.' });
    }

    if (versionId && action === 'restore' && method === 'POST') {
      const old = await history.state(pageId, versionId);
      if (!old) return send(res, 404, { error: 'No such version.' });
      const author: Author = { id: who.id, name: who.name, kind: who.kind };
      const conn = await hp.openDirectConnection(pageId, { user: author });
      let restored: string | null = null;
      try {
        // 1. Keep the page as it is right now, so the restore itself can be undone from history.
        await history.cut(pageId);
        let now!: Uint8Array;
        await conn.transact((d) => { now = Y.encodeStateAsUpdate(d as unknown as Y.Doc); });
        await history.snapshot(pageId, now, [], 'before-restore');
        // 2. Apply the restore as a normal live change: everyone with the page open sees it at once.
        let after!: Uint8Array;
        await conn.transact((d) => {
          const doc = d as unknown as Y.Doc;
          Y.applyUpdate(doc, revertUpdate(doc, old));
          after = Y.encodeStateAsUpdate(doc);
        });
        // 3. Record the restore as its own version.
        await new Promise((r) => setTimeout(r, 0));
        restored = await history.snapshot(pageId, after, [author], 'restore', versionId);
      } finally {
        await conn.disconnect();
      }
      return send(res, 200, { ok: true, version: restored });
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('[versions]', e);
    return send(res, 500, { error: 'server error' });
  }
}

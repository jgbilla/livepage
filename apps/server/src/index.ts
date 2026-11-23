import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import * as Y from 'yjs';
import { listBlocks, listLinks, listTabs, META } from '@livepage/schema';
import { connect } from './db.ts';
import { resolvePrincipal } from './auth.ts';
import { canEdit, isPageId, roleFor, type Role } from './pages.ts';
import { handleApi } from './routes.ts';
import { handleMcp, isMcpPath } from './mcp-http.ts';
import { staticHandler } from './static.ts';
import { createHistory, VERSIONS_SQL, type Author } from './history.ts';
import { handleVersions, isVersionsPath } from './versions-api.ts';
import { config } from './config.ts';

const db = await connect(process.env.DATABASE_URL);
for (const stmt of VERSIONS_SQL.split(';').map((x) => x.trim()).filter(Boolean)) await db.query(stmt);
const history = createHistory(db);
const serveStatic = config.webDist
  ? staticHandler(config.webDist, config.sandboxUrl, config.neonAuthUrl ? new URL(config.neonAuthUrl).origin : null)
  : null;

export type Context = { user: { id: string; name: string; kind: 'human' | 'agent' }; role: Role };

const server = new Server<Context>({
  port: config.port,
  quiet: true,
  debounce: 1000,
  maxDebounce: 5000,
  extensions: [
    new Database({
      fetch: async ({ documentName }) => {
        const [row] = await db.query('select data from documents where name = $1', [documentName]);
        if (row?.data) return new Uint8Array(row.data);
        // A brand-new page: start the document with the title it was created with (for example
        // "daily", or a title an agent passed), so the first save does not blank it.
        const [page] = await db.query('select title from pages where id = $1', [documentName]);
        if (!page?.title) return null;
        const seed = new Y.Doc();
        seed.getMap(META).set('title', page.title);
        return Y.encodeStateAsUpdate(seed);
      },
      store: async ({ documentName, state, document }) => {
        const doc = document as unknown as Y.Doc;
        const blocks = listBlocks(doc);
        const title = String(doc.getMap(META).get('title') ?? '').slice(0, 200);
        const tabTitles = new Map(listTabs(doc).map((t) => [t.id, t.title]));
        const links = [...new Map(listLinks(doc).map((l) => [`${l.fromTab} ${l.page} ${l.tab}`, l])).values()];
        await db.tx(async (q) => {
          await q(
            `insert into documents (name, data, updated_at) values ($1, $2, now())
             on conflict (name) do update set data = excluded.data, updated_at = now()`,
            [documentName, state],
          );
          await q('update pages set title = $2, updated_at = now() where id = $1', [documentName, title]);
          await q('delete from page_links where from_page = $1', [documentName]);
          for (const l of links) {
            await q('insert into page_links (from_page, from_tab, from_tab_title, to_page, to_tab) values ($1,$2,$3,$4,$5)',
              [documentName, l.fromTab, tabTitles.size > 1 ? tabTitles.get(l.fromTab) ?? '' : '', l.page, l.tab]);
          }
          await q('delete from blocks where doc_name = $1', [documentName]);
          for (const b of blocks) {
            await q(
              'insert into blocks (doc_name, id, tab, position, type, text, attrs) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing',
              [documentName, b.id, b.tab, b.position, b.type, b.text, JSON.stringify(b.attrs)],
            );
          }
        });
      },
    }),
  ],

  // Every live connection proves who it is (session cookie from the browser, or an agent
  // token sent as the provider token) and needs a role on that page. Viewers and commenters
  // connect read-only, so the server drops any edits they send.
  async onAuthenticate({ token, requestHeaders, documentName, connectionConfig }) {
    if (!isPageId(documentName)) throw new Error('not a page');
    const who = await resolvePrincipal(db, { cookie: requestHeaders.get('cookie'), token });
    const role = await roleFor(db, who, documentName);
    if (!who || !role) throw new Error('forbidden');
    if (!canEdit(role)) connectionConfig.readOnly = true;
    return { user: { id: who.id, name: who.name, kind: who.kind }, role };
  },

  // Version history: credit each change to the person or agent who made it, and cut versions.
  async afterLoadDocument({ documentName, document }) {
    if (isPageId(documentName)) await history.loaded(documentName, document as unknown as Y.Doc).catch((e) => console.warn('[history]', e.message));
  },
  async onChange({ documentName, update, context }) {
    if (isPageId(documentName)) history.changed(documentName, update, (context as Context | undefined)?.user as Author | undefined);
  },
  async afterUnloadDocument({ documentName }) {
    if (isPageId(documentName)) history.unloaded(documentName);
  },
  async onDestroy() {
    await history.flushAll();
  },

  async onRequest({ request, response, instance }) {
    if (isVersionsPath(request.url)) {
      await handleVersions(request, response, db, instance, history);
      throw null; // response sent
    }
    if (isMcpPath(request.url)) {
      await handleMcp(request, response, db);
      throw null; // response sent
    }
    if ((request.url ?? '').startsWith('/api/')) {
      await handleApi(request, response, db, instance);
      throw null; // response sent
    }
    if (serveStatic && (await serveStatic(request, response))) throw null;
  },
});

await server.listen();
console.log(`[server] http://localhost:${config.port}  (sandbox: ${config.sandboxUrl}${config.webDist ? `, serving ${config.webDist}` : ''})`);

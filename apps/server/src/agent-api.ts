// A tiny HTTP API so any AI (any model, any framework) can work on a page
// without speaking the Yjs protocol. Changes go through a Hocuspocus direct
// connection, so they show up live in every open browser.
//
//   GET  /api/pages/:page/content                  -> { markdown, tabs, blocks }
//   POST /api/pages/:page/paragraphs   { text }    -> { ok }
//   POST /api/pages/:page/headings     { text, level }
//   POST /api/pages/:page/html-blocks  { code, title } -> { id }
//   PUT  /api/pages/:page/html-blocks/:id { code }
//   POST /api/pages/:page/ui           { title, initialHeight, css, html, js } -> { id }   (custom UI, inserted complete)
//   POST /api/pages/:page/tables       { rows: string[][] }
//   POST /api/pages/:page/mind-maps    { root: { text, children? }, title } -> { id }
//   GET  /api/pages/:page/actions                  -> pending actions sent from block controls (claims them)
//   POST /api/pages/:page/actions/:id  { note }    -> mark handled
//   POST /api/pages/:page/tabs         { title }   -> { id }
// Writes go to the main tab unless ?tab=<id or title> is given.
//
// Comments (routes.ts + comments.ts; commenters can use these too):
//   GET    /api/pages/:page/comments?status=open|resolved|all  -> { threads }
//   POST   /api/pages/:page/comments  { body, quote? | block_id?, tab?, occurrence? } -> { comment }   (no anchor = whole page)
//   POST   /api/pages/:page/comments/:threadId { body }  -> reply
//   PATCH  /api/pages/:page/comments/:id { body? , resolved? }
//   DELETE /api/pages/:page/comments/:id
//   GET    /api/pages/:page/mentionables                 -> people and agents who can be @mentioned
//   GET    /api/mentions?wait=<s>                        -> your unanswered @mentions (long-polls up to 60s)
//   POST   /api/mentions/:id/done
//
// Auth: "Authorization: Bearer lp_..." (an agent token a person creates in the app; the agent
// gets that person's access to the page). In development the shared AGENT_TOKEN also works.
// For a live cursor and typing animation, agents use the WebSocket client in packages/agent instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  appendHeading, appendParagraph, htmlSections, insertHtmlBlock, insertMindMap, insertTable, listBlocks, pageAsMarkdown,
  addTab, listTabs, pendingActions, resolveTab, setHtmlCode, updateAction,
} from '@livepage/schema';

export const MAX_BODY = 512 * 1024;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body === null ? '' : JSON.stringify(body));
}

export type ContentCall = {
  req: IncomingMessage;
  res: ServerResponse;
  hp: Hocuspocus;
  url: URL;
  page: string;
  collection: string | undefined;
  id: string | undefined;
  who: { id: string; name: string; kind: 'human' | 'agent' };
  writable: boolean;
};

/** Content operations on one page. The caller has already checked the principal can read it. */
export async function handleContent({ req, res, hp, url, page, collection, id, who, writable }: ContentCall): Promise<void> {
  const isRead = req.method === 'GET' && (!collection || collection === 'actions');
  if (!isRead && !writable) return send(res, 403, { error: 'read-only access to this page' });
  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const conn = await hp.openDirectConnection(page, { user: who });
    let result: unknown = { ok: true };
    try {
      await conn.transact((d) => {
        const doc = d as unknown as Y.Doc;
        const tab = resolveTab(doc, url.searchParams.get('tab'));
        if (req.method === 'GET' && !collection) {
          result = { markdown: pageAsMarkdown(doc), tabs: listTabs(doc), blocks: listBlocks(doc) };
        } else if (req.method === 'POST' && collection === 'paragraphs') {          appendParagraph(doc, String(body.text ?? ''), tab);
        } else if (req.method === 'POST' && collection === 'headings') {
          appendHeading(doc, String(body.text ?? ''), Number(body.level ?? 2), tab);
        } else if (req.method === 'POST' && collection === 'html-blocks') {
          result = { id: insertHtmlBlock(doc, String(body.code ?? ''), { title: body.title, tab }) };
        } else if (req.method === 'PUT' && collection === 'html-blocks' && id) {
          setHtmlCode(doc, id, String(body.code ?? ''));
        } else if (req.method === 'POST' && collection === 'ui') {
          const code = htmlSections({ css: str(body.css), html: str(body.html), js: str(body.js) }).join('');
          result = { id: insertHtmlBlock(doc, code, { title: body.title, initialHeight: Number(body.initialHeight) || 240, tab }) };
        } else if (req.method === 'POST' && collection === 'tables') {
          if (!Array.isArray(body.rows)) throw new Error('rows must be an array of arrays');
          insertTable(doc, body.rows.map((r: unknown) => (Array.isArray(r) ? r.map(String) : [String(r)])), { tab });
        } else if (req.method === 'POST' && collection === 'mind-maps') {
          if (!body.root || typeof body.root.text !== 'string') throw new Error('root.text is required');
          result = { id: insertMindMap(doc, body.root, { title: body.title, tab }) };
        } else if (req.method === 'POST' && collection === 'tabs') {
          result = { id: addTab(doc, str(body.title)) };
        } else if (req.method === 'GET' && collection === 'actions') {
          const list = pendingActions(doc);
          list.forEach((a) => updateAction(doc, a.id, { status: 'claimed' }));
          result = { actions: list };
        } else if (req.method === 'POST' && collection === 'actions' && id) {
          updateAction(doc, id, { status: 'done', note: str(body.note).slice(0, 200) || undefined });
        } else {
          result = null;
        }
      });
    } finally {
      await conn.disconnect();
    }
    if (result === null) send(res, 405, { error: 'method not allowed' });
    else send(res, 200, result);
  } catch (e) {
    send(res, 400, { error: String((e as Error).message) });
  }
}

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
//   POST /api/pages/:page/tabs         { title }   -> { id }      GET -> { tabs }
//   GET  /api/pages/:page/backlinks                -> pages (and tabs) that link to this page
// Paragraph text may contain links: [[p_id]], [[p_id#tab_id]], [[p_id|label]] (see packages/schema).
//   GET  /api/pages/:page/footnotes                -> { footnotes: [{ id, n, note, url, title, author }] }
//   POST /api/pages/:page/footnotes    { afterText?, last?, note?, url?, title?, author? } -> { id, n }  (cite a source)
//   PUT  /api/pages/:page/footnotes/:id { note?, url?, title?, author? }
//   DELETE /api/pages/:page/footnotes/:id
// Writes go to the main tab unless ?tab=<id or title> is given.
//
// Organizing (routes.ts): each person has their own folder tree; tags belong to the page.
//   GET    /api/pages?path=a/b&tag=x&tag=y&match=any|all -> { pages (with folder_id, path, tags), folders, tags, views }
//   POST   /api/pages          { title, path? | folder_id?, tags? } -> { page }
//   PATCH  /api/pages/:page    { title?, path? | folder_id?, tags? }   (move only changes your own tree)
//   PUT    /api/pages/:page/tags { tags }    POST { tag }    DELETE /tags/:tag
//   POST   /api/daily          { date: "YYYY-MM-DD" } -> { page, created }   (folder YYYY/MM/DD, page "daily")
//   GET/POST /api/folders      { name, parent_id? } or { path } (mkdir -p);  PATCH/DELETE /api/folders/:id
//   GET    /api/tags;  GET/POST /api/views { name, tags, match };  PATCH/DELETE /api/views/:id
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
// Templates, import/export and publishing (routes.ts, templates.ts, transfer.ts, publish.ts):
//   GET    /api/templates                          -> { templates, daily_template_id }
//   PUT    /api/templates/daily { page_id | null }    which template new daily pages start from
//   PATCH  /api/pages/:page    { template: true|false }   mark a page as a template
//   POST   /api/pages          { template_id, title?, date?, time? }   new page from a template
//   GET    /api/pages/:page/fields                 -> { fields }   {{fields}} still to fill in
//   POST   /api/pages/:page/fields { fields: { name: text } }      fill them in
//   GET    /api/pages/:page/export?format=md       -> the page as a Markdown file (footnotes, [[links]], frontmatter)
//   GET    /api/export                              -> zip of all your pages as an Obsidian-style vault
//   POST   /api/import         { files: [{ path, content }], into?: "Folder" }  Markdown files or a vault
//   POST   /api/pages/:page/publish -> { url }   DELETE unpublishes. Public at /pub/<slug>.
//
// Auth: "Authorization: Bearer lp_..." (an agent token a person creates in the app; the agent
// gets that person's access to the page). In development the shared AGENT_TOKEN also works.
// For a live cursor and typing animation, agents use the WebSocket client in packages/agent instead.
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  appendHeading, appendParagraph, htmlSections, insertHtmlBlock, insertMindMap, insertTable, listBlocks, pageAsMarkdown,
  addTab, listTabs, pendingActions, resolveTab, setHtmlCode, updateAction,
  insertFootnote, listFootnotes, removeFootnote, updateFootnote, type FootnoteInput,
} from '@livepage/schema';

export const MAX_BODY = 512 * 1024;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const opt = (v: unknown) => (typeof v === 'string' ? v : undefined);
const citation = (b: any): FootnoteInput => ({ note: opt(b.note), url: opt(b.url), title: opt(b.title), author: opt(b.author) });

export async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const json = body === null ? '' : JSON.stringify(body);
  const out: Record<string, string | string[]> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
  // Page lists, search results and comments can be large; compress them (fast settings).
  const accept = String(res.req?.headers['accept-encoding'] ?? '');
  if (json.length > 1400 && /\b(br|gzip)\b/.test(accept)) {
    const br = /\bbr\b/.test(accept);
    const data = br
      ? brotliCompressSync(json, { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } })
      : gzipSync(json, { level: 6 });
    res.writeHead(status, { ...out, 'Content-Encoding': br ? 'br' : 'gzip', Vary: 'Accept-Encoding', 'Content-Length': String(data.length) });
    res.end(data);
    return;
  }
  res.writeHead(status, out);
  res.end(json);
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
  const isRead = req.method === 'GET' && (!collection || collection === 'actions' || collection === 'tabs' || collection === 'footnotes');
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
        } else if (req.method === 'GET' && collection === 'tabs') {
          result = { tabs: listTabs(doc) };
        } else if (req.method === 'POST' && collection === 'tabs') {
          result = { id: addTab(doc, str(body.title)) };
        } else if (req.method === 'GET' && collection === 'footnotes') {
          result = { footnotes: listFootnotes(doc, tab) };
        } else if (req.method === 'POST' && collection === 'footnotes') {
          result = insertFootnote(doc, { ...citation(body), afterText: opt(body.afterText), last: body.last === true, tab });
        } else if (req.method === 'PUT' && collection === 'footnotes' && id) {
          updateFootnote(doc, id, citation(body));
        } else if (req.method === 'DELETE' && collection === 'footnotes' && id) {
          removeFootnote(doc, id);
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

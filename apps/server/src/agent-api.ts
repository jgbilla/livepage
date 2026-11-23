// A tiny HTTP API so any AI (any model, any framework) can work on a page
// without speaking the Yjs protocol. Changes go through a Hocuspocus direct
// connection, so they show up live in every open browser.
//
//   GET  /api/pages/:page                          -> { markdown, blocks }
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
// Auth: "Authorization: Bearer <AGENT_TOKEN>".
// For a live cursor and typing animation, agents use the WebSocket client in packages/agent instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  appendHeading, appendParagraph, htmlSections, insertHtmlBlock, insertMindMap, insertTable, listBlocks, pageAsMarkdown,
  addTab, listTabs, pendingActions, resolveTab, setHtmlCode, updateAction,
} from '@livepage/schema';

const MAX_BODY = 512 * 1024;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

export async function handleAgentApi(req: IncomingMessage, res: ServerResponse, hp: Hocuspocus, token: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = url.pathname.match(/^\/api\/pages\/([\w.-]{1,128})(?:\/(paragraphs|headings|html-blocks|ui|tables|mind-maps|actions|tabs)(?:\/([\w-]{1,64}))?)?$/);
  if (!url.pathname.startsWith('/api')) return false;
  if (req.method === 'OPTIONS') return send(res, 204, null), true;
  if (url.pathname === '/api/health') return send(res, 200, { ok: true }), true;
  if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' }), true;
  if (!m) return send(res, 404, { error: 'not found' }), true;

  const [, page, collection, id] = m;
  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const conn = await hp.openDirectConnection(page, { user: { id: 'agent-http', name: 'Agent', kind: 'agent' } });
    let result: unknown = { ok: true };
    try {
      await conn.transact((d) => {
        const doc = d as unknown as Y.Doc;
        const tab = resolveTab(doc, url.searchParams.get('tab'));
        if (req.method === 'GET' && !collection) {
          result = { markdown: pageAsMarkdown(doc), tabs: listTabs(doc), blocks: listBlocks(doc) };
        } else if (req.method === 'POST' && collection === 'paragraphs') {
          appendParagraph(doc, String(body.text ?? ''), tab);
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
  return true;
}

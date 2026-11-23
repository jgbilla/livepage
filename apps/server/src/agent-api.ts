// A tiny HTTP API so any AI (any model, any framework) can work on a page
// without speaking the Yjs protocol. Changes go through a Hocuspocus direct
// connection, so they show up live in every open browser.
//
//   GET  /api/pages/:page                          -> { markdown, blocks }
//   POST /api/pages/:page/paragraphs   { text }    -> { ok }
//   POST /api/pages/:page/headings     { text, level }
//   POST /api/pages/:page/html-blocks  { code, title } -> { id }
//   PUT  /api/pages/:page/html-blocks/:id { code }
//
// Auth: "Authorization: Bearer <AGENT_TOKEN>".
// For a live cursor and typing animation, agents use the WebSocket client in packages/agent instead.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { appendHeading, appendParagraph, insertHtmlBlock, listBlocks, pageAsMarkdown, setHtmlCode } from '@livepage/schema';

const MAX_BODY = 512 * 1024;

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
  const m = url.pathname.match(/^\/api\/pages\/([\w.-]{1,128})(?:\/(paragraphs|headings|html-blocks)(?:\/([\w-]{1,64}))?)?$/);
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
        if (req.method === 'GET' && !collection) {
          result = { markdown: pageAsMarkdown(doc), blocks: listBlocks(doc) };
        } else if (req.method === 'POST' && collection === 'paragraphs') {
          appendParagraph(doc, String(body.text ?? ''));
        } else if (req.method === 'POST' && collection === 'headings') {
          appendHeading(doc, String(body.text ?? ''), Number(body.level ?? 2));
        } else if (req.method === 'POST' && collection === 'html-blocks') {
          result = { id: insertHtmlBlock(doc, String(body.code ?? ''), { title: body.title }) };
        } else if (req.method === 'PUT' && collection === 'html-blocks' && id) {
          setHtmlCode(doc, id, String(body.code ?? ''));
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

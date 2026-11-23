// Security regression tests. Run: pnpm --filter @livepage/server test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { appendParagraph, insertFootnote, pageToHtml, safeHref, tabsMap } from '@livepage/schema';
import { sameOrigin } from '../src/origin.ts';
import { devAgentToken } from '../src/auth.ts';
import { attempts, limited } from '../src/routes.ts';

test('links: only web, mail, in-page and same-site paths survive', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeHref('#tab-x'), '#tab-x');
  assert.equal(safeHref('/pub/notes-1234'), '/pub/notes-1234');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example', '/\\evil.example', '\\\\evil.example']) {
    assert.equal(safeHref(bad), null, bad);
  }
});

test('published HTML: a hostile tab id cannot break out of attributes', () => {
  const doc = new Y.Doc();
  const evil = 'x"><meta http-equiv="refresh" content="0;url=https://evil.example">';
  tabsMap(doc).set(evil, { id: evil, title: 'Evil', order: 1 });
  appendParagraph(doc, 'Some text to cite', evil);
  insertFootnote(doc, { note: 'a note', tab: evil, last: true });
  const { tabs } = pageToHtml(doc);
  const html = tabs.map((t) => t.html).join('\n');
  assert.ok(html.includes('fnref-'), 'footnote rendered');
  assert.ok(!html.includes('<meta'), html);
  assert.ok(!/id="fn(ref)?-x"/.test(html), 'quote in tab id was escaped');
});

test('published HTML: javascript: links and footnote URLs are dropped', () => {
  const doc = new Y.Doc();
  appendParagraph(doc, 'cite me');
  insertFootnote(doc, { note: 'n', url: 'javascript:alert(1)', title: 'T', last: true });
  const html = pageToHtml(doc).tabs[0].html;
  assert.ok(!html.toLowerCase().includes('javascript:'), html);
});

test('same-origin check for cookie requests and WebSocket upgrades', () => {
  assert.equal(sameOrigin(undefined, 'livepage.onrender.com'), true); // agents send no Origin
  assert.equal(sameOrigin('https://livepage.onrender.com', 'livepage.onrender.com'), true);
  assert.equal(sameOrigin('https://evil.onrender.com', 'livepage.onrender.com'), false);
  assert.equal(sameOrigin('https://livepage.onrender.com.evil.example', 'livepage.onrender.com'), false);
  assert.equal(sameOrigin('null', 'livepage.onrender.com'), false);
  assert.equal(sameOrigin('not a url', 'livepage.onrender.com'), false);
});

test('shared dev agent token only works on a local development server', () => {
  assert.equal(devAgentToken({}), 'dev-agent-token');
  assert.equal(devAgentToken({ AGENT_TOKEN: 'abc' }), 'abc');
  assert.equal(devAgentToken({ NODE_ENV: 'production' }), null);
  assert.equal(devAgentToken({ PUBLIC_URL: 'https://notes.example.com' }), null);
  assert.equal(devAgentToken({ RENDER_EXTERNAL_URL: 'https://livepage.onrender.com' }), null);
  assert.equal(devAgentToken({ RENDER: 'true' }), null);
  assert.equal(devAgentToken({ PUBLIC_URL: 'http://localhost:5173' }), 'dev-agent-token');
});

test('rate limit counts per key and resets after the window', () => {
  attempts.clear();
  for (let i = 0; i < 3; i++) assert.equal(limited('k', 3, 60_000), false);
  assert.equal(limited('k', 3, 60_000), true);
  assert.equal(limited('other', 3, 60_000), false);
  attempts.set('k', { n: 99, reset: Date.now() - 1 });
  assert.equal(limited('k', 3, 60_000), false);
});

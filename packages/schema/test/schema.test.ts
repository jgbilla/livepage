// Unit tests for the shared page model. Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  META, addTab, appendHeading, appendParagraph, insertHtmlBlock, insertTable, listBlocks, listLinks, listTabs,
  linkToken, splitLinks, paragraphWithLinks, fragment, safeUrl, validateAction, insertFootnote, listFootnotes,
  removeTab, resolveTab, MAIN_TAB,
} from '../src/index.ts';
import { parseMentions, mentionToken, plainBody } from '../src/comments.ts';
import { pageToMarkdown, importMarkdown, splitFrontmatter, safeHref } from '../src/markdown.ts';
import { builtinValue, listFields, fillFields } from '../src/template.ts';
import { pageToHtml, escapeHtml } from '../src/html.ts';

const page = (title = 'Test page') => {
  const doc = new Y.Doc();
  doc.getMap(META).set('title', title);
  return doc;
};

test('blocks: headings, paragraphs, tables and HTML blocks are listed in order', () => {
  const doc = page();
  appendHeading(doc, 'Intro', 2);
  appendParagraph(doc, 'Hello world');
  insertTable(doc, [['a', 'b'], ['1', '2']], { header: true });
  const id = insertHtmlBlock(doc, '<p>hi</p>', { title: 'Widget' });
  const blocks = listBlocks(doc);
  assert.deepEqual(blocks.map((b) => b.type).slice(0, 2), ['heading', 'paragraph']);
  assert.equal(blocks[1].text, 'Hello world');
  assert.ok(blocks.some((b) => b.id === id), 'the HTML block is listed by its id');
});

test('tabs: add, resolve by title or id, remove', () => {
  const doc = page();
  const id = addTab(doc, 'Notes');
  assert.ok(listTabs(doc).some((t) => t.id === id && t.title === 'Notes'));
  assert.equal(resolveTab(doc, 'Notes'), id);
  assert.equal(resolveTab(doc, id), id);
  assert.equal(resolveTab(doc, null), MAIN_TAB);
  removeTab(doc, id);
  assert.ok(!listTabs(doc).some((t) => t.id === id));
});

test('links: tokens round-trip through splitLinks and are found in the page', () => {
  const token = linkToken({ page: 'p_abcdefgh12', tab: 't_x', label: 'See [this]' });
  const parts = splitLinks(`before ${token} after`);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[1], { page: 'p_abcdefgh12', tab: 't_x', label: 'See [this' }); // ] and | would end the token, so they are dropped
  const doc = page();
  fragment(doc).insert(0, [paragraphWithLinks(`go to ${linkToken({ page: 'p_target00001' })}`)]);
  assert.deepEqual(listLinks(doc).map((l) => l.page), ['p_target00001']);
});

test('mentions: parsed, de-duplicated and rendered as plain text', () => {
  const body = `hi ${mentionToken({ kind: 'user', id: 'u_1', name: 'Jean' })} and ${mentionToken({ kind: 'agent', id: 'tok_2', name: 'Bot' })} @[Jean](user:u_1)`;
  assert.deepEqual(parseMentions(body).map((m) => `${m.kind}:${m.id}`), ['user:u_1', 'agent:tok_2']);
  assert.equal(plainBody(body), 'hi @Jean and @Bot @Jean');
});

test('safety: URLs and block actions from untrusted input are filtered', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl(' https://example.com '), 'https://example.com');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(validateAction('bad name!', {}), null);
  assert.equal(validateAction('ok', []), null);
  assert.equal(validateAction('ok', { big: 'x'.repeat(10_000) }), null);
  assert.deepEqual(validateAction('vote.up', { n: 1 }), { action: 'vote.up', values: { n: 1 } });
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('markdown: import then export keeps headings, lists, tabs, tags and footnotes', () => {
  const md = [
    '---', 'title: Imported', 'tags: [Alpha, beta]', '---',
    '# Big idea', '', 'Some **bold** text.[^1]', '', '- one', '- two', '',
    '[^1]: A source',
    '<!-- livepage-tab: Second -->', '## In tab two', '',
  ].join('\n');
  const doc = new Y.Doc();
  const res = importMarkdown(doc, md);
  assert.equal(res.title, 'Imported');
  assert.deepEqual(res.tags.sort(), ['alpha', 'beta']);
  assert.equal(doc.getMap(META).get('title'), 'Imported');
  assert.deepEqual(listTabs(doc).map((t) => t.title).slice(-1), ['Second']);
  assert.equal(listFootnotes(doc).length, 1);
  const out = pageToMarkdown(doc);
  for (const s of ['# Big idea', '**bold**', '- one', 'In tab two', 'A source']) assert.ok(out.includes(s), `export has ${s}:\n${out}`);
  assert.deepEqual(splitFrontmatter('no front matter').body, 'no front matter');
});

test('footnotes: inserted after a quote and numbered', () => {
  const doc = page();
  appendParagraph(doc, 'Claim one. Claim two.');
  insertFootnote(doc, { afterText: 'Claim one.', note: 'first', url: 'https://a.example' });
  insertFootnote(doc, { last: true, note: 'second' });
  const notes = listFootnotes(doc);
  assert.deepEqual(notes.map((f) => [f.n, f.note]), [[1, 'first'], [2, 'second']]);
});

test('templates: built-in variables and fields to fill in', () => {
  const vars = { title: 'Daily', date: '2026-11-23' };
  assert.equal(builtinValue('date', vars), '2026-11-23');
  assert.equal(builtinValue('date:dddd, MMMM D', vars), 'Monday, November 23');
  assert.equal(builtinValue('yesterday', vars), '2026-11-22');
  assert.equal(builtinValue('Mood', vars), null);
  const doc = page();
  appendParagraph(doc, 'Mood: {{ Mood }} on {{date}}');
  assert.deepEqual(listFields(doc), ['Mood', 'date']);
  assert.equal(fillFields(doc, { Mood: 'good' }), 1);
  assert.equal(listBlocks(doc)[0].text, 'Mood: good on {{date}}');
});

test('html export escapes page text', () => {
  const doc = page('<b>title</b>');
  appendParagraph(doc, '<img src=x onerror=alert(1)>');
  const { tabs } = pageToHtml(doc);
  const html = JSON.stringify(tabs);
  assert.ok(!html.includes('<img src=x'), html);
});

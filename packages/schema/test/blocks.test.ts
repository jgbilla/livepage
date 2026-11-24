// Targeted edits: stable block ids, section reads, block edits, find and replace, table edits. Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  addTab, appendHeading, appendParagraph, fragment, insertHtmlBlock, insertTable, insertFootnote, listBlocks, listFootnotes,
  blocksAsText, deleteBlocks, deleteTableRow, findBlock, insertBlocks, insertTableRow, moveBlocks, outlineAsText, pageOutline,
  readBlocks, replaceBlocks, replaceText, setTableCell, tabToMarkdown, textAnchorForQuote, currentAnchorText,
} from '../src/index.ts';
import { pageToHtml } from '../src/html.ts';

function sample() {
  const doc = new Y.Doc();
  appendHeading(doc, 'Overview', 1);
  appendParagraph(doc, 'Livepage is a writing canvas.');
  appendHeading(doc, 'Getting started', 2);
  appendParagraph(doc, 'Install it with Docker.');
  appendParagraph(doc, 'Then open the app.');
  appendHeading(doc, 'Roadmap', 1);
  appendParagraph(doc, 'More to come.');
  return doc;
}
const ids = (doc: Y.Doc) => listBlocks(doc).map((b) => b.id);
const texts = (doc: Y.Doc, tab?: string) => listBlocks(doc, tab).map((b) => b.text);

test('block ids are stable while the page changes around them, and the same for every participant', () => {
  const doc = sample();
  const before = ids(doc);
  assert.equal(new Set(before).size, before.length);
  insertBlocks(doc, 'A new first paragraph.', { at: 'start' });
  replaceText(doc, 'writing canvas', 'live canvas');
  assert.deepEqual(ids(doc).slice(1), before);
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  assert.deepEqual(ids(other), ids(doc));
});

test('outline and section reads give an agent one part of the page', () => {
  const doc = sample();
  const [tab] = pageOutline(doc);
  assert.deepEqual(tab.headings.map((h) => [h.text, h.level, h.blocks]), [['Overview', 1, 5], ['Getting started', 2, 3], ['Roadmap', 1, 2]]);
  assert.match(outlineAsText([tab]), /## Getting started {2}\[b_\w+\] {2}\(3 blocks\)/);
  const section = readBlocks(doc, { section: tab.headings[1].id });
  assert.deepEqual(section.blocks.map((b) => b.markdown), ['## Getting started', 'Install it with Docker.', 'Then open the app.']);
  const window = readBlocks(doc, { from: tab.headings[0].id, limit: 2 });
  assert.equal(window.blocks.length, 2);
  assert.equal(window.more, 5);
  assert.match(blocksAsText(doc, section), /^\[b_\w+ heading\]\n## Getting started\n\n\[b_\w+ paragraph\]\nInstall it with Docker\./);
  assert.throws(() => readBlocks(doc, { section: section.blocks[1].id }), /not a heading/);
});

test('replace, insert and delete touch only the named blocks', () => {
  const doc = sample();
  const all = ids(doc);
  const r = replaceBlocks(doc, all[3], 'Install it with **Docker** or Render.\n\n- one\n- two');
  assert.equal(r.ids.length, 2);
  assert.deepEqual(ids(doc).filter((id) => !r.ids.includes(id)), all.filter((id) => id !== all[3]));
  assert.match(tabToMarkdown(doc), /Install it with \*\*Docker\*\* or Render\.\n\n- one\n- two\n\nThen open the app\./);

  const ins = insertBlocks(doc, '## Requirements\n\nNode 22.', { before: all[2] });
  assert.deepEqual(texts(doc).slice(2, 5), ['Requirements', 'Node 22.', 'Getting started']);
  assert.equal(deleteBlocks(doc, ins.ids[0], ins.ids[1]), 2);
  assert.equal(findBlock(doc, ins.ids[0]), null);
  assert.throws(() => deleteBlocks(doc, ins.ids[0]), /no block/);

  // A whole section replaced in one call.
  const sec = readBlocks(doc, { section: all[5] }).blocks;
  replaceBlocks(doc, sec[0].id, '# Roadmap\n\nShipped.', sec[sec.length - 1].id);
  assert.deepEqual(texts(doc).slice(-2), ['Roadmap', 'Shipped.']);
});

test('move keeps content and order, within a tab and across tabs', () => {
  const doc = sample();
  const all = ids(doc);
  // Move the Roadmap section (2 blocks) to the top.
  const up = moveBlocks(doc, all[5], { before: all[0] }, all[6]);
  assert.deepEqual(texts(doc), ['Roadmap', 'More to come.', 'Overview', 'Livepage is a writing canvas.', 'Getting started', 'Install it with Docker.', 'Then open the app.']);
  assert.deepEqual(up.ids, ids(doc).slice(0, 2));
  // And back down, after the last block.
  const down = moveBlocks(doc, up.ids[0], { after: all[4] }, up.ids[1]);
  assert.deepEqual(texts(doc).slice(-2), ['Roadmap', 'More to come.']);
  assert.deepEqual(down.ids, ids(doc).slice(-2));
  const tab = addTab(doc, 'Notes');
  const moved = moveBlocks(doc, all[1], { tab, at: 'end' });
  assert.deepEqual(texts(doc, tab), ['Livepage is a writing canvas.']);
  assert.equal(findBlock(doc, moved.ids[0])?.tab, tab);
  assert.throws(() => moveBlocks(doc, all[0], { after: all[0] }), /next to themselves/);
});

test('find and replace edits text in place and keeps formatting, footnotes and neighbours', () => {
  const doc = new Y.Doc();
  insertBlocks(doc, 'The **quick brown** fox jumps.\n\nThe fox sleeps.');
  insertFootnote(doc, { afterText: 'fox jumps', note: 'A note' });
  const [a, b] = ids(doc);
  const textNode = (fragment(doc).get(0) as Y.XmlElement).get(0);
  replaceText(doc, 'quick brown', 'slow red');
  assert.equal((fragment(doc).get(0) as Y.XmlElement).get(0), textNode, 'same text node: edited in place');
  assert.match(tabToMarkdown(doc), /^The \*\*slow red\*\* fox jumps\[\^1\]\./);
  assert.equal(listFootnotes(doc).length, 1);
  assert.deepEqual(ids(doc), [a, b]);

  assert.throws(() => replaceText(doc, 'fox', 'cat'), /appears 2 times/);
  assert.throws(() => replaceText(doc, 'dog', 'cat'), /not on the page/);
  replaceText(doc, 'fox', 'cat', { blockId: b });
  assert.deepEqual(texts(doc)[1], 'The cat sleeps.');
  assert.equal(replaceText(doc, 'the', 'A', { all: true, matchCase: false }).replaced, 2);
  replaceText(doc, ' sleeps', '');
  assert.equal(texts(doc)[1], 'A cat.');
});

test('find and replace keeps bold, code, links and comment anchors in the words it does not change', () => {
  const doc = new Y.Doc();
  insertBlocks(doc, '**Today** opens `YYYY/MM/DD/daily` for your [local date](https://example.com), creating it if missing.');
  const [id] = ids(doc);
  const note = textAnchorForQuote(doc, 'opens')!;
  const link = textAnchorForQuote(doc, 'local date')!;

  // Appending a sentence by quoting the whole paragraph, as agents do: nothing already there changes.
  replaceText(doc, 'creating it if missing.', 'creating it if missing. New pages go there too.');
  assert.equal(tabToMarkdown(doc).trim(),
    '**Today** opens `YYYY/MM/DD/daily` for your [local date](https://example.com), creating it if missing. New pages go there too.');
  assert.equal(currentAnchorText(doc, note), 'opens');
  assert.equal(currentAnchorText(doc, link), 'local date');

  // A replacement spanning formatted words, written with Markdown, keeps (or sets) that formatting.
  replaceText(doc, 'Today opens YYYY/MM/DD/daily for', '**Today** opens `YYYY/MM/DD/daily` (the daily page) for');
  assert.match(tabToMarkdown(doc), /^\*\*Today\*\* opens `YYYY\/MM\/DD\/daily` \(the daily page\) for your \[local date\]/);
  assert.equal(currentAnchorText(doc, note), 'opens');

  // Markdown can add formatting to kept words, and a plain replacement still inherits it.
  replaceText(doc, 'New pages go there too.', 'New pages go **there** too.');
  assert.match(tabToMarkdown(doc), /New pages go \*\*there\*\* too\.$/m);
  replaceText(doc, 'Today', 'Now');
  assert.match(tabToMarkdown(doc), /^\*\*Now\*\* opens/);
  // Escapes and lists are text, not formatting.
  replaceText(doc, 'the daily page', 'the daily\\_page');
  assert.match(tabToMarkdown(doc), /\(the daily\\_page\)/);
  assert.deepEqual(ids(doc), [id]);
});

test('table cells and rows change without resending the table', () => {
  const doc = new Y.Doc();
  insertTable(doc, [['Tool', 'Does'], ['read_page', 'Reads'], ['write', 'Writes']]);
  const html = insertHtmlBlock(doc, '<p>hi</p>');
  const [table] = ids(doc);
  setTableCell(doc, table, 2, 2, 'Reads the **whole** page');
  assert.equal(insertTableRow(doc, table, ['replace_text', 'Edits in place']), 4);
  assert.equal(insertTableRow(doc, table, ['first'], 1), 2, 'never above the header');
  deleteTableRow(doc, table, 4);
  assert.equal(readBlocks(doc, { from: table, limit: 1 }).blocks[0].markdown,
    '| Tool | Does |\n| --- | --- |\n| first |  |\n| read\\_page | Reads the **whole** page |\n| replace\\_text | Edits in place |');
  assert.deepEqual(ids(doc), [table, html]);
  assert.equal(replaceText(doc, 'read\\_page', 'read_blocks').replaced, 1, 'text quoted from Markdown still matches');
  assert.throws(() => setTableCell(doc, table, 9, 1, 'x'), /row 9 does not exist/);
  assert.throws(() => setTableCell(doc, html, 1, 1, 'x'), /not a table/);
  assert.throws(() => insertTableRow(doc, table, ['a', 'b', 'c']), /2 columns/);
});

test('dragged column widths survive agent table edits and reach the published page', () => {
  const doc = new Y.Doc();
  insertTable(doc, [['Name', 'Notes'], ['a', 'b']]);
  const [table] = ids(doc);
  const tableEl = fragment(doc).toArray()[0] as Y.XmlElement;
  // What the editor writes when someone drags a column border: colwidth on every cell of that column.
  for (const row of tableEl.toArray() as Y.XmlElement[]) (row.toArray()[0] as Y.XmlElement).setAttribute('colwidth', [180] as never);
  setTableCell(doc, table, 2, 1, 'changed');
  insertTableRow(doc, table, ['new', 'row']);
  const rows = tableEl.toArray() as Y.XmlElement[];
  assert.deepEqual(rows.map((r) => (r.toArray()[0] as Y.XmlElement).getAttribute('colwidth')), [[180], [180], [180]]);
  assert.equal((rows[2].toArray()[1] as Y.XmlElement).getAttribute('colwidth'), undefined);
  const html = pageToHtml(doc).tabs[0].html;
  assert.match(html, /<table style="table-layout:fixed;min-width:240px"><colgroup><col style="width:180px"><col><\/colgroup>/);
});

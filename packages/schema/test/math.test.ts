// LaTeX math: Markdown in and out, read_page / read_blocks, targeted edits, published HTML. Run: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  appendParagraph, blocksAsText, fragment, importMarkdown, insertBlocks, listBlocks, pageAsMarkdown, pageToMarkdown,
  readBlocks, replaceBlocks, replaceText, tabToMarkdown, BLOCK_MATH, INLINE_MATH, mathLatex,
} from '../src/index.ts';
import { pageToHtml } from '../src/html.ts';

const page = (md: string) => {
  const doc = new Y.Doc();
  importMarkdown(doc, md);
  return doc;
};
const nodes = (doc: Y.Doc) => fragment(doc).toArray() as Y.XmlElement[];
const mathIn = (el: Y.XmlElement) => el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === INLINE_MATH).map(mathLatex);

test('inline $...$ and display $$...$$ become equations, and export the same way', () => {
  const md = 'Energy is $E = mc^2$, roughly.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nAfter.';
  const doc = page(md);
  const [p, eq, after] = nodes(doc);
  assert.deepEqual(mathIn(p), ['E = mc^2']);
  assert.equal(eq.nodeName, BLOCK_MATH);
  assert.equal(mathLatex(eq), '\\int_0^1 x^2\\,dx = \\frac{1}{3}');
  assert.equal(after.nodeName, 'paragraph');
  assert.equal(tabToMarkdown(doc), md);
});

test('prices stay text, and a $ that would start math is escaped on export', () => {
  const doc = page('It costs $5 and $10, or \\$x\\$ literally.');
  const [p] = nodes(doc);
  assert.deepEqual(mathIn(p), []);
  assert.equal(tabToMarkdown(page('Prices: $5 and $10.')), 'Prices: $5 and $10.');
  // Here a later $ could close one, so every $ that could open math is escaped.
  assert.equal(tabToMarkdown(doc), 'It costs \\$5 and \\$10, or \\$x$ literally.');
  // and it reads back as the same text
  const again = page(tabToMarkdown(doc));
  assert.deepEqual(mathIn(nodes(again)[0]), []);
  assert.equal(listBlocks(again)[0].text, 'It costs $5 and $10, or $x$ literally.');
});

test('\\(..\\), \\[..\\], $$ on one line and ```math fences are read too', () => {
  const doc = page('Inline \\(a^2 + b^2\\) here.\n\n\\[\nc^2\n\\]\n\n$$x = 1$$\n\n```math\ny = 2\n```');
  const [p, a, b, c] = nodes(doc);
  assert.deepEqual(mathIn(p), ['a^2 + b^2']);
  assert.deepEqual([a, b, c].map((n) => [n.nodeName, mathLatex(n)]), [[BLOCK_MATH, 'c^2'], [BLOCK_MATH, 'x = 1'], [BLOCK_MATH, 'y = 2']]);
});

test('math works in lists and table cells', () => {
  const doc = page('- area $\\pi r^2$\n\n| f | f\' |\n|---|---|\n| $x^2$ | $2x$ |');
  const md = tabToMarkdown(doc);
  assert.match(md, /- area \$\\pi r\^2\$/);
  assert.match(md, /\| \$x\^2\$ \| \$2x\$ \|/);
});

test('agents read equations as Markdown and can edit them with targeted tools', () => {
  const doc = new Y.Doc();
  appendParagraph(doc, 'Pythagoras: a2 + b2 = c2.');
  const [id] = insertBlocks(doc, '$$\na^2 + b^2 = c^2\n$$').ids;
  assert.match(pageAsMarkdown(doc), /\$\$\na\^2 \+ b\^2 = c\^2\n\$\$/);
  assert.match(blocksAsText(doc, readBlocks(doc)), new RegExp(`\\[${id} blockMath\\]\\n\\$\\$\\na\\^2`));

  // Turn plain text into inline math, in place.
  replaceText(doc, 'a2 + b2 = c2', '$a^2 + b^2 = c^2$');
  const [p] = nodes(doc);
  assert.deepEqual(mathIn(p), ['a^2 + b^2 = c^2']);
  assert.equal(listBlocks(doc)[0].text, 'Pythagoras: $a^2 + b^2 = c^2$.');

  // Change part of an equation's LaTeX (both equations have "c^2"; quote with $ to edit only inside math).
  replaceText(doc, 'c^2', 'c^{2}', { all: true });
  assert.equal(mathLatex(nodes(doc)[1]), 'a^2 + b^2 = c^{2}');
  assert.deepEqual(mathIn(nodes(doc)[0]), ['a^2 + b^2 = c^{2}']);
  replaceText(doc, '$b^2$', '$\\beta^2$', { occurrence: 2 });
  assert.equal(mathLatex(nodes(doc)[1]), 'a^2 + \\beta^2 = c^{2}');

  // Rewrite the whole equation block.
  replaceBlocks(doc, id, '$$\n\\sqrt{a^2+b^2}\n$$');
  assert.equal(mathLatex(nodes(doc)[1]), '\\sqrt{a^2+b^2}');
});

test('replace_text keeps the text around a new equation, with its formatting', () => {
  const doc = page('Speed is **v = d / t** in metres per second.');
  replaceText(doc, 'v = d / t', '$v = \\frac{d}{t}$');
  assert.equal(tabToMarkdown(doc), 'Speed is $v = \\frac{d}{t}$ in metres per second.');
});

test('published pages render equations with the given renderer, escaped source without one', () => {
  const doc = page('Inline $x<y$ and\n\n$$\na & b\n$$');
  const plain = pageToHtml(doc);
  assert.equal(plain.math, true);
  assert.match(plain.tabs[0].html, /<span class="math-inline"><code>x&lt;y<\/code><\/span>/);
  assert.match(plain.tabs[0].html, /<div class="math-display"><code>a &amp; b<\/code><\/div>/);
  const rendered = pageToHtml(doc, { math: (l, d) => `<k d="${d}">${l.length}</k>` }).tabs[0].html;
  assert.match(rendered, /<span class="math-inline"><k d="false">3<\/k><\/span>/);
  assert.match(rendered, /<div class="math-display"><k d="true">5<\/k><\/div>/);
  assert.equal(pageToHtml(page('No math, $5.')).math, false);
});

test('a whole page round-trips through Markdown export', () => {
  const doc = page('# Notes\n\nGauss: $\\sum_{k=1}^n k = \\frac{n(n+1)}{2}$\n\n$$\ne^{i\\pi} + 1 = 0\n$$');
  const again = page(pageToMarkdown(doc, { frontmatter: false }));
  assert.equal(tabToMarkdown(again), tabToMarkdown(doc));
});

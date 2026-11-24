import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLinks, cleanOrigin, mergeLinks } from '../src/workspace-links.ts';

test('workspace addresses are https origins (http only for this machine)', () => {
  assert.equal(cleanOrigin('https://work.example.com/p/abc?x=1#y'), 'https://work.example.com');
  assert.equal(cleanOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(cleanOrigin('http://work.example.com'), null);
  assert.equal(cleanOrigin('javascript:alert(1)'), null);
  assert.equal(cleanOrigin('https://user:pw@work.example.com'), null);
  assert.equal(cleanOrigin(42), null);
});

test('bad entries are dropped and fields are trimmed', () => {
  const links = cleanLinks([
    { url: 'https://a.example', name: '  Work\u0000 ', color: 99, at: 5, icon: '🚀🚀🚀' },
    { url: 'ftp://b.example', name: 'x', at: 5 },
    { url: 'https://c.example', name: 'no time' },
    'nonsense',
  ]);
  assert.deepEqual(links, [{ url: 'https://a.example', name: 'Work', color: 7, at: 5, icon: '🚀🚀' }]);
});

test('the newest change wins, and removals are not undone by an older list', () => {
  const t = Date.now() - 1000;
  const mine = [{ url: 'https://a.example', name: 'Work', color: 1, at: t + 10 }, { url: 'https://b.example', name: 'Old', color: 2, at: t + 1 }];
  const theirs = [{ url: 'https://a.example', name: 'Work', color: 1, at: t + 20, gone: true as const }, { url: 'https://b.example', name: 'New', color: 2, at: t + 2 }];
  const merged = mergeLinks(mine, theirs);
  assert.equal(merged.find((l) => l.url === 'https://a.example')?.gone, true);
  assert.equal(merged.find((l) => l.url === 'https://b.example')?.name, 'New');
  assert.deepEqual(mergeLinks(theirs, mine), merged);
  // A long-gone removal is forgotten.
  assert.deepEqual(mergeLinks([{ url: 'https://z.example', name: 'Z', color: 1, at: 5, gone: true }], []), []);
});

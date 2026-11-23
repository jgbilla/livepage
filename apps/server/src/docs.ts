// Reading and writing page documents from server code (export, import, templates, publishing).
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { Db } from './db.ts';

export type Who = { id: string; name: string; kind: 'human' | 'agent' };

/**
 * A page's current document, read-only. Uses the live copy when someone has the page open
 * (so edits from the last few seconds are included), otherwise the saved one.
 */
export async function readDoc(hp: Hocuspocus, db: Db, pageId: string): Promise<Y.Doc> {
  const live = hp.documents.get(pageId);
  if (live) return live as unknown as Y.Doc;
  const doc = new Y.Doc();
  const [row] = await db.query('select data from documents where name = $1', [pageId]);
  if (row?.data) Y.applyUpdate(doc, new Uint8Array(row.data));
  return doc;
}

/** Change a page through the collab server, so open editors see the change at once. Saved on return. */
export async function writeDoc<T>(hp: Hocuspocus, pageId: string, who: Who, fn: (doc: Y.Doc) => T): Promise<T> {
  const conn = await hp.openDirectConnection(pageId, { user: who });
  let out!: T;
  try {
    await conn.transact((d) => { out = fn(d as unknown as Y.Doc); });
  } finally {
    await conn.disconnect();
  }
  return out;
}

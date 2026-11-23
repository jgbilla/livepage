import pg from 'pg';
import type { BlockRow } from '@livepage/schema';

// Storage model (see SPEC.md "Storage"):
//   documents  one row per page, holding the Yjs state (source of truth for content)
//   blocks     a projection of each page's top-level blocks, rewritten on save,
//              so the server can query, search and build Notion-style database views
export const SCHEMA_SQL = `
create table if not exists documents (
  name        text primary key,
  data        bytea not null,
  updated_at  timestamptz not null default now()
);
create table if not exists blocks (
  doc_name  text not null references documents(name) on delete cascade,
  id        text not null,
  position  int  not null,
  type      text not null,
  text      text not null default '',
  attrs     jsonb not null default '{}',
  primary key (doc_name, id)
);
create index if not exists blocks_type_idx on blocks (type);
`;

export type Store = {
  fetch(name: string): Promise<Uint8Array | null>;
  store(name: string, state: Uint8Array, blocks: BlockRow[]): Promise<void>;
};

export async function createStore(url: string | undefined): Promise<Store> {
  if (!url) {
    console.warn('[server] DATABASE_URL not set: pages are kept in memory and lost on restart.');
    const mem = new Map<string, Uint8Array>();
    return {
      async fetch(name) { return mem.get(name) ?? null; },
      async store(name, state) { mem.set(name, state); },
    };
  }
  const pool = new pg.Pool({ connectionString: url });
  await pool.query(SCHEMA_SQL);
  return {
    async fetch(name) {
      const r = await pool.query('select data from documents where name = $1', [name]);
      return r.rows[0]?.data ?? null;
    },
    async store(name, state, blocks) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into documents (name, data, updated_at) values ($1, $2, now())
           on conflict (name) do update set data = excluded.data, updated_at = now()`,
          [name, Buffer.from(state)],
        );
        await client.query('delete from blocks where doc_name = $1', [name]);
        for (const b of blocks) {
          await client.query(
            'insert into blocks (doc_name, id, position, type, text, attrs) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
            [name, b.id, b.position, b.type, b.text, JSON.stringify(b.attrs)],
          );
        }
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

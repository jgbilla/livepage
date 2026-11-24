import pg from 'pg';

// One small interface over two drivers:
//  - node-postgres for a real (hosted) Postgres: the default, via DATABASE_URL
//  - PGlite (Postgres compiled to WASM, in memory) for `pnpm dev:memory` and tests
// Both run the same SQL, so there is one code path for accounts, pages and content.

export type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
export type Db = { query: Query; tx: <T>(fn: (q: Query) => Promise<T>) => Promise<T> };

export const SCHEMA_SQL = `
create table if not exists users (
  id            text primary key,
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);
create table if not exists sessions (
  id_hash    text primary key,
  user_id    text not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists pages (
  id         text primary key,
  owner_id   text not null references users(id) on delete cascade,
  title      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists page_members (
  page_id text not null references pages(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role    text not null check (role in ('owner','editor','commenter','viewer')),
  primary key (page_id, user_id)
);
create table if not exists share_links (
  token      text primary key,
  page_id    text not null references pages(id) on delete cascade,
  role       text not null check (role in ('editor','commenter','viewer')),
  created_by text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked    boolean not null default false
);
create table if not exists api_tokens (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  name       text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
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
alter table blocks add column if not exists tab text not null default 'main';
create index if not exists blocks_type_idx on blocks (type);
-- Neon Auth (Google and other social sign-in) links to the same users rows.
alter table users add column if not exists neon_auth_id text unique;
alter table users alter column password_hash drop not null;
-- The other Livepage copies this person switches to from the sidebar (see workspace-links.ts).
alter table users add column if not exists workspace_links jsonb not null default '[]';
create index if not exists page_members_user_idx on page_members (user_id);
-- Built-in AI assistant: each person's own provider, model and API key (key encrypted with AI_KEY_SECRET).
create table if not exists ai_settings (
  user_id     text primary key references users(id) on delete cascade,
  provider    text not null,
  model       text not null,
  base_url    text not null default '',
  api_key_enc text not null default '',
  key_hint    text not null default '',
  updated_at  timestamptz not null default now()
);
-- Ask AI requests handed to a person's own connected agent (Claude Code, Cursor... over MCP or HTTP).
create table if not exists agent_requests (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  token_id   text not null references api_tokens(id) on delete cascade,
  page_id    text not null references pages(id) on delete cascade,
  tab        text not null default 'main',
  prompt     text not null,
  selection  text not null default '',
  history    jsonb not null default '[]',
  status     text not null default 'pending' check (status in ('pending','working','done','cancelled')),
  progress   text not null default '',
  reply      text not null default '',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at    timestamptz
);
create index if not exists agent_requests_token_idx on agent_requests (token_id, status);
-- Folders: each person's own tree (like an Obsidian vault). A page sits in one folder per
-- member, so a page someone shared with you can live wherever you like in your tree.
create table if not exists folders (
  id         text primary key,
  owner_id   text not null references users(id) on delete cascade,
  parent_id  text references folders(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists folders_sibling_name_idx on folders (owner_id, coalesce(parent_id, ''), lower(name));
alter table page_members add column if not exists folder_id text references folders(id) on delete set null;
-- Tags belong to the page, so everyone with access sees the same tags. Stored lowercase.
create table if not exists page_tags (
  page_id text not null references pages(id) on delete cascade,
  tag     text not null,
  primary key (page_id, tag)
);
create index if not exists page_tags_tag_idx on page_tags (tag);
-- Saved views: a named list in someone's sidebar of the pages that match some tags.
create table if not exists views (
  id         text primary key,
  owner_id   text not null references users(id) on delete cascade,
  name       text not null,
  tags       jsonb not null default '[]',
  match      text not null default 'any' check (match in ('any','all')),
  created_at timestamptz not null default now()
);
create index if not exists views_owner_idx on views (owner_id);
-- Links between pages, rebuilt from each page's document when it is saved (for backlinks).
create table if not exists page_links (
  from_page text not null references pages(id) on delete cascade,
  from_tab  text not null default 'main',
  from_tab_title text not null default '',
  to_page   text not null,
  to_tab    text
);
create index if not exists page_links_to_idx on page_links (to_page);
create index if not exists page_links_from_idx on page_links (from_page);
-- Comments (threads anchored to text, a block or the page) and @mentions of people and agents.
create table if not exists comments (
  id          text primary key,
  page_id     text not null references pages(id) on delete cascade,
  thread_id   text not null,
  tab         text not null default 'main',
  anchor      jsonb,
  body        text not null,
  author_id   text not null,
  author_name text not null,
  author_kind text not null check (author_kind in ('human','agent')),
  token_id    text,
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists comments_page_idx on comments (page_id, thread_id, created_at);
create table if not exists comment_mentions (
  id          text primary key,
  comment_id  text not null references comments(id) on delete cascade,
  page_id     text not null references pages(id) on delete cascade,
  thread_id   text not null,
  target_kind text not null check (target_kind in ('user','agent')),
  target_id   text not null,
  created_at  timestamptz not null default now(),
  handled_at  timestamptz
);
create index if not exists comment_mentions_target_idx on comment_mentions (target_kind, target_id, handled_at);
-- Optional outgoing webhook per agent token, called when someone @mentions that agent.
alter table api_tokens add column if not exists webhook_url text;
alter table api_tokens add column if not exists webhook_secret text;
-- Templates: any page can be marked as one. New pages (and each person's daily page) can start from a template.
alter table pages add column if not exists is_template boolean not null default false;
alter table users add column if not exists daily_template_id text references pages(id) on delete set null;
-- Publishing: a published page is readable by anyone at /pub/<slug>, without an account.
alter table pages add column if not exists published_slug text unique;
alter table pages add column if not exists published_at timestamptz;
`;

export async function connect(url: string | undefined): Promise<Db> {
  if (!url) {
    // Pages must outlive the server process, so a real database is required.
    if (process.env.LIVEPAGE_MEMORY_STORE !== '1') {
      console.error(
        '[server] DATABASE_URL is not set.\n' +
          '  Use a hosted Postgres (Neon, Supabase, RDS...) and paste its connection string into .env,\n' +
          '  or run `pnpm dev:memory` to try Livepage without saving anything.',
      );
      process.exit(1);
    }
    console.warn('[server] LIVEPAGE_MEMORY_STORE=1: in-memory Postgres (PGlite). Everything is LOST on restart.');
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite();
    await lite.exec(SCHEMA_SQL);
    const q = (runner: { query: (s: string, p?: any[]) => Promise<{ rows: any[] }> }): Query =>
      async (sql, params) => (await runner.query(sql, params as any[])).rows;
    return { query: q(lite), tx: (fn) => lite.transaction((t) => fn(q(t))) };
  }

  // Hosted Postgres: TLS comes from the connection string (?sslmode=require, which Neon and
  // Supabase include). Keep the pool small: hosted plans cap connections.
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 5),
    // Keep connections open between requests: a fresh TLS connection to a hosted database
    // costs several round trips, which a person would otherwise feel on the next click.
    idleTimeoutMillis: Number(process.env.PG_IDLE_MS ?? 5 * 60_000),
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
  });
  // Hosted databases close idle connections and restart for maintenance; don't crash on that.
  pool.on('error', (err) => console.warn('[server] postgres connection dropped:', err.message));
  await pool.query(SCHEMA_SQL);
  return {
    query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(async (sql, params) => (await client.query(sql, params as any[])).rows);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

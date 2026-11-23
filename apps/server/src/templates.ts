// Templates: any page can be marked as a template (pages.is_template). New pages, and each
// person's daily page (users.daily_template_id), can start as a copy of one. See packages/schema/src/template.ts
// for the {{variables}} and fill-in {{fields}}.
import type { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { applyTemplate, builtinValue, FIELD_RE, type TemplateVars } from '@livepage/schema';
import type { Db } from './db.ts';
import { readDoc, writeDoc, type Who } from './docs.ts';
import { pageTags, setPageTags, setTitle } from './pages.ts';

export async function listTemplates(db: Db, userId: string) {
  const rows = await db.query(
    `select p.id, p.title, p.updated_at, m.role from page_members m join pages p on p.id = m.page_id
      where m.user_id = $1 and p.is_template order by lower(p.title)`,
    [userId],
  );
  const [u] = await db.query('select daily_template_id from users where id = $1', [userId]);
  return { templates: rows, daily_template_id: (u?.daily_template_id as string | null) ?? null };
}

export async function setTemplateFlag(db: Db, pageId: string, on: boolean) {
  await db.query('update pages set is_template = $2 where id = $1', [pageId, on]);
  if (!on) await db.query('update users set daily_template_id = null where daily_template_id = $1', [pageId]);
}

/** Which template your daily pages start from (null = a blank page). It must be a template you can open. */
export async function setDailyTemplate(db: Db, userId: string, pageId: string | null): Promise<boolean> {
  if (pageId) {
    const [ok] = await db.query(
      'select 1 from page_members m join pages p on p.id = m.page_id where m.user_id = $1 and m.page_id = $2 and p.is_template',
      [userId, pageId],
    );
    if (!ok) return false;
  }
  await db.query('update users set daily_template_id = $2 where id = $1', [userId, pageId]);
  return true;
}

export async function dailyTemplateFor(db: Db, userId: string): Promise<string | null> {
  const [u] = await db.query(
    `select u.daily_template_id as id from users u join page_members m on m.page_id = u.daily_template_id and m.user_id = u.id
      where u.id = $1`,
    [userId],
  );
  return (u?.id as string | undefined) ?? null;
}

/** A template's title with its variables filled in, e.g. "Meeting {{date}}" -> "Meeting 2026-11-23". */
export function titleFromTemplate(templateTitle: string, vars: TemplateVars): string {
  return templateTitle.replace(FIELD_RE, (all, name) => builtinValue(name, vars) ?? all).slice(0, 200);
}

/** Fill a brand-new, empty page from a template. Tags are copied too. */
export async function fillFromTemplate(
  hp: Hocuspocus, db: Db, who: Who, pageId: string, templateId: string, vars: TemplateVars,
): Promise<void> {
  const template = await readDoc(hp, db, templateId);
  const state = Y.encodeStateAsUpdate(template);
  await writeDoc(hp, pageId, who, (doc) => applyTemplate(doc, state, vars));
  await setTitle(db, pageId, vars.title);
  const tags = (await pageTags(db, templateId)).filter((t) => t !== 'template' && t !== 'templates');
  if (tags.length) await setPageTags(db, pageId, tags);
}

/** "YYYY-MM-DD" and "HH:mm" for template variables, from what the browser sent or the server clock. */
export function templateClock(b: { date?: unknown; time?: unknown }): { date: string; time: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = typeof b.time === 'string' && /^\d{2}:\d{2}$/.test(b.time) ? b.time : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { date, time };
}

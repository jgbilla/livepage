// Import and export. Export writes Obsidian-friendly Markdown: one .md file per page, in
// the person's own folder tree, with [[wiki links]] between pages. Import reads the same
// (a Markdown file, several, or a whole Obsidian vault) and rebuilds folders, tags and links.
import type { Hocuspocus } from '@hocuspocus/server';
import { zipSync, strToU8 } from 'fflate';
import { importMarkdown, MAIN_TAB, pageToMarkdown, splitFrontmatter, type LinkTarget } from '@livepage/schema';
import type { Db } from './db.ts';
import { readDoc, writeDoc, type Who } from './docs.ts';
import { folderPaths, listFolders, splitPath } from './folders.ts';
import { createPage, listPages, pageTags, setPageTags, tagsByPage } from './pages.ts';

/** A title as a safe file name (no slashes or characters Windows and Obsidian reject). */
export function fileName(title: string): string {
  return (title || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

type Entry = { id: string; title: string; path: string; file: string /* vault path without .md */ };

/** Every page this person can open, with a unique vault path for each. */
async function vaultEntries(db: Db, userId: string): Promise<Entry[]> {
  const [pages, folders] = await Promise.all([listPages(db, userId), listFolders(db.query, userId)]);
  const paths = folderPaths(folders);
  const used = new Set<string>();
  return pages
    .map((p: any) => ({ id: p.id as string, title: (p.title as string) || '', path: p.folder_id ? paths.get(p.folder_id) ?? '' : '' }))
    .sort((a, b) => (a.path + a.title).localeCompare(b.path + b.title))
    .map((p) => {
      const base = `${p.path ? `${p.path}/` : ''}${fileName(p.title)}`;
      let file = base;
      for (let i = 2; used.has(file.toLowerCase()); i++) file = `${base} ${i}`;
      used.add(file.toLowerCase());
      return { ...p, file };
    });
}

/** How a link is written in exported Markdown: [[vault path|label]] when the target is in the export. */
function linkWriter(byId: Map<string, Entry>) {
  return (t: LinkTarget) => {
    const e = byId.get(t.page);
    if (!e) return t.label ? String(t.label) : '';
    const label = t.label && String(t.label) !== e.title ? String(t.label) : null;
    return `[[${e.file}${label ? `|${label.replace(/[\]|]/g, '')}` : ''}]]`;
  };
}

export async function exportPage(hp: Hocuspocus, db: Db, userId: string, pageId: string): Promise<{ name: string; markdown: string }> {
  const entries = userId ? await vaultEntries(db, userId) : [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const doc = await readDoc(hp, db, pageId);
  const [page] = await db.query('select title from pages where id = $1', [pageId]);
  const title = String(page?.title ?? '');
  // A single file has no vault around it, so links name the page title only.
  const link = (t: LinkTarget) => {
    const e = byId.get(t.page);
    return e ? `[[${fileName(e.title)}${t.label && t.label !== e.title ? `|${t.label}` : ''}]]` : String(t.label ?? '');
  };
  const markdown = pageToMarkdown(doc, { title, tags: await pageTags(db, pageId), link });
  return { name: `${fileName(title)}.md`, markdown };
}

/** All of this person's pages as a zip of Markdown files in their folder tree. */
export async function exportVault(hp: Hocuspocus, db: Db, userId: string): Promise<Uint8Array> {
  const entries = await vaultEntries(db, userId);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const tags = await tagsByPage(db, userId);
  const files: Record<string, Uint8Array> = {};
  const link = linkWriter(byId);
  for (const e of entries) {
    const doc = await readDoc(hp, db, e.id);
    files[`Livepage/${e.file}.md`] = strToU8(pageToMarkdown(doc, { title: e.title, tags: tags.get(e.id) ?? [], link }));
  }
  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// Import

export type ImportFile = { path: string; content: string };
export type ImportReport = {
  pages: { id: string; title: string; path: string }[];
  skipped: string[];
  unresolved: string[];
};

export const IMPORT_LIMITS = { files: 2000, bytes: 25 * 1024 * 1024 };

/**
 * Create one page per Markdown file. Folders in the file paths become folders (under `into`
 * if given). [[Links]] between the imported files become real links; frontmatter and #tags become tags.
 */
export async function importFiles(hp: Hocuspocus, db: Db, who: Who, files: ImportFile[], into: string[] = []): Promise<ImportReport> {
  const skipped: string[] = [];
  const notes: { path: string[]; title: string; content: string; id?: string }[] = [];
  for (const f of files.slice(0, IMPORT_LIMITS.files)) {
    const clean = String(f.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p.startsWith('.')) || !/\.(md|markdown|txt)$/i.test(clean)) { skipped.push(clean); continue; }
    const name = parts.pop()!.replace(/\.(md|markdown|txt)$/i, '');
    const folders = splitPath(parts.join('/')) ?? [];
    notes.push({ path: folders, title: name, content: String(f.content ?? '') });
  }
  if (files.length > IMPORT_LIMITS.files) skipped.push(`…and ${files.length - IMPORT_LIMITS.files} more files (limit ${IMPORT_LIMITS.files})`);

  // Pass 1: create every page, so links can point at pages that come later.
  const index = new Map<string, string>(); // lowercase name / path / alias -> page id
  for (const n of notes) {
    const { fm } = splitFrontmatter(n.content);
    const page = await createPage(db, who.id, fm.title ?? n.title, { path: [...into, ...n.path] });
    n.id = page.id;
    const full = [...n.path, n.title].join('/').toLowerCase();
    for (const key of [n.title.toLowerCase(), full, ...fm.aliases.map((a) => a.toLowerCase())]) if (!index.has(key)) index.set(key, page.id);
    // Paths relative to any parent folder also resolve, as in Obsidian: [[Sub/Note]].
    for (let i = 1; i < n.path.length; i++) {
      const k = [...n.path.slice(i), n.title].join('/').toLowerCase();
      if (!index.has(k)) index.set(k, page.id);
    }
  }

  // Pass 2: write the content.
  const unresolved = new Set<string>();
  const resolve = (target: string): LinkTarget | null => {
    const key = target.replace(/\.md$/i, '').replace(/^\.?\//, '').toLowerCase();
    const id = index.get(key) ?? index.get(key.split('/').pop()!);
    return id ? { page: id, tab: MAIN_TAB } : null;
  };
  const out: ImportReport['pages'] = [];
  for (const n of notes) {
    const r = await writeDoc(hp, n.id!, who, (doc) => importMarkdown(doc, n.content, { resolve }));
    r.unresolved.forEach((u) => unresolved.add(u));
    if (r.tags.length) await setPageTags(db, n.id!, r.tags);
    out.push({ id: n.id!, title: r.title ?? n.title, path: [...into, ...n.path].join('/') });
  }
  return { pages: out, skipped, unresolved: [...unresolved].slice(0, 200) };
}

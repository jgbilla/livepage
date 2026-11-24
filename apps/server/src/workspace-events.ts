// Live workspace updates: tells each person's open apps (every device) when their sidebar and
// page list changed, so a page made, renamed, moved or shared on one device shows up on the
// others without a reload. Page content itself syncs over the live connection (/collab).
//
//   GET /api/workspace/events?since=<n>&tasks=<m>&wait=25  -> { rev, tasks }   (returns early when either changes)
//   GET /api/pages also returns the rev its list is current to, which is what an app passes as since;
//   GET /api/tasks returns the tasks rev (the task board, tasks.ts), passed as tasks.
//
// Kept in memory: one server process (Render, Docker) serves everyone. After a restart the
// counter starts again, which only makes open apps reload their list once.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import { send } from './agent-api.ts';

const START = Date.now() % 1_000_000_000; // a restart never repeats a number an app already saw
const revs = new Map<string, number>();
const taskRevs = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();
const MAX_WAIT = 30_000;

export const workspaceRev = (userId: string) => revs.get(userId) ?? START;
export const tasksRev = (userId: string) => taskRevs.get(userId) ?? START;

function wakeUser(id: string) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const fn of set) fn();
}

/** Something in these people's workspaces changed: wake their open apps. */
export function bumpWorkspace(...userIds: string[]) {
  for (const id of new Set(userIds)) {
    revs.set(id, workspaceRev(id) + 1);
    wakeUser(id);
  }
}

/** This person's task board changed (a task was added, an agent moved one along): wake their open apps. */
export function bumpTasks(userId: string) {
  taskRevs.set(userId, tasksRev(userId) + 1);
  wakeUser(userId);
}

/** Everyone who has this page in their workspace. */
export async function bumpPageMembers(db: Db, pageId: string) {
  const rows = await db.query<{ user_id: string }>('select user_id from page_members where page_id = $1', [pageId]);
  bumpWorkspace(...rows.map((r) => r.user_id));
}

export async function handleWorkspaceEvents(req: IncomingMessage, res: ServerResponse, userId: string, url: URL) {
  const since = Number(url.searchParams.get('since'));
  const tasksSince = url.searchParams.has('tasks') ? Number(url.searchParams.get('tasks')) : tasksRev(userId);
  const ms = Math.min(MAX_WAIT, Math.max(0, Number(url.searchParams.get('wait')) * 1000 || 0));
  if (ms && since === workspaceRev(userId) && tasksSince === tasksRev(userId)) {
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); waiters.get(userId)?.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      let set = waiters.get(userId);
      if (!set) waiters.set(userId, (set = new Set()));
      set.add(done);
      res.on('close', done);
    });
  }
  if (!res.writableEnded && !res.destroyed) send(res, 200, { rev: workspaceRev(userId), tasks: tasksRev(userId) }, { 'Cache-Control': 'no-store' });
}

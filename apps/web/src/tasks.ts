// The task board's data: tasks you handed to your agents, and your agents (for assigning).
// One shared store, so the sidebar badge and the board agree. It follows the server's tasks counter
// on the same long poll as the page list (workspace.ts), so an agent's note shows up on every device.
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { setTasksFollower, watchTasksNow } from './workspace';

export type TaskStatus = 'queued' | 'working' | 'needs_you' | 'done' | 'failed' | 'cancelled';
export type Task = {
  id: string; title: string; details: string; status: TaskStatus; note: string;
  token_id: string | null; any_agent: boolean; agent_name: string; agent_online: boolean;
  /** Will it be picked up now: the agent is listening (or, for any agent, one of yours is). */
  agent_listening: boolean; agent_last_seen_at: string | null;
  /** Its agent took it again and again without confirming (a broken listening loop). */
  unconfirmed: { agent_name: string; times: number } | null;
  page_id: string | null; page_title: string | null; pages: { id: string; title: string }[];
  delivery: 'queued' | 'delivered' | null; last_message_at: string | null;
  created_at: string; updated_at: string; done_at: string | null;
};
export type TaskEvent = {
  id: string; kind: 'created' | 'note' | 'status' | 'message' | 'page' | 'assigned';
  author_kind: 'human' | 'agent' | 'system'; author_name: string; text: string; status: TaskStatus | null;
  page_id: string | null; page_title: string | null; created_at: string;
};
export type AgentChoice = { id: string; name: string; online: boolean; listening: boolean; last_seen_at: string | null; last_listen_at: string | null; unconfirmed?: boolean };
/** token_id for "any available agent": the first of your agents that is listening takes the task. */
export const ANY_AGENT = 'any';

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Where an agent is: listening (it will pick work up now), taking work it never confirms, connected but not listening, or away. */
export type Presence = 'listening' | 'unconfirmed' | 'idle' | 'away' | 'never';
type PresenceIn = { listening: boolean; last_seen_at: string | null; unconfirmed?: boolean };
export function presence(a: PresenceIn): Presence {
  if (a.unconfirmed) return 'unconfirmed';
  if (a.listening) return 'listening';
  if (!a.last_seen_at) return 'never';
  return Date.now() - new Date(a.last_seen_at).getTime() < 10 * 60_000 ? 'idle' : 'away';
}
export function presenceText(a: PresenceIn): string {
  switch (presence(a)) {
    case 'listening': return 'Listening now';
    case 'unconfirmed': return 'Takes tasks but never confirms them';
    case 'idle': return 'Connected, not listening';
    case 'away': return `Not listening · seen ${timeAgo(a.last_seen_at!)}`;
    default: return 'Never connected';
  }
}

type State = { tasks: Task[]; agents: AgentChoice[]; rev: number | null; loaded: boolean };
let state: State = { tasks: [], agents: [], rev: null, loaded: false };
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => { state = { ...state, ...s }; listeners.forEach((l) => l()); };

let inflight: Promise<void> | null = null;
export function reloadTasks(): Promise<void> {
  inflight ??= Promise.all([
    api<{ tasks: Task[]; rev: number }>('/tasks'),
    api<{ agents: AgentChoice[] }>('/agents').catch(() => ({ agents: state.agents })),
  ]).then(([t, a]) => {
    const first = !state.loaded;
    set({ tasks: t.tasks, rev: t.rev, agents: a.agents, loaded: true });
    if (first) watchTasksNow();
  })
    .catch(() => {})
    .finally(() => { inflight = null; });
  return inflight;
}

setTasksFollower(() => (state.loaded ? state.rev : null), (rev) => (rev !== state.rev && state.loaded ? reloadTasks() : Promise.resolve()));

export function useTasks(): State {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
  useEffect(() => { if (!state.loaded) void reloadTasks(); }, []);
  return s;
}

export function resetTasks() { state = { tasks: [], agents: [], rev: null, loaded: false }; listeners.forEach((l) => l()); }

/** Put a changed task in the list right away (the server's change counter catches the rest up). */
export function upsertTask(t: Task) {
  const i = state.tasks.findIndex((x) => x.id === t.id);
  set({ tasks: i < 0 ? [t, ...state.tasks] : state.tasks.map((x) => (x.id === t.id ? t : x)) });
}

export async function createTask(input: { title: string; details: string; token_id: string; page_id?: string | null }) {
  const { task } = await api<{ task: Task }>('/tasks', { body: input });
  upsertTask(task);
  return task;
}
export async function patchTask(id: string, patch: Partial<Pick<Task, 'title' | 'details' | 'token_id' | 'status'>>) {
  const { task } = await api<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: patch });
  upsertTask(task);
  return task;
}
export async function messageTask(id: string, text: string) {
  const { task } = await api<{ task: Task }>(`/tasks/${id}/messages`, { body: { text } });
  upsertTask(task);
  return task;
}
export async function deleteTask(id: string) {
  await api(`/tasks/${id}`, { method: 'DELETE' });
  set({ tasks: state.tasks.filter((t) => t.id !== id) });
}
export const loadTask = (id: string) => api<{ task: Task; events: TaskEvent[] }>(`/tasks/${id}`);

/** Columns of the board. Failed and cancelled tasks sit with the finished ones. */
export type Column = 'queued' | 'working' | 'needs_you' | 'done';
export const columnOf = (s: TaskStatus): Column => (s === 'failed' || s === 'cancelled' ? 'done' : s);
export const COLUMNS: { id: Column; label: string; empty: string }[] = [
  { id: 'queued', label: 'Queued', empty: 'Nothing waiting for an agent.' },
  { id: 'working', label: 'Working', empty: 'No agent is working on a task.' },
  { id: 'needs_you', label: 'Needs you', empty: 'Nothing needs you.' },
  { id: 'done', label: 'Done', empty: 'Finished tasks show here.' },
];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued', working: 'Working', needs_you: 'Needs you', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

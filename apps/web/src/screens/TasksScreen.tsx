import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../design/Icon';
import { AgentAvatar } from '../Presence';
import { Link, useLocation, useNavigate } from '../router';
import { SidebarToggle } from '../Sidebar';
import { titleOf, useWorkspace } from '../workspace';
import {
  ANY_AGENT, COLUMNS, STATUS_LABEL, columnOf, createTask, deleteTask, loadTask, messageTask, patchTask, presence, presenceText, timeAgo, useTasks,
  type AgentChoice, type Column, type Task, type TaskEvent,
} from '../tasks';
import { ConnectAgentDialog, LISTEN_COMMAND } from './ConnectAgent';

// The task board (/tasks): jobs handed to your agents, by status. ?task=<id> opens one,
// ?new=1&page=<id> starts a new one about a page (the page menu's "Hand to an agent").
export function TasksScreen() {
  const { search } = useLocation();
  const go = useNavigate();
  const params = new URLSearchParams(search);
  const openId = params.get('task');
  const { tasks, agents, loaded } = useTasks();
  const [creating, setCreating] = useState<{ page: string | null } | null>(
    params.get('new') ? { page: params.get('page') } : null);
  const [tab, setTab] = useState<Column>(() => (tasks.some((t) => t.status === 'needs_you') ? 'needs_you' : 'queued'));
  // "Get this agent listening": the connect steps for one agent, over whatever is open.
  const [connect, setConnect] = useState<{ id: string; name: string } | null>(null);
  const connectFor = (id: string | null) => {
    const a = (id && agents.find((x) => x.id === id)) || bestAgent(agents);
    if (a) setConnect({ id: a.id, name: a.name });
  };

  useEffect(() => { if (params.get('new')) setCreating({ page: params.get('page') }); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const byColumn = useMemo(() => {
    const out: Record<Column, Task[]> = { queued: [], working: [], needs_you: [], done: [] };
    for (const t of tasks) out[columnOf(t.status)].push(t);
    // Open work oldest first (the order it was handed out); finished work newest first.
    for (const c of ['queued', 'working', 'needs_you'] as const) out[c].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    out.done.sort((a, b) => +new Date(b.done_at ?? b.updated_at) - +new Date(a.done_at ?? a.updated_at));
    return out;
  }, [tasks]);

  const open = (id: string | null) => go(id ? `/tasks?task=${id}` : '/tasks');
  const current = openId ? tasks.find((t) => t.id === openId) : undefined;

  return (
    <div className="shell tasks-screen">
      <header className="topbar">
        <SidebarToggle />
        <h1 className="panel-title"><Icon name="tasks" />Tasks</h1>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating({ page: null })} disabled={loaded && !agents.length}
          title={loaded && !agents.length ? 'Make an agent token on your home page first' : 'Hand a job to one of your agents'}>
          <Icon name="plus" />New task
        </button>
      </header>
      <main className="tasks-main">
        {!loaded ? <p className="muted tasks-pad">Loading…</p> : !agents.length && !tasks.length ? <NoAgents /> : (
          <>
            {agents.length > 0 && <AgentStrip agents={agents} onConnect={(a) => setConnect(a)} />}
            <div className="tasks-tabs" role="tablist" aria-label="Status">
              {COLUMNS.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={tab === c.id} className={`tasks-tab ${tab === c.id ? 'on' : ''}`} onClick={() => setTab(c.id)}>
                  {c.label}<span className={`tasks-count ${c.id === 'needs_you' && byColumn[c.id].length ? 'tasks-count-alert' : ''}`}>{byColumn[c.id].length}</span>
                </button>
              ))}
            </div>
            <div className="tasks-board">
              {COLUMNS.map((c) => (
                <section key={c.id} className={`tasks-col tasks-col-${c.id} ${tab === c.id ? 'tasks-col-on' : ''}`} aria-label={c.label}>
                  <h2 className="tasks-col-head">
                    <span className={`task-dot task-dot-${c.id}`} aria-hidden="true" />{c.label}
                    <span className={`tasks-count ${c.id === 'needs_you' && byColumn[c.id].length ? 'tasks-count-alert' : ''}`}>{byColumn[c.id].length}</span>
                  </h2>
                  {byColumn[c.id].length ? (
                    <ul className="tasks-list">
                      {byColumn[c.id].map((t) => <li key={t.id}><TaskCard task={t} active={t.id === openId} onOpen={() => open(t.id)} /></li>)}
                    </ul>
                  ) : <p className="tasks-empty">{c.empty}</p>}
                </section>
              ))}
            </div>
          </>
        )}
      </main>
      {openId && (current
        ? <TaskSheet key={current.id} task={current} agents={agents} onClose={() => open(null)} onConnect={connectFor} />
        : loaded && <MissingTask onClose={() => open(null)} />)}
      {creating && (
        <NewTaskDialog agents={agents} pageId={creating.page} onConnect={connectFor}
          onClose={(t) => { setCreating(null); if (t) { setTab('queued'); open(t.id); } else if (params.get('new')) go('/tasks', true); }} />
      )}
      {connect && <ConnectAgentDialog agent={connect} onClose={() => setConnect(null)} />}
    </div>
  );
}

/** The agent to suggest when none is named: one that is listening, else the one seen last. */
function bestAgent(agents: AgentChoice[]): AgentChoice | undefined {
  return agents.find((a) => a.listening)
    ?? [...agents].sort((a, b) => +new Date(b.last_seen_at ?? 0) - +new Date(a.last_seen_at ?? 0))[0];
}

export function PresenceDot({ a }: { a: { listening: boolean; last_seen_at: string | null } }) {
  return <span className={`presence-dot presence-${presence(a)}`} aria-hidden="true" />;
}

/** Your agents and whether each is listening right now. Tap one that isn't for how to start it. */
function AgentStrip({ agents, onConnect }: { agents: AgentChoice[]; onConnect: (a: AgentChoice) => void }) {
  const n = agents.filter((a) => a.listening).length;
  return (
    <div className="agent-strip" aria-label="Your agents">
      <span className="agent-strip-sum">{n ? `${n} of ${agents.length} listening` : 'No agent is listening'}</span>
      <ul>
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" className={`agent-chip ${a.listening ? 'on' : ''}`} onClick={() => onConnect(a)}
              title={`${presenceText(a)}. ${a.listening ? 'Show how it connects' : 'How to get it listening'}`}>
              <AgentAvatar peer={{ id: `agent:${a.id}`, name: a.name, color: '', kind: 'agent' }} size="sm" />
              <span className="agent-chip-name">{a.name}</span>
              <PresenceDot a={a} />
              <span className="sr-only">{presenceText(a)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NoAgents() {
  return (
    <div className="tasks-pad tasks-intro">
      <h2>Hand jobs to your agents</h2>
      <p className="muted">Give a task to Claude Code, Cursor or any agent you connected, and follow it here: queued, working, needs you, done. The agent gets it the moment you hand it out, writes notes as it goes, and lists the pages it changed.</p>
      <p className="muted">First make an agent token under <Link to="/">Agents on your home page</Link> and connect your agent with it.</p>
    </div>
  );
}

const agentPeer = (t: { token_id: string | null; agent_name: string }) => ({ id: t.token_id ? `agent:${t.token_id}` : undefined, name: t.agent_name, color: '', kind: 'agent' });
const unclaimed = (t: Task) => t.any_agent && !t.token_id;

/** The task's agent, or for "any available agent" a plain agent mark (no one's initials). */
function TaskAvatar({ t }: { t: Task }) {
  return unclaimed(t) ? <AnyAvatar /> : <AgentAvatar peer={agentPeer(t)} size="sm" />;
}
function AnyAvatar() {
  return <span className="peer peer-agent peer-any peer-sm" aria-hidden="true"><Icon name="sparkles" size={11} /></span>;
}

/** Queued and nobody who could take it is listening, so it will sit there until one starts. */
const isStuck = (t: Task) => !!t.unconfirmed || (t.status === 'queued' && t.delivery !== 'delivered' && !t.agent_listening);

function waitingText(t: Task): string {
  if (t.unconfirmed) return `${t.unconfirmed.agent_name} took this ${t.unconfirmed.times} times but never confirmed it`;
  if (unclaimed(t)) return 'Waiting: none of your agents is listening';
  return `Waiting: ${t.agent_name} isn't listening${t.agent_last_seen_at ? ` (seen ${timeAgo(t.agent_last_seen_at)})` : ''}`;
}

/** What the card says under the title: the agent's latest note, or where the task is. */
function cardLine(t: Task): string {
  if (t.unconfirmed) return waitingText(t);
  if (t.note && t.status !== 'queued') return t.note;
  if (t.status === 'queued') {
    if (t.delivery === 'delivered') return unclaimed(t) ? 'Sent to an agent…' : `Sent to ${t.agent_name}…`;
    if (isStuck(t)) return waitingText(t);
    return unclaimed(t) ? 'The first agent that listens takes it' : `Waiting for ${t.agent_name} to pick it up`;
  }
  if (t.status === 'working') return `${t.agent_name} is on it`;
  if (t.status === 'cancelled') return 'Cancelled';
  return '';
}

function StatusBadge({ status }: { status: Task['status'] }) {
  return <span className={`badge task-badge task-badge-${status}`}>{status === 'working' && <span className="task-live" aria-hidden="true" />}{STATUS_LABEL[status]}</span>;
}

function TaskCard({ task: t, active, onOpen }: { task: Task; active: boolean; onOpen: () => void }) {
  const line = cardLine(t);
  const stuck = isStuck(t);
  return (
    <button type="button" className={`task-card task-card-${t.status} ${stuck ? 'task-card-stuck' : ''} ${active ? 'active' : ''}`} onClick={onOpen}>
      <span className="task-card-top">
        <span className="task-card-title">{t.title}</span>
        {(t.status === 'failed' || t.status === 'cancelled') && <StatusBadge status={t.status} />}
      </span>
      {line && <span className={`task-card-note ${t.status === 'working' ? 'live' : ''} ${stuck ? 'stuck' : ''}`}>{stuck && <Icon name="alert" size={12} />}{line}</span>}
      <span className="task-card-foot">
        <TaskAvatar t={t} />
        <span className="task-card-agent">{t.agent_name}</span>
        {t.pages.length > 0 && <span className="task-card-pages" title={t.pages.map((p) => p.title || 'Untitled').join(', ')}><Icon name="file" size={12} />{t.pages.length}</span>}
        <span className="task-card-time">{timeAgo(t.updated_at)}</span>
      </span>
    </button>
  );
}

function MissingTask({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Task not found</h2>
        <p className="muted">It may have been deleted, or it finished more than 30 days ago.</p>
        <div className="row modal-buttons"><button type="button" className="primary" onClick={onClose}>Back to tasks</button></div>
      </div>
    </div>
  );
}

// ---- One task: what was asked, what the agent did, and a way to answer it.

function TaskSheet({ task: t, agents, onClose, onConnect }: { task: Task; agents: AgentChoice[]; onClose: () => void; onConnect: (tokenId: string | null) => void }) {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  // Reload the timeline whenever the task changes (an agent note arrives through the board's live updates).
  useEffect(() => {
    let live = true;
    loadTask(t.id).then((r) => { if (live) setEvents(r.events); }).catch(() => {});
    return () => { live = false; };
  }, [t.id, t.updated_at, t.status, t.pages.length]);
  useEffect(() => { logEnd.current?.scrollIntoView({ block: 'nearest' }); }, [events?.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const send = () => run(async () => { await messageTask(t.id, text.trim()); setText(''); });
  const finished = t.status === 'done' || t.status === 'failed' || t.status === 'cancelled';
  const replyLabel = t.status === 'needs_you' ? `Answer ${t.agent_name}` : finished ? `Reopen with a message` : `Message ${t.agent_name}`;

  return (
    <div className="task-sheet-backdrop" onClick={onClose}>
      <aside className="task-sheet" role="dialog" aria-label={t.title} onClick={(e) => e.stopPropagation()}>
        <header className="task-sheet-head">
          <StatusBadge status={t.status} />
          <span className="spacer" />
          <button type="button" className="ghost icon-btn" onClick={() => setEditing(true)} title="Edit task" aria-label="Edit task"><Icon name="pencil" /></button>
          <button type="button" className="ghost icon-btn" onClick={onClose} title="Close" aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="task-sheet-body">
          <h2 className="task-sheet-title">{t.title}</h2>
          <div className="task-meta">
            <span className="task-meta-agent">
              <TaskAvatar t={t} />
              <span>{t.agent_name}</span>
              {!finished && <span className={`task-online ${t.agent_listening ? 'on' : ''}`}>
                {unclaimed(t) ? (t.agent_listening ? 'an agent is listening' : 'none listening') : presenceText({ listening: t.agent_listening, last_seen_at: t.agent_last_seen_at, unconfirmed: !!t.unconfirmed })}
              </span>}
            </span>
            {t.page_id && <Link to={`/p/${t.page_id}`} className="chip task-page-chip"><Icon name="file" size={12} />{t.page_title || 'Untitled'}</Link>}
          </div>
          {isStuck(t) && <StuckBanner task={t} agents={agents} busy={busy} onConnect={onConnect}
            onReassign={(id) => run(() => patchTask(t.id, { token_id: id }))} />}
          {t.details && <p className="task-details">{t.details}</p>}
          {t.status === 'needs_you' && t.note && (
            <div className="task-question"><Icon name="alert" size={14} /><div><b>{t.agent_name} asks</b><p>{t.note}</p></div></div>
          )}
          {t.pages.filter((p) => p.id !== t.page_id).length > 0 && (
            <div className="task-touched">
              <h3>Pages it changed</h3>
              <div className="task-chips">
                {t.pages.filter((p) => p.id !== t.page_id).map((p) => <Link key={p.id} to={`/p/${p.id}`} className="chip task-page-chip"><Icon name="file" size={12} />{p.title || 'Untitled'}</Link>)}
              </div>
            </div>
          )}
          <h3 className="task-log-head">Activity</h3>
          {!events ? <p className="muted small">Loading…</p> : (
            <ol className="task-log">
              {events.map((e) => <EventRow key={e.id} e={e} agentName={t.agent_name} tokenId={t.token_id} />)}
              {t.status === 'working' && <li className="task-ev task-ev-live"><span className="task-live" aria-hidden="true" />{t.agent_name} is working…</li>}
            </ol>
          )}
          <div ref={logEnd} />
        </div>
        <footer className="task-sheet-foot">
          {t.token_id && t.status !== 'cancelled' && (
            <div className="task-reply">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={replyLabel}
                aria-label={replyLabel}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) { e.preventDefault(); void send(); } }} />
              <button type="button" className="primary icon-btn" disabled={busy || !text.trim()} onClick={send} title="Send" aria-label="Send"><Icon name="send" /></button>
            </div>
          )}
          {error && <p className="form-error small">{error}</p>}
          <div className="task-actions">
            {(t.status === 'queued' || t.status === 'working' || t.status === 'needs_you') && <>
              <button type="button" className="ghost" disabled={busy} onClick={() => run(() => patchTask(t.id, { status: 'done' }))}><Icon name="check" />Mark done</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => run(() => patchTask(t.id, { status: 'cancelled' }))}><Icon name="x" />Cancel</button>
            </>}
            {(t.status === 'failed' || t.status === 'cancelled') && (
              <button type="button" className="ghost" disabled={busy} onClick={() => run(() => patchTask(t.id, { status: 'queued' }))}><Icon name="refresh" />Try again</button>
            )}
            <span className="spacer" />
            <button type="button" className="ghost task-delete" disabled={busy} onClick={() => run(async () => {
              if (!confirm(`Delete "${t.title}"? Its activity goes too.`)) return;
              await deleteTask(t.id); onClose();
            })}><Icon name="trash" />Delete</button>
          </div>
        </footer>
        {editing && <EditTaskDialog task={t} agents={agents} onClose={() => setEditing(false)} />}
      </aside>
    </div>
  );
}

/** Web links in a timeline note (for example the Devin session that took the task) open in a new tab. */
function linkify(text: string): React.ReactNode {
  return text.split(/(https:\/\/[^\s<>"]+)/g).map((part, i) =>
    i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part);
}

/** A queued task nobody is listening for: get the agent listening, or give it to one that is. */
function StuckBanner({ task: t, agents, busy, onConnect, onReassign }: {
  task: Task; agents: AgentChoice[]; busy: boolean; onConnect: (tokenId: string | null) => void; onReassign: (tokenId: string) => void;
}) {
  const others = agents.filter((a) => a.id !== t.token_id).sort((a, b) => Number(b.listening) - Number(a.listening));
  const listeningOther = others.find((a) => a.listening);
  return (
    <div className="task-stuck" role="status">
      <Icon name="alert" size={14} />
      <div>
        <b>{waitingText(t)}.</b>
        <p>{t.unconfirmed
          ? `Its listening loop gets the task but doesn't confirm it (with update_task, or POST /api/tasks/${t.id}/ack), so it is offered again every 45 seconds. Restart the agent's listening, or give the task to another agent.`
          : "An agent only picks up tasks while it's listening."}{' '}
          {listeningOther ? `${listeningOther.name} is listening now.` : t.unconfirmed ? '' : 'Start one listening, or hand this to another agent.'}</p>
        <div className="task-stuck-actions">
          {listeningOther && <button type="button" className="primary" disabled={busy} onClick={() => onReassign(listeningOther.id)}>Give it to {listeningOther.name}</button>}
          <button type="button" className={listeningOther ? 'ghost' : 'primary'} onClick={() => onConnect(t.token_id ?? agents.find((a) => a.name === t.unconfirmed?.agent_name)?.id ?? null)}>
            {t.unconfirmed ? `How to restart ${t.unconfirmed.agent_name}` : unclaimed(t) ? 'Get an agent listening' : `Get ${t.agent_name} listening`}
          </button>
          {(others.length > 0 || !unclaimed(t)) && (
            <select className="task-stuck-pick" aria-label="Give it to another agent" value="" disabled={busy} onChange={(e) => e.target.value && onReassign(e.target.value)}>
              <option value="">Give it to…</option>
              {!unclaimed(t) && <option value={ANY_AGENT}>Any available agent</option>}
              {others.map((a) => <option key={a.id} value={a.id}>{a.name}{a.listening ? ' (listening)' : ''}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e, agentName, tokenId }: { e: TaskEvent; agentName: string; tokenId: string | null }) {
  const when = <time dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}>{timeAgo(e.created_at)}</time>;
  const agent = e.author_kind === 'agent';
  let what: React.ReactNode;
  if (e.kind === 'created') what = <>handed this to {agentName}</>;
  else if (e.kind === 'assigned') what = <>gave this to {e.text}</>;
  else if (e.kind === 'message') what = null;
  else if (e.kind === 'status') {
    what = agent
      ? e.status === 'working' ? 'started' : e.status === 'needs_you' ? 'needs you' : e.status === 'done' ? 'finished' : e.status === 'failed' ? 'could not finish' : STATUS_LABEL[e.status ?? 'working'].toLowerCase()
      : e.status === 'queued' ? 'sent it back to the agent' : e.status === 'done' ? 'marked it done' : e.status === 'cancelled' ? 'cancelled it' : STATUS_LABEL[e.status ?? 'queued'].toLowerCase();
  }
  return (
    <li className={`task-ev ${agent ? 'task-ev-agent' : 'task-ev-person'} ${e.kind === 'message' ? 'task-ev-message' : ''}`}>
      <span className="task-ev-who">
        {agent ? <AgentAvatar peer={{ id: tokenId ? `agent:${tokenId}` : undefined, name: e.author_name || agentName, color: '', kind: 'agent' }} size="sm" /> : <span className="task-ev-person-dot" aria-hidden="true" />}
        <b>{agent ? e.author_name || agentName : e.author_name}</b>{what && <span className="muted"> {what}</span>}
        <span className="task-ev-time">{when}</span>
      </span>
      {e.text && e.kind !== 'assigned' && <p className="task-ev-text">{linkify(e.text)}</p>}
    </li>
  );
}

// ---- New and edit

/** Who gets the task: any available agent, or one of yours, each with whether it is listening now. */
function AgentPicker({ agents, value, onChange }: { agents: AgentChoice[]; value: string; onChange: (id: string) => void }) {
  const anyListening = agents.some((a) => a.listening);
  const option = (id: string, avatar: React.ReactNode, name: string, status: string, on: boolean) => (
    <label key={id} className={`agent-option ${value === id ? 'on' : ''}`}>
      <input type="radio" name="task-agent" value={id} checked={value === id} onChange={() => onChange(id)} />
      {avatar}
      <span className="agent-option-name">{name}</span>
      <span className={`agent-option-status ${on ? 'on' : ''}`}>{status}</span>
    </label>
  );
  return (
    <div className="agent-picker" role="radiogroup" aria-label="Agent">
      {agents.length > 1 && option(ANY_AGENT, <AnyAvatar />, 'Any available agent', anyListening ? 'First one listening' : 'None listening', anyListening)}
      {agents.map((a) => option(a.id, <AgentAvatar peer={{ id: `agent:${a.id}`, name: a.name, color: '', kind: 'agent' }} size="sm" />, a.name,
        presenceText(a), a.listening))}
    </div>
  );
}

/** Shown when the chosen agent isn't listening: the task would wait, so say how to start it. */
function ListenWarning({ agents, value, onConnect }: { agents: AgentChoice[]; value: string; onConnect: (tokenId: string | null) => void }) {
  const any = value === ANY_AGENT;
  const chosen = agents.find((a) => a.id === value);
  if (any ? agents.some((a) => a.listening) : !chosen || chosen.listening) return null;
  return (
    <div className="task-warn" role="status">
      <Icon name="alert" size={14} />
      <p>
        {any ? 'None of your agents is listening' : `${chosen!.name} isn't listening`}, so the task will wait until {any ? 'one starts' : 'it starts'}.
        {' '}In Claude Code, run <code>{LISTEN_COMMAND}</code>.{' '}
        <button type="button" className="link" onClick={() => onConnect(any ? null : value)}>How to connect</button>
      </p>
    </div>
  );
}

const LAST_AGENT = 'lp.tasks.agent';

function NewTaskDialog({ agents, pageId, onClose, onConnect }: { agents: AgentChoice[]; pageId: string | null; onClose: (t?: Task) => void; onConnect: (tokenId: string | null) => void }) {
  const ws = useWorkspace();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [agent, setAgent] = useState(() => {
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_AGENT); } catch { /* storage blocked */ }
    // The last pick if it can take the task now, else an agent that is listening, else the last pick.
    const lastPick = last === ANY_AGENT && agents.length > 1 ? ANY_AGENT : agents.find((a) => a.id === last)?.id;
    const ready = lastPick === ANY_AGENT ? agents.some((a) => a.listening) : agents.find((a) => a.id === lastPick)?.listening;
    return (ready && lastPick) || agents.find((a) => a.listening)?.id || lastPick || agents[0]?.id || '';
  });
  const [page, setPage] = useState(pageId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = useMemo(() => [...(ws?.pages ?? [])].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)), [ws]);
  const chosen = agents.find((a) => a.id === agent);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const t = await createTask({ title: title.trim(), details: details.trim(), token_id: agent, page_id: page || null });
      try { localStorage.setItem(LAST_AGENT, agent); } catch { /* storage blocked */ }
      onClose(t);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <form className="modal task-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>New task</h2>
        {!agents.length ? <p className="muted">Make an agent token under <Link to="/">Agents</Link> on your home page first.</p> : <>
          <label className="field">What should it do?
            <input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Tighten the intro" />
          </label>
          <label className="field"><span>Details <span className="field-hint">optional</span></span>
            <textarea value={details} rows={4} maxLength={8000} onChange={(e) => setDetails(e.target.value)} placeholder="Anything it should know: tone, length, sources to use…" />
          </label>
          <label className="field"><span>Page <span className="field-hint">optional</span></span>
            <select value={page} onChange={(e) => setPage(e.target.value)}>
              <option value="">No page</option>
              {page && !pages.some((p) => p.id === page) && <option value={page}>This page</option>}
              {pages.map((p) => <option key={p.id} value={p.id}>{titleOf(p) || 'Untitled'}</option>)}
            </select>
          </label>
          <div className="field"><span>Agent</span>
            <AgentPicker agents={agents} value={agent} onChange={setAgent} />
          </div>
          <ListenWarning agents={agents} value={agent} onConnect={onConnect} />
        </>}
        {error && <p className="form-error">{error}</p>}
        <div className="row modal-buttons">
          <button type="button" className="ghost" onClick={() => onClose()}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !title.trim() || !agent}>{agent === ANY_AGENT ? 'Hand to any agent' : chosen ? `Hand to ${chosen.name}` : 'Hand out'}</button>
        </div>
      </form>
    </div>
  );
}

function EditTaskDialog({ task, agents, onClose }: { task: Task; agents: AgentChoice[]; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [details, setDetails] = useState(task.details);
  const current = task.any_agent && !task.token_id ? ANY_AGENT : task.token_id ?? '';
  const [agent, setAgent] = useState(current || agents[0]?.id || '');
  const [error, setError] = useState<string | null>(null);
  const known = agents.some((a) => a.id === task.token_id);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await patchTask(task.id, { title: title.trim(), details: details.trim(), ...(agent && agent !== current ? { token_id: agent } : {}) });
      onClose();
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal task-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Edit task</h2>
        <label className="field">Title<input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Details<textarea value={details} rows={4} maxLength={8000} onChange={(e) => setDetails(e.target.value)} /></label>
        <div className="field"><span>Agent</span>
          <AgentPicker agents={known || !task.token_id ? agents : [{ id: task.token_id, name: task.agent_name, online: false, listening: false, last_seen_at: null, last_listen_at: null }, ...agents]} value={agent} onChange={setAgent} />
        </div>
        {agent !== current && <p className="muted small">The task goes back in the queue for {agent === ANY_AGENT ? 'whichever agent is listening first' : 'the new agent'}.</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="row modal-buttons">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!title.trim()}>Save</button>
        </div>
      </form>
    </div>
  );
}

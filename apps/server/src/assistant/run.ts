// One assistant run: the person asks, the model works on the page through tools, and its
// edits stream in live. The assistant joins the page over this server's own collab socket,
// exactly like an external agent, with a short-lived token that carries the asking person's
// access, so page permissions are enforced the same way for both.
import { randomBytes } from 'node:crypto';
import { LiveAgent } from '@livepage/agent/client';
import { pageAsMarkdown, resolveTab } from '@livepage/schema';
import type { Db } from '../db.ts';
import { assistantTokens, type Principal } from '../auth.ts';
import { config } from '../config.ts';
import { runTurn, type Msg } from './providers.ts';
import { AiError, runtimeFor } from './settings.ts';
import { PageTools, TOOLS } from './tools.ts';

export type RunEvent =
  | { type: 'start'; model: string; provider: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; status: 'running' | 'done' | 'error'; note?: string }
  | { type: 'done'; text: string; changes: string[] }
  | { type: 'error'; message: string };

export type RunInput = {
  db: Db;
  user: Principal;
  pageId: string;
  tab?: string | null;
  prompt: string;
  /** Earlier turns in this chat (text only). */
  history?: { role: 'user' | 'assistant'; text: string }[];
  /** Text the person had selected on the page, if any. */
  selection?: string;
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
};

const MAX_STEPS = 16;
const MAX_CONTEXT = 60_000;
const running = new Set<string>();
let total = 0;
const MAX_TOTAL = Number(process.env.AI_MAX_CONCURRENT_RUNS ?? 20);

export const assistantName = (user: { name: string }) => `${(user.name || 'My').split(/\s+/)[0]}'s AI`;

const SYSTEM = (user: string) => `You are the AI assistant built into Livepage, a live, shared writing canvas. You are working with ${user} on one page, editing it live next to them: everything you write through tools appears on their screen as you write it, with your own named cursor.

How to work:
- Act on the page with tools instead of pasting content into chat. Chat replies are for short answers, questions, and a one or two sentence summary of what you changed.
- If the person only asks a question about the page, answer in chat and don't edit.
- Pick the lightest block that does the job: write_paragraph and add_heading for writing; insert_table for tabular data (never HTML tables); insert_mind_map for ideas and structure; insert_custom_ui only when it needs motion, drawing or interaction.
- To change existing writing, use replace_text with the exact current text. Keep the person's voice; don't rewrite more than asked.
- New blocks go at the end unless you pass after_text to place them after a specific passage.
- For custom UI: give css, html and js separately, keep it self-contained (CDN scripts are fine, network requests are blocked), and size it with initial_height.
- The page content below is a snapshot from when the person asked. Others (people or agents) may be editing too; call read_page if you need a fresh look.
- Write in the language of the page unless asked otherwise. Use plain text in paragraphs (no markdown syntax: headings, bullets and tables have their own tools).`;

export async function runAssistant(input: RunInput): Promise<void> {
  const { db, user, pageId, emit, signal } = input;
  const key = `${user.id}`;
  if (running.has(key)) throw new AiError(409, 'Your assistant is already working. Wait for it to finish, or stop it.');
  if (total >= MAX_TOTAL) throw new AiError(503, 'The server is busy with other assistant runs. Try again in a moment.');
  const rt = await runtimeFor(db, user.id);

  running.add(key);
  total++;
  const token = `lpa_${randomBytes(24).toString('base64url')}`;
  const name = assistantName(user);
  assistantTokens.set(token, { id: user.id, email: user.email, name, kind: 'agent' });
  let agent: LiveAgent | null = null;
  let tools: PageTools | null = null;
  try {
    agent = await LiveAgent.connect({ page: pageId, url: `ws://127.0.0.1:${config.port}/collab`, token, name, color: '#7048e8' });
    const tab = resolveTab(agent.doc, input.tab);
    agent.useTab(tab);
    tools = new PageTools(agent, tab);
    emit({ type: 'start', model: rt.model, provider: rt.provider.label });

    let snapshot = pageAsMarkdown(agent.doc);
    if (snapshot.length > MAX_CONTEXT) snapshot = `${snapshot.slice(0, MAX_CONTEXT)}\n\n(…truncated; call read_page for the rest)`;
    const sel = (input.selection ?? '').trim().slice(0, 8000);
    const messages: Msg[] = [];
    for (const h of (input.history ?? []).slice(-12)) {
      if (!h.text?.trim()) continue;
      messages.push(h.role === 'user' ? { role: 'user', text: h.text.slice(0, 8000) } : { role: 'assistant', text: h.text.slice(0, 8000), calls: [] });
    }
    messages.push({
      role: 'user',
      text: [
        `<page tab="${tab}">\n${snapshot || '(empty page)'}\n</page>`,
        sel ? `<selection>\n${sel}\n</selection>\nThe person has this text selected; "this" or "it" likely refers to it.` : '',
        input.prompt.trim().slice(0, 8000),
      ].filter(Boolean).join('\n\n'),
    });

    let finalText = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) break;
      const turn = await runTurn(rt, {
        system: SYSTEM(user.name || 'the person'),
        messages,
        tools: TOOLS,
        signal,
        handlers: {
          onText: (d) => emit({ type: 'text', delta: d }),
          onToolStart: (id, n) => emit({ type: 'tool', id, name: n, status: 'running' }),
          onToolArgs: (id, n, json) => { try { tools!.onArgs(id, n, json); } catch { /* best effort while streaming */ } },
        },
      });
      if (turn.text) finalText += (finalText ? '\n\n' : '') + turn.text;
      messages.push({ role: 'assistant', text: turn.text, calls: turn.calls, native: turn.native });
      if (turn.stop === 'refusal') { emit({ type: 'error', message: 'The model declined this request.' }); break; }
      if (!turn.calls.length) {
        if (turn.stop === 'length') emit({ type: 'error', message: 'The model hit its output limit before finishing.' });
        break;
      }
      const results: Extract<Msg, { role: 'tool' }>['results'] = [];
      for (const c of turn.calls) {
        if (signal.aborted) break;
        try {
          const out = await tools.run(c.id, c.name, c.args);
          results.push({ id: c.id, name: c.name, content: out });
          emit({ type: 'tool', id: c.id, name: c.name, status: 'done' });
        } catch (e) {
          const message = (e as Error).message;
          results.push({ id: c.id, name: c.name, content: `Error: ${message}`, isError: true });
          emit({ type: 'tool', id: c.id, name: c.name, status: 'error', note: message });
        }
      }
      if (signal.aborted) break;
      messages.push({ role: 'tool', results });
      if (step === MAX_STEPS - 1) emit({ type: 'error', message: `Stopped after ${MAX_STEPS} steps.` });
    }
    emit({ type: 'done', text: finalText, changes: tools.changes });
  } finally {
    tools?.settle();
    await agent?.disconnect().catch(() => {});
    assistantTokens.delete(token);
    running.delete(key);
    total--;
  }
}

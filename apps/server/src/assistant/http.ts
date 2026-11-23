// HTTP routes for the built-in assistant.
//   GET    /api/ai/settings          -> { available, settings, providers }   (never returns the key)
//   PUT    /api/ai/settings          { provider, model, baseUrl?, apiKey? }  (omit apiKey to keep the saved one)
//   DELETE /api/ai/settings
//   POST   /api/ai/models            { provider, baseUrl?, apiKey? } -> { models }  (also checks the key works)
//   POST   /api/pages/:page/assistant { prompt, tab?, selection? } -> 202; the answer streams into the
//          page's Ask AI chat (GET /api/pages/:page/chat, see chats.ts)
// People only (session cookie); agent tokens can't read or use someone's AI key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.ts';
import type { Principal } from '../auth.ts';
import { readJson, send } from '../agent-api.ts';
import { listModels } from './providers.ts';
import { runAssistant, type RunEvent } from './run.ts';
import { changeTurn, historyOf, readChat, startExchange, trackRun } from '../chats.ts';
import { AiError, aiAvailable, deleteSettings, getSettings, PROVIDERS, resolveInput, saveSettings } from './settings.ts';

const fail = (res: ServerResponse, e: unknown) => {
  if (e instanceof AiError) return send(res, e.status, { error: e.message });
  throw e;
};

export async function handleAiApi(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, path: string): Promise<void> {
  if (who.kind !== 'human' || who.superAgent) return send(res, 403, { error: 'Only people can manage their AI assistant.' });
  try {
    if (path === '/api/ai/settings') {
      if (req.method === 'GET') {
        const providers = PROVIDERS.map(({ id, label, defaultModel, keyRequired, keyUrl, baseUrl }) => ({
          id, label, defaultModel, keyRequired, keyUrl, baseUrl: id === 'custom' ? baseUrl : undefined,
        }));
        return send(res, 200, { available: aiAvailable(), settings: await getSettings(db, who.id), providers });
      }
      if (req.method === 'PUT') return send(res, 200, { settings: await saveSettings(db, who.id, await readJson(req)) });
      if (req.method === 'DELETE') { await deleteSettings(db, who.id); return send(res, 200, { ok: true }); }
    }
    if (path === '/api/ai/models' && req.method === 'POST') {
      const rt = await resolveInput(db, who.id, await readJson(req));
      return send(res, 200, { models: await listModels(rt) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return fail(res, e);
  }
}

export async function handleAssistantRun(req: IncomingMessage, res: ServerResponse, db: Db, who: Principal, pageId: string, canEdit: boolean) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (who.kind !== 'human' || who.superAgent) return send(res, 403, { error: 'The built-in assistant is for people. Agents use MCP or the HTTP API.' });
  if (!canEdit) return send(res, 403, { error: 'You can view this page but not edit it, so the assistant can’t either.' });
  const b = await readJson(req);
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) return send(res, 400, { error: 'Ask something first.' });
  if (!(await getSettings(db, who.id))) return send(res, 412, { error: 'Set up the assistant first: pick a provider and add your API key.' });
  const chat = await readChat(db, who.id, pageId);
  if (chat.running) return send(res, 409, { error: 'Still answering your last question. Wait for it, or stop it.' });
  const selection = typeof b.selection === 'string' ? b.selection.slice(0, 8000) : '';

  // The answer belongs to the chat, not to this request: it keeps going if the tab closes or the
  // phone sleeps, and every device with the panel open follows it (see chats.ts). Stop ends it.
  const { answerId } = await startExchange(db, who.id, pageId, { prompt, selection }, { kind: 'builtin' });
  const abort = new AbortController();
  const untrack = trackRun(who.id, pageId, abort);
  let afterTool = false; // a new paragraph when the model talks again after using tools
  const emit = (e: RunEvent) => {
    if (e.type === 'start') void changeTurn(db, who.id, pageId, answerId, (t) => { t.model = e.model; });
    else if (e.type === 'text') {
      const sep = afterTool ? '\n\n' : '';
      afterTool = false;
      void changeTurn(db, who.id, pageId, answerId, (t) => { t.text = t.text ? t.text + sep + e.delta : e.delta; });
    } else if (e.type === 'tool') {
      afterTool = true;
      void changeTurn(db, who.id, pageId, answerId, (t) => {
        const steps = (t.steps ??= []);
        const step = { id: e.id, name: e.name, status: e.status, note: e.note };
        const at = steps.findIndex((s) => s.id === e.id);
        if (at >= 0) steps[at] = step; else steps.push(step);
      });
    } else if (e.type === 'error') void changeTurn(db, who.id, pageId, answerId, (t) => { t.error = e.message; });
  };
  send(res, 202, { ok: true, turn: answerId });

  void (async () => {
    let error: string | undefined;
    try {
      await runAssistant({
        db, user: who, pageId, prompt, history: historyOf(chat.turns), selection,
        tab: typeof b.tab === 'string' ? b.tab : null,
        signal: abort.signal, emit,
      });
    } catch (e) {
      const err = e as Error;
      if (abort.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') error = 'Stopped.';
      else {
        if (!(e instanceof AiError)) console.error('[assistant]', e);
        error = e instanceof AiError ? e.message : `The assistant failed: ${err.message}`;
      }
    } finally {
      untrack();
      await changeTurn(db, who.id, pageId, answerId, (t) => {
        t.running = false;
        for (const s of t.steps ?? []) if (s.status === 'running') s.status = error ? 'error' : 'done';
        if (error) t.error = error;
      }, true).catch((e) => console.warn('[assistant] could not save the answer:', (e as Error).message));
    }
  })();
}

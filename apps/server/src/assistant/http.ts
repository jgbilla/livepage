// HTTP routes for the built-in assistant.
//   GET    /api/ai/settings          -> { available, settings, providers }   (never returns the key)
//   PUT    /api/ai/settings          { provider, model, baseUrl?, apiKey? }  (omit apiKey to keep the saved one)
//   DELETE /api/ai/settings
//   POST   /api/ai/models            { provider, baseUrl?, apiKey? } -> { models }  (also checks the key works)
//   POST   /api/pages/:page/assistant { prompt, tab?, history?, selection? } -> text/event-stream of RunEvent
// People only (session cookie); agent tokens can't read or use someone's AI key.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.ts';
import type { Principal } from '../auth.ts';
import { readJson, send } from '../agent-api.ts';
import { listModels } from './providers.ts';
import { runAssistant, type RunEvent } from './run.ts';
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
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt.trim()) return send(res, 400, { error: 'Ask something first.' });
  const history = Array.isArray(b.history)
    ? b.history.filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
    : [];

  const abort = new AbortController();
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  };
  const emit = (e: RunEvent) => { open(); if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  // The person pressed Stop or closed the tab.
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  const ping = setInterval(() => { if (opened && !res.writableEnded) res.write(': ping\n\n'); }, 15_000);

  try {
    await runAssistant({
      db, user: who, pageId, prompt, history,
      tab: typeof b.tab === 'string' ? b.tab : null,
      selection: typeof b.selection === 'string' ? b.selection : '',
      signal: abort.signal, emit,
    });
  } catch (e) {
    const err = e as Error;
    if (abort.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') {
      // stopped: nothing to report
    } else if (!opened) {
      if (e instanceof AiError) return send(res, e.status, { error: e.message });
      console.error('[assistant]', e);
      return send(res, 500, { error: `The assistant failed: ${err.message}` });
    } else {
      if (!(e instanceof AiError)) console.error('[assistant]', e);
      emit({ type: 'error', message: err.message });
    }
  } finally {
    clearInterval(ping);
    if (opened && !res.writableEnded) res.end();
  }
}

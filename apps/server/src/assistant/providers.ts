// Model adapters. Two wire protocols cover every provider:
//  - Anthropic Messages (official SDK) for Claude
//  - OpenAI-style chat completions over fetch for OpenAI, Gemini (its OpenAI-compatible endpoint),
//    OpenRouter, and anything OpenAI-compatible (Ollama, LM Studio, vLLM, Groq, Together…)
// Both stream: text deltas go to the chat panel, and tool-call arguments stream as partial JSON
// so the page can show a paragraph or a custom UI block while the model is still writing it.
import Anthropic from '@anthropic-ai/sdk';
import type { AiRuntime } from './settings.ts';
import { AiError } from './settings.ts';

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** Provider-neutral conversation. `native` keeps a provider's own assistant content (e.g. Claude's thinking blocks) to send back unchanged. */
export type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[]; native?: unknown }
  | { role: 'tool'; results: { id: string; name: string; content: string; isError?: boolean }[] };

export type StreamHandlers = {
  onText: (delta: string) => void;
  onToolStart: (id: string, name: string) => void;
  /** The tool's argument JSON so far (may be incomplete). */
  onToolArgs: (id: string, name: string, jsonSoFar: string) => void;
};

export type TurnResult = { text: string; calls: ToolCall[]; native?: unknown; stop: 'end' | 'tool' | 'length' | 'refusal' };

export type TurnInput = { system: string; messages: Msg[]; tools: ToolDef[]; signal: AbortSignal; handlers: StreamHandlers };

export function runTurn(rt: AiRuntime, input: TurnInput): Promise<TurnResult> {
  return rt.provider.api === 'anthropic' ? anthropicTurn(rt, input) : openaiTurn(rt, input);
}

function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return { __invalid_json: json.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Anthropic

// Models that accept server-side refusal fallbacks (re-run on another model inside the same call).
const FALLBACK_MODELS = /^claude-(fable-5|opus-5|sonnet-5-5)/;

async function anthropicTurn(rt: AiRuntime, { system, messages, tools, signal, handlers }: TurnInput): Promise<TurnResult> {
  const client = new Anthropic({ apiKey: rt.apiKey, baseURL: rt.baseUrl, maxRetries: 2 });
  const params: Record<string, unknown> = {
    model: rt.model,
    max_tokens: 32000,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true })),
    messages: toAnthropic(messages),
  };
  if (FALLBACK_MODELS.test(rt.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params as any, { signal });
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  try {
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
        handlers.onToolStart(ev.content_block.id, ev.content_block.name);
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') handlers.onText(ev.delta.text);
        else if (ev.delta.type === 'input_json_delta') {
          const b = blocks.get(ev.index);
          if (b) { b.json += ev.delta.partial_json; handlers.onToolArgs(b.id, b.name, b.json); }
        }
      }
    }
  } catch (e) {
    throw anthropicError(e);
  }
  const msg: any = await stream.finalMessage().catch((e: unknown) => { throw anthropicError(e); });
  const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  const calls: ToolCall[] = msg.content
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => {
      // With eager streaming the API passes input through unvalidated: re-parse our own copy when it's not an object.
      const streamed = [...blocks.values()].find((x) => x.id === b.id);
      const args = b.input && typeof b.input === 'object' ? b.input : parseArgs(streamed?.json ?? '');
      return { id: b.id, name: b.name, args };
    });
  const stop = msg.stop_reason === 'refusal' ? 'refusal' : msg.stop_reason === 'max_tokens' ? 'length' : calls.length ? 'tool' : 'end';
  return { text, calls, native: msg.content, stop };
}

function anthropicError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new AiError(401, 'Anthropic rejected the API key. Check it in your assistant settings.');
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError(403, `Anthropic: ${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return new AiError(404, 'Anthropic does not know that model. Pick another in your assistant settings.');
  if (e instanceof Anthropic.RateLimitError) return new AiError(429, 'Anthropic rate limit reached. Try again in a minute.');
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.APIError) return new AiError(502, `Anthropic error${e.status ? ` ${e.status}` : ''}: ${e.message}`);
  return e as Error;
}

function toAnthropic(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
      if (Array.isArray(m.native)) return { role: 'assistant', content: m.native };
      const content: unknown[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      return { role: 'assistant', content: content.length ? content : m.text };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })),
    };
  });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions

async function openaiTurn(rt: AiRuntime, { system, messages, tools, signal, handlers }: TurnInput): Promise<TurnResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (rt.apiKey) headers.authorization = `Bearer ${rt.apiKey}`;
  if (rt.provider.id === 'openrouter') { headers['x-title'] = 'Livepage'; }
  const res = await fetch(`${rt.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    // The endpoint was checked to be public. A redirect could point anywhere (an internal
    // address, or another host that would receive the API key), so it is an error.
    redirect: 'error',
    body: JSON.stringify({
      model: rt.model,
      stream: true,
      messages: [{ role: 'system', content: system }, ...toOpenAI(messages)],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
  }).catch((e) => {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AiError(502, `Could not reach ${rt.baseUrl} (${(e as Error).message}).`);
  });
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 400);
    const label = rt.provider.label;
    if (res.status === 401 || res.status === 403) throw new AiError(401, `${label} rejected the API key (${res.status}). Check it in your assistant settings.`);
    if (res.status === 404) throw new AiError(404, `${label} returned 404: check the model name and endpoint. ${body}`);
    if (res.status === 429) throw new AiError(429, `${label} rate limit or quota reached. ${body}`);
    throw new AiError(502, `${label} error ${res.status}: ${body}`);
  }

  let text = '';
  let finish = '';
  const calls = new Map<number, { id: string; name: string; json: string; started: boolean }>();
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) throw new AiError(502, `${rt.provider.label}: ${ev.error.message ?? JSON.stringify(ev.error)}`);
      const choice = ev.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string' && d.content) { text += d.content; handlers.onText(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.size;
        let c = calls.get(i);
        if (!c) calls.set(i, (c = { id: '', name: '', json: '', started: false }));
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (!c.id) c.id = `call_${i}_${Date.now().toString(36)}`; // some providers (Gemini) omit ids
        if (c.name && !c.started) { c.started = true; handlers.onToolStart(c.id, c.name); }
        if (tc.function?.arguments) {
          c.json += tc.function.arguments;
          if (c.started) handlers.onToolArgs(c.id, c.name, c.json);
        }
      }
    }
  }
  const list = [...calls.values()].filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.json) }));
  const stop = finish === 'length' ? 'length' : finish === 'content_filter' ? 'refusal' : list.length ? 'tool' : 'end';
  return { text, calls: list, stop };
}

function toOpenAI(messages: Msg[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.calls.length ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      });
    } else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model lists, for the settings picker.

export async function listModels(rt: AiRuntime): Promise<string[]> {
  if (rt.provider.api === 'anthropic') {
    const client = new Anthropic({ apiKey: rt.apiKey, baseURL: rt.baseUrl, maxRetries: 1 });
    try {
      const ids: string[] = [];
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
      return ids;
    } catch (e) { throw anthropicError(e); }
  }
  const res = await fetch(`${rt.baseUrl}/models`, { headers: rt.apiKey ? { authorization: `Bearer ${rt.apiKey}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    .catch((e) => { throw new AiError(502, `Could not reach ${rt.baseUrl} (${(e as Error).message}).`); });
  if (res.status === 401 || res.status === 403) throw new AiError(401, `${rt.provider.label} rejected the API key.`);
  if (!res.ok) throw new AiError(502, `${rt.provider.label} error ${res.status} listing models.`);
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[]; models?: { name?: string; id?: string }[] };
  const ids = (body.data ?? body.models ?? []).map((m: any) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  return ids.sort().slice(0, 500);
}

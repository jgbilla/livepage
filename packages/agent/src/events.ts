// Follow an agent's Livepage event stream (GET /api/agent-events, Server-Sent Events) with plain fetch,
// reconnecting with backoff. Used by the local MCP server's channel mode (mcp.ts); usable from any script:
//
//   import { followAgentEvents } from '@livepage/agent/events';
//   const stop = followAgentEvents({ baseUrl: 'https://<your app>', token: 'lp_...', onEvent: (e) => console.log(e.type, e.text) });

export type LivepageEvent = { id?: string; type: string; text: string; data?: Record<string, unknown>; at?: string };

export function followAgentEvents(opts: {
  baseUrl: string; token: string;
  onEvent: (e: LivepageEvent) => void;
  onError?: (message: string) => void;
}): () => void {
  const ctl = new AbortController();
  let delay = 1000;
  let lastId: string | undefined;

  const run = async () => {
    while (!ctl.signal.aborted) {
      try {
        const res = await fetch(`${opts.baseUrl}/api/agent-events`, {
          headers: { authorization: `Bearer ${opts.token}`, accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) },
          signal: ctl.signal,
        });
        if (res.status === 401 || res.status === 403) { opts.onError?.(`the token was refused (${res.status}); not retrying`); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const ev = parse(raw);
            if (!ev) continue;
            if (ev.id) lastId = ev.id;
            try {
              const body = JSON.parse(ev.data);
              opts.onEvent({ type: ev.event, text: body.text ?? '', data: ev.event === 'ready' ? body : body.data, id: ev.id, at: body.at });
            } catch { /* not JSON: ignore */ }
          }
        }
        throw new Error('stream ended');
      } catch (e) {
        if (ctl.signal.aborted) return;
        opts.onError?.(`${(e as Error).message}; reconnecting in ${Math.round(delay / 1000)}s`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 60_000);
      }
    }
  };
  void run();
  return () => ctl.abort();
}

function parse(raw: string): { event: string; data: string; id?: string } | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  return data.length ? { event, data: data.join('\n'), id } : null;
}

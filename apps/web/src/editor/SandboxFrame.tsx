import { useEffect, useRef, useState } from 'react';
import { appConfig } from '../config';

// Renders untrusted HTML/JS. Security model (SPEC.md "HTML blocks"):
//  - the iframe loads from the sandbox URL (from /api/config), a different origin from the app
//  - sandbox="allow-scripts" WITHOUT allow-same-origin gives it an opaque origin:
//    no cookies, no storage, no access to the parent page or the user's session
//  - the sandbox server sends a strict CSP (no fetch/XHR/WebSocket, CDN scripts only)
//  - we only trust messages whose source is this iframe, and the host validates
//    anything the block sends (see onAction in HtmlBlock.tsx)
//
// While `streaming`, one iframe stays mounted and receives script-free previews
// as the code grows. When the block is ready, a fresh iframe runs the final code.
type Props = {
  code: string;
  streaming: boolean;
  initialHeight: number;
  onAction?: (action: unknown, values: unknown) => void;
};

export function SandboxFrame({ code, streaming, initialHeight, onAction }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(code);
  const ready = useRef(false);
  const latest = useRef({ code, streaming, onAction });
  latest.current = { code, streaming, onAction };

  // Final mode: debounce re-renders while someone is typing code.
  // Right after streaming ends, render at once (no flash of stale code).
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (streaming) { wasStreaming.current = true; return; }
    if (wasStreaming.current) { wasStreaming.current = false; setRendered(code); return; }
    const t = setTimeout(() => setRendered(code), 400);
    return () => clearTimeout(t);
  }, [code, streaming]);

  // Streaming mode: push previews into the live iframe (throttled by React batching).
  useEffect(() => {
    if (streaming && ready.current) {
      ref.current?.contentWindow?.postMessage({ type: 'livepage:preview', code }, '*');
    }
  }, [code, streaming]);

  const frameKey = streaming ? 'streaming' : `final:${rendered}`;

  useEffect(() => {
    setError(null);
    ready.current = false;
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow || typeof e.data !== 'object' || !e.data) return;
      const d = e.data;
      if (d.type === 'livepage:ready') {
        ready.current = true;
        const { streaming: s, code: c } = latest.current;
        frame.contentWindow!.postMessage(s ? { type: 'livepage:preview', code: c } : { type: 'livepage:render', code: rendered }, '*');
      }
      if (d.type === 'livepage:height') {
        const h = Number(d.height) || 0;
        // While streaming, never shrink below the space the agent reserved.
        setHeight(Math.max(latest.current.streaming ? initialHeight : 40, Math.min(2000, h)));
      }
      if (d.type === 'livepage:error') setError(String(d.message).slice(0, 300));
      if (d.type === 'livepage:action') latest.current.onAction?.(d.action, d.values);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameKey, rendered, initialHeight]);

  return (
    <div className="sandbox">
      <iframe
        key={frameKey}
        ref={ref}
        src={`${appConfig().sandboxUrl}/runner.html`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        title="HTML block"
        style={{ height }}
      />
      {error && <div className="sandbox-error">⚠ {error}</div>}
    </div>
  );
}

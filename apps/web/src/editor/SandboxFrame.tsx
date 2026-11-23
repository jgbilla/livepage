import { useEffect, useRef, useState } from 'react';
import { SANDBOX_URL } from '../config';

// Renders untrusted HTML/JS. Security model (SPEC.md "HTML blocks"):
//  - the iframe loads from SANDBOX_URL, a different origin from the app
//  - sandbox="allow-scripts" WITHOUT allow-same-origin gives it an opaque origin:
//    no cookies, no storage, no access to the parent page or the user's session
//  - the sandbox server sends a strict CSP (no fetch/XHR/WebSocket, CDN scripts only)
//  - code arrives by postMessage; we only trust messages whose source is this iframe
export function SandboxFrame({ code }: { code: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(code);

  // Debounce re-renders while someone (or an agent) is typing code.
  useEffect(() => {
    const t = setTimeout(() => setRendered(code), 400);
    return () => clearTimeout(t);
  }, [code]);

  useEffect(() => {
    setError(null);
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      if (!frame || e.source !== frame.contentWindow || typeof e.data !== 'object' || !e.data) return;
      if (e.data.type === 'livepage:ready') frame.contentWindow!.postMessage({ type: 'livepage:render', code: rendered }, '*');
      if (e.data.type === 'livepage:height') setHeight(Math.max(40, Math.min(2000, Number(e.data.height) || 0)));
      if (e.data.type === 'livepage:error') setError(String(e.data.message).slice(0, 300));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [rendered]);

  return (
    <div className="sandbox">
      <iframe
        key={rendered /* fresh document for every version of the code */}
        ref={ref}
        src={`${SANDBOX_URL}/runner.html`}
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

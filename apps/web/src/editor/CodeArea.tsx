import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

// A textarea bound to a Y.Text, so several people and agents can edit block code at once.
// (A CodeMirror 6 + y-codemirror.next binding is the planned upgrade: SPEC.md "Roadmap".)
export function CodeArea({ text }: { text: Y.Text }) {
  const [value, setValue] = useState(() => text.toString());
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const update = () => setValue(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [text]);

  const onChange = (next: string) => {
    const prev = text.toString();
    // Apply the minimal diff (common prefix/suffix) so concurrent edits merge.
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length, endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) { endPrev--; endNext--; }
    text.doc!.transact(() => {
      if (endPrev > start) text.delete(start, endPrev - start);
      if (endNext > start) text.insert(start, next.slice(start, endNext));
    });
  };

  return (
    <textarea
      ref={ref}
      className="code-area"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={Math.min(24, Math.max(6, value.split('\n').length + 1))}
    />
  );
}

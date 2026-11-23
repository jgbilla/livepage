// Code blocks: a panel with syntax highlighting (lowlight), a language picker and a copy button.
// Same node name and `language` attribute as TipTap's built-in code block, so existing pages
// (and code blocks written by agents) keep working.
import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Record<string, { label: string; grammar: Parameters<ReturnType<typeof createLowlight>['register']>[1] }> = {
  bash: { label: 'Shell', grammar: bash },
  javascript: { label: 'JavaScript', grammar: javascript },
  typescript: { label: 'TypeScript', grammar: typescript },
  json: { label: 'JSON', grammar: json },
  xml: { label: 'HTML / XML', grammar: xml },
  css: { label: 'CSS', grammar: css },
  python: { label: 'Python', grammar: python },
  sql: { label: 'SQL', grammar: sql },
  yaml: { label: 'YAML', grammar: yaml },
  ini: { label: 'TOML / INI', grammar: ini },
  markdown: { label: 'Markdown', grammar: markdown },
  go: { label: 'Go', grammar: go },
  rust: { label: 'Rust', grammar: rust },
};

const lowlight = createLowlight();
for (const [name, { grammar }] of Object.entries(LANGUAGES)) lowlight.register(name, grammar);
lowlight.registerAlias({ bash: ['sh', 'shell', 'zsh'], javascript: ['js', 'jsx'], typescript: ['ts', 'tsx'], xml: ['html', 'svg'], ini: ['toml'], yaml: ['yml'] });

function CodeBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language: string | null = node.attrs.language;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: nothing to do */ }
  };
  return (
    <NodeViewWrapper className="code-block">
      <div className="code-block-bar" contentEditable={false}>
        {editor.isEditable ? (
          <select
            aria-label="Code language"
            value={language && LANGUAGES[language] ? language : ''}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
          >
            <option value="">Auto</option>
            {Object.entries(LANGUAGES).map(([id, l]) => <option key={id} value={id}>{l.label}</option>)}
          </select>
        ) : (
          <span className="code-block-lang">{(language && LANGUAGES[language]?.label) || language || 'Code'}</span>
        )}
        <button type="button" className="code-block-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre><NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} /></pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
}).configure({ lowlight, defaultLanguage: null });

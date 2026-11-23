// How other people's and agents' carets look in the editor (DESIGN.md, "People and agents").
// People: a solid line in their own hue with a name pill. Agents: a violet line that breathes while
// it types, with a gradient pill that starts with a spark. Styles live in styles.css.
import { agentShade } from '../agents';

const SPARK = 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z';
const validColor = (c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

export function renderCaret(user: Record<string, unknown>): HTMLElement {
  const agent = user.kind === 'agent';
  const color = validColor(user.color) ? (user.color as string) : '#6e56cf';
  const caret = document.createElement('span');
  caret.className = `collaboration-carets__caret${agent ? ` is-agent agent-shade-${agentShade(user)}` : ''}`;
  caret.style.borderColor = color;
  const label = document.createElement('div');
  label.className = 'collaboration-carets__label';
  label.style.backgroundColor = color;
  if (agent) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', SPARK);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    label.appendChild(svg);
  }
  label.appendChild(document.createTextNode(String(user.name ?? (agent ? 'Agent' : 'Someone'))));
  caret.appendChild(label);
  return caret;
}

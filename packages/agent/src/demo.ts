// The demo: sign in at http://localhost:5173, create a page, open it in two browsers, then run
//   pnpm agent:demo <page id from the URL, like p_AbC123...>
// Locally the shared dev token works. Against a hosted server, set LIVEPAGE_URL and an agent token:
//   LIVEPAGE_URL=wss://your-app.onrender.com/collab AGENT_TOKEN=lp_... pnpm agent:demo p_...
// An agent joins the page and shows every kind of block living on one page:
//   text it types with its own caret, a native table, a native mind map, and a custom UI
//   block that streams in (height, placeholders, CSS, HTML, then JS), and a second tab.
// The custom UI has a slider that runs locally and an "Add a planet" button that goes
// back to the agent through the host bridge. The agent listens and answers by updating the block.
import { htmlSections } from '@livepage/schema';
import { LiveAgent } from './client.ts';

const page = process.argv[2];
if (!page) {
  console.error('usage: pnpm agent:demo <page id> [listen seconds]');
  process.exit(1);
}
const listenSeconds = Number(process.argv[3] ?? 60);
const agent = await LiveAgent.connect({ page, name: 'Claude (demo agent)' });
console.log(`[agent] joined page "${page}"`);

await agent.typeParagraph('Hi! I am an agent on this page. Text, tables, mind maps and custom UI all live together here.');

// 1. Native component: plain data goes in a real table, which everyone can edit.
agent.addTable([
  ['Planet', 'Distance from Sun', 'Orbit'],
  ['Mercury', '0.39 AU', '88 days'],
  ['Venus', '0.72 AU', '225 days'],
  ['Earth', '1 AU', '365 days'],
]);

// 2. Native mind map: structure goes in a mind map, also editable by everyone.
agent.addMindMap(
  {
    text: 'Solar system',
    children: [
      { text: 'Inner planets', children: [{ text: 'Mercury' }, { text: 'Venus' }, { text: 'Earth' }, { text: 'Mars' }] },
      { text: 'Outer planets', children: [{ text: 'Jupiter' }, { text: 'Saturn' }] },
      { text: 'Sun' },
    ],
  },
  'Mind map',
);

// 3. Custom UI: only when it needs motion or interaction. Streamed in a fixed order.
const ALL = [
  { name: 'Mercury', color: '#adb5bd', r: 60, s: 3 },
  { name: 'Venus', color: '#ffd8a8', r: 90, s: 5 },
  { name: 'Earth', color: '#74c0fc', r: 120, s: 7 },
  { name: 'Mars', color: '#ff8787', r: 150, s: 10 },
  { name: 'Jupiter', color: '#e599f7', r: 185, s: 14 },
];

function orbitUI(count: number) {
  return {
    title: 'Orbit explorer',
    initialHeight: 380,
    placeholders: ['Sketching the orbits…', 'Placing the sun…', 'Wiring up the controls…'],
    css: `
body { background: #0b1020; color: #fff; font-family: system-ui; }
.stage { position: relative; height: 380px; display: grid; place-items: center; overflow: hidden; }
.sun { width: 40px; height: 40px; border-radius: 50%; background: radial-gradient(#ffd43b, #f76707); box-shadow: 0 0 40px #f76707; position: absolute; }
.orbit { position: absolute; border: 1px dashed #ffffff33; border-radius: 50%; animation: spin linear infinite; animation-duration: calc(var(--s) * 1s / var(--speed, 1)); }
.planet { position: absolute; top: -7px; left: 50%; width: 14px; height: 14px; border-radius: 50%; }
.controls { position: absolute; top: 10px; left: 12px; right: 12px; display: flex; gap: 12px; align-items: center; font-size: 13px; }
.controls button { margin-left: auto; background: #7048e8; color: #fff; border: 0; border-radius: 99px; padding: 6px 12px; cursor: pointer; }
@keyframes spin { to { transform: rotate(360deg); } }`,
    html: `
<div class="stage" id="stage">
  <div class="controls">
    <label>Speed <input id="speed" type="range" min="0.2" max="4" step="0.1" value="1"></label>
    <button id="ask">Ask the agent to add a planet</button>
  </div>
  <div class="sun"></div>
</div>`,
    js: `
const PLANETS = ${JSON.stringify(ALL.slice(0, count))};
const stage = document.getElementById('stage');
for (const p of PLANETS) {
  const o = document.createElement('div');
  o.className = 'orbit';
  o.style.cssText = 'width:' + p.r * 2 + 'px;height:' + p.r * 2 + 'px;--s:' + p.s;
  o.innerHTML = '<div class="planet" title="' + p.name + '" style="background:' + p.color + '"></div>';
  stage.appendChild(o);
}
// Runs locally in the sandbox: no agent round trip.
document.getElementById('speed').oninput = (e) => stage.style.setProperty('--speed', e.target.value);
// Goes back to the agent through the host bridge.
document.getElementById('ask').onclick = () => livepage.send('add_planet', { current: PLANETS.length });`,
  };
}

let count = 3;
const blockId = await agent.streamUI(orbitUI(count));
await agent.typeParagraph('Drag the speed slider (that runs in the block). The button asks me to change the block.');
// 4. Tabs: the agent puts its sources in a second tab, which appears at the top of the page.
agent.addTab('Sources');
agent.useTab('Sources');
agent.addHeading('Sources');
await agent.typeParagraph('NASA Solar System Exploration, planetary fact sheets. (A second tab, written by the agent.)', 80);
agent.useTab(null);

console.log(`[agent] streamed custom UI ${blockId}; listening for block actions for ${listenSeconds}s`);

// 5. Host bridge: answer actions from the block's controls.
const stop = agent.onAction(async (a) => {
  console.log(`[agent] action from ${a.by}: ${a.action} ${JSON.stringify(a.values)}`);
  if (a.action !== 'add_planet' || a.blockId !== blockId) return agent.resolveAction(a.id, 'I only know how to add planets here.');
  if (count >= ALL.length) return agent.resolveAction(a.id, 'That is every planet I have for now.');
  count++;
  const ui = orbitUI(count);
  agent.updateHtml(blockId, htmlSections(ui).join(''));
  agent.resolveAction(a.id, `added ${ALL[count - 1].name}`);
});

await new Promise((r) => setTimeout(r, listenSeconds * 1000));
stop();
await agent.disconnect();
process.exit(0);

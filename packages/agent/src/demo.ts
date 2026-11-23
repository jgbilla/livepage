// The first demo: open http://localhost:5173/?page=demo in two browsers, then run
//   pnpm agent:demo
// An agent joins the page, writes a paragraph with its own caret, and drops in an animated HTML block.
import { LiveAgent } from './client.ts';

const page = process.argv[2] ?? 'demo';
const agent = await LiveAgent.connect({ page, name: 'Claude (demo agent)' });
console.log(`[agent] joined page "${page}"`);

await agent.typeParagraph(
  'Hi! I am an agent working on this page with you. Here is a little animation to show what an HTML block can do:',
);

const ORBIT = `<div class="stage">
  <div class="sun"></div>
  <div class="orbit o1"><div class="planet p1"></div></div>
  <div class="orbit o2"><div class="planet p2"></div></div>
  <div class="orbit o3"><div class="planet p3"></div></div>
  <p class="caption">Live HTML block, written by an agent</p>
</div>
<style>
  body { background: #0b1020; }
  .stage { position: relative; height: 320px; display: grid; place-items: center; overflow: hidden; font-family: system-ui; }
  .sun { width: 48px; height: 48px; border-radius: 50%; background: radial-gradient(#ffd43b, #f76707);
         box-shadow: 0 0 40px #f76707; position: absolute; }
  .orbit { position: absolute; border: 1px dashed #ffffff33; border-radius: 50%; animation: spin linear infinite; }
  .o1 { width: 120px; height: 120px; animation-duration: 4s; }
  .o2 { width: 200px; height: 200px; animation-duration: 7s; }
  .o3 { width: 280px; height: 280px; animation-duration: 12s; }
  .planet { position: absolute; top: -8px; left: 50%; width: 16px; height: 16px; border-radius: 50%; }
  .p1 { background: #74c0fc; } .p2 { background: #8ce99a; } .p3 { background: #e599f7; }
  .caption { position: absolute; bottom: 4px; color: #ffffffaa; font-size: 13px; margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`;

const id = await agent.insertHtml(ORBIT, { title: 'Orbit animation', typeCode: true });
await agent.typeParagraph('Open "Edit code" on the block above to change it. Your edits and mine merge live.');
console.log(`[agent] inserted HTML block ${id}`);
await agent.disconnect();
process.exit(0);

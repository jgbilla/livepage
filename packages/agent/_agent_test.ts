import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const token = process.argv[2];
const c = new Client({ name: 'fake-claude-code', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const t = (r: any) => r.content[0].text as string;
for (let i = 0; i < 6; i++) {
  const got = t(await c.callTool({ name: 'wait_for_requests', arguments: { wait_seconds: 10 } }));
  console.log('GOT:', got);
  const m = got.match(/request (ar_[\w-]+)\npage: (p_[\w-]+)/);
  if (!m) continue;
  await c.callTool({ name: 'reply_to_request', arguments: { request_id: m[1], text: 'Checking my notes on footnote styles…', done: false } });
  await c.callTool({ name: 'write_paragraph', arguments: { page: m[2], text: 'From my local notes: we use Chicago-style footnotes, numbered per essay.' } });
  await c.callTool({ name: 'reply_to_request', arguments: { request_id: m[1], text: 'Added a paragraph on our footnote style, based on the notes in my workspace.' } });
  break;
}
await c.close(); process.exit(0);

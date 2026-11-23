import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import * as Y from 'yjs';
import { listBlocks } from '@livepage/schema';
import { createStore } from './db.ts';
import { handleAgentApi } from './agent-api.ts';

const port = Number(process.env.SERVER_PORT ?? 1234);
const agentToken = process.env.AGENT_TOKEN ?? 'dev-agent-token';
const store = await createStore(process.env.DATABASE_URL);

export type Context = { user: { id: string; name: string; kind: 'human' | 'agent' } };

const server = new Server<Context>({
  port,
  quiet: true,
  debounce: 1000,
  maxDebounce: 5000,
  extensions: [
    new Database({
      fetch: ({ documentName }) => store.fetch(documentName),
      store: async ({ documentName, state, document }) => {
        await store.store(documentName, state, listBlocks(document as unknown as Y.Doc));
      },
    }),
  ],

  // Accounts are not built yet (see SPEC.md "Accounts and permissions").
  // For now: the agent token marks an agent; any other token is a guest human.
  async onAuthenticate({ token }) {
    if (token === agentToken) return { user: { id: 'agent', name: 'Agent', kind: 'agent' } };
    return { user: { id: `guest_${token || 'anon'}`, name: 'Guest', kind: 'human' } };
  },

  async onRequest({ request, response, instance }) {
    const handled = await handleAgentApi(request, response, instance, agentToken);
    if (handled) throw null; // tell Hocuspocus the response was sent
  },
});

await server.listen();
console.log(`[server] collab ws://localhost:${port}  agent API http://localhost:${port}/api`);

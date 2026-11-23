// Makes the two accounts the tests share. Sign-ups are rate limited per address (10 a minute),
// so the tests sign in as these instead of each making its own account.
import { request, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

export const AUTH_DIR = 'e2e-results/.auth';
export const USERS = { a: `${AUTH_DIR}/a.json`, b: `${AUTH_DIR}/b.json` };

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  mkdirSync(AUTH_DIR, { recursive: true });
  const run = Date.now().toString(36);
  for (const [key, name] of [['a', 'Writer A'], ['b', 'Writer B']] as const) {
    const ctx = await request.newContext({ baseURL });
    const res = await ctx.post('/api/auth/signup', { data: { email: `smoke-${run}-${key}@example.com`, name, password: 'smoke-test-password' } });
    if (res.status() !== 201) throw new Error(`sign-up for ${name} failed: ${res.status()} ${await res.text()}`);
    writeFileSync(USERS[key], JSON.stringify(await ctx.storageState()));
    await ctx.dispose();
  }
}

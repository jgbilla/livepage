// Smoke tests for the main flows. Each test makes its own account, so they run in parallel.
// Tests run signed in as Writer A (made in global-setup.ts); each works on its own new page.
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { USERS } from './global-setup';

const uniqueEmail = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

async function newPage(request: APIRequestContext, title = 'Smoke page'): Promise<string> {
  const res = await request.post('/api/pages', { data: { title } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).page.id;
}

async function agentToken(request: APIRequestContext, name = 'Smoke agent'): Promise<string> {
  const res = await request.post('/api/tokens', { data: { name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).token;
}

/** The page's saved content, as the server sees it (markdown). */
async function markdown(request: APIRequestContext, pageId: string): Promise<string> {
  const res = await request.get(`/api/pages/${pageId}/content`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).markdown as string;
}

async function openPage(page: Page, pageId: string) {
  await page.goto(`/p/${pageId}`);
  await expect(page.locator('.ProseMirror')).toBeVisible();
  // Wait for the live connection: the editor only becomes editable once the document has synced.
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
}

/** Put the caret at the end of the page body. */
async function caretAtEnd(page: Page) {
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign up, create a page, write, and find it again after a reload', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'No account yet? Sign up' }).click();
    await page.getByLabel('Name').fill('New Writer');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel('Password').fill('smoke-test-password');
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.locator('.home')).toBeVisible();

    await page.getByRole('main').getByRole('button', { name: 'New page' }).click();
    await expect(page).toHaveURL(/\/p\/p_/);
    const pageId = page.url().match(/\/p\/(p_[\w-]+)/)![1];
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();

    await page.getByLabel('Page title').fill('My first page');
    await caretAtEnd(page);
    await page.keyboard.type('Hello from the smoke test.');

    // Saved to Postgres (the server writes after a short debounce).
    await expect.poll(() => markdown(page.request, pageId), { timeout: 20_000 }).toContain('Hello from the smoke test.');
    await page.reload();
    await expect(page.locator('.ProseMirror')).toContainText('Hello from the smoke test.');
    await expect(page.getByLabel('Page title')).toHaveValue('My first page');

    await expect(page.getByRole('tree')).toContainText('My first page'); // the sidebar
  });
});

test('two browsers see each other\'s edits live', async ({ browser, page }) => {
  const pageId = await newPage(page.request, 'Live sync');
  // A second browser, signed in as Writer B, who joins through an editor share link.
  const other = await browser.newContext({ storageState: USERS.b });
  const pageB = await other.newPage();
  const share = await page.request.post(`/api/pages/${pageId}/share-links`, { data: { role: 'editor' } });
  expect(share.ok(), await share.text()).toBeTruthy();
  const { token } = await share.json();
  const join = await pageB.request.post(`/api/share/${token}`);
  expect(join.ok(), await join.text()).toBeTruthy();

  await openPage(page, pageId);
  await openPage(pageB, pageId);

  await caretAtEnd(page);
  await page.keyboard.type('Typed in browser A.');
  await expect(pageB.locator('.ProseMirror')).toContainText('Typed in browser A.');

  await caretAtEnd(pageB);
  await pageB.keyboard.press('Enter');
  await pageB.keyboard.type('Typed in browser B.');
  await expect(page.locator('.ProseMirror')).toContainText('Typed in browser B.');
  await other.close();
});

test('an agent writes through the HTTP API and MCP, and the page updates live', async ({ page }) => {
  const pageId = await newPage(page.request, 'Agent page');
  const token = await agentToken(page.request);
  await openPage(page, pageId);

  // HTTP agent API
  const api = await page.request.post(`/api/pages/${pageId}/paragraphs`, {
    headers: { authorization: `Bearer ${token}` },
    data: { text: 'Written by the agent API.' },
  });
  expect(api.ok(), await api.text()).toBeTruthy();
  await expect(page.locator('.ProseMirror')).toContainText('Written by the agent API.');

  // Hosted MCP (Streamable HTTP)
  const mcp = async (body: object, session?: string) => {
    const res = await page.request.post('/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
      },
      data: body,
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    const raw = await res.text();
    const data = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() ?? '';
    return { session: res.headers()['mcp-session-id'], json: data ? JSON.parse(data) : null };
  };
  const init = await mcp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1' } },
  });
  expect(init.session).toBeTruthy();
  await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);
  const call = await mcp({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'add_heading', arguments: { page: pageId, text: 'Heading from MCP', level: 2 } },
  }, init.session);
  expect(call.json?.result?.isError ?? false, JSON.stringify(call.json)).toBe(false);
  await expect(page.locator('.ProseMirror h2')).toContainText('Heading from MCP');
});

test('comments: comment on the page and see it listed', async ({ page }) => {
  const pageId = await newPage(page.request, 'Comments page');
  await page.goto(`/p/${pageId}?comment=`);
  const panel = page.getByRole('complementary', { name: 'Comments' }).or(page.locator('.comments'));
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '+ Comment on the page' }).click();
  await panel.getByPlaceholder('Add a comment. Type @ to mention someone or an agent.').fill('Looks good to me.');
  await panel.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(panel.locator('.comment-body')).toContainText('Looks good to me.');

  const res = await page.request.get(`/api/pages/${pageId}/comments`);
  expect(JSON.stringify(await res.json())).toContain('Looks good to me.');
});

test('the / menu inserts blocks, including a footnote', async ({ page }) => {
  const pageId = await newPage(page.request, 'Slash menu');
  await openPage(page, pageId);

  await caretAtEnd(page);
  await page.keyboard.type('/');
  const menu = page.locator('.slash-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.type('h2'); // the query ends at a space
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await page.keyboard.type('A slash heading');
  await expect(page.locator('.ProseMirror h2')).toContainText('A slash heading');

  await page.keyboard.press('Enter');
  await page.keyboard.type('A claim that needs a source.');
  await page.keyboard.type(' /footnote'); // the menu opens after a space or at the start of a line
  await expect(menu).toBeVisible();
  await page.keyboard.press('Enter');
  const form = page.locator('.fn-form');
  await expect(form).toBeVisible();
  await form.getByPlaceholder('Footnote text (optional)').fill('The source of the claim');
  await form.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('region', { name: 'Footnotes' }).or(page.locator('[aria-label="Footnotes"]'))).toContainText('The source of the claim');

  await expect.poll(async () => JSON.stringify(await (await page.request.get(`/api/pages/${pageId}/footnotes`)).json()), { timeout: 20_000 })
    .toContain('The source of the claim');
});

test('page tabs and workspace tabs', async ({ page }) => {
  const pageId = await newPage(page.request, 'Tabs page');
  await openPage(page, pageId);

  // A page tab: its own section of the page.
  await page.getByRole('button', { name: '+ Add page tab' }).click();
  const tabName = page.getByLabel('Tab name');
  await tabName.fill('Research');
  await tabName.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Page tabs' })).toContainText('Research');
  await expect.poll(async () => JSON.stringify(await (await page.request.get(`/api/pages/${pageId}/tabs`)).json()), { timeout: 20_000 })
    .toContain('Research');

  // Workspace tabs: a second open tab, then switch back.
  const strip = page.getByRole('tablist', { name: 'Open tabs' });
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'New tab' }).click();
  await expect(page.locator('.home')).toBeVisible();
  await expect(strip.locator('.wt-title')).toHaveCount(2);
  await strip.locator('.wt-title', { hasText: 'Tabs page' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue('Tabs page');
});

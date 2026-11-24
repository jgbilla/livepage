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

test('your other device follows along: new pages and the Ask AI chat', async ({ browser, page }) => {
  // The same person on a second device (its own browser profile, same account).
  const phone = await browser.newContext({ storageState: USERS.a, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const other = await phone.newPage();
  await page.goto('/');
  await other.goto('/');

  // A page made on one device shows up on the other without a reload.
  const title = `Made elsewhere ${Date.now().toString(36)}`;
  const pageId = await newPage(page.request, title);
  await expect(other.getByText(title).first()).toBeAttached({ timeout: 15_000 });

  // A question asked on one device (here to a connected agent) and its answer show on the other.
  const agentName = `Sync agent ${Math.random().toString(36).slice(2, 8)}`;
  const token = await agentToken(page.request, agentName);
  const tokenId = (await (await page.request.get('/api/agents')).json()).agents.find((a: { name: string }) => a.name === agentName).id;
  // Ask through that agent on this device too (Writer A has no AI key set up).
  await other.evaluate((id) => localStorage.setItem('livepage.askTarget', id), tokenId);
  await openPage(other, pageId);
  await other.locator('button.ask-ai').click();
  const asked = await page.request.post(`/api/pages/${pageId}/agent-requests`, { data: { tokenId, prompt: 'Asked on the laptop' } });
  expect(asked.ok(), await asked.text()).toBeTruthy();
  await expect(other.locator('.turn-user')).toContainText('Asked on the laptop');
  const agent = await page.request.get('/api/agent-requests?wait=2', { headers: { authorization: `Bearer ${token}` } });
  const [req] = (await agent.json()).requests;
  await page.request.post(`/api/agent-requests/${req.id}/reply`, { headers: { authorization: `Bearer ${token}` }, data: { text: 'Answered for every device.' } });
  await expect(other.locator('.turn-assistant')).toContainText('Answered for every device.');

  // And it is still there after a reload.
  await other.reload();
  await other.locator('button.ask-ai').click();
  await expect(other.locator('.turn-assistant')).toContainText('Answered for every device.');
  await phone.close();
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

test('an agent edits only what needs changing: words, one block, a table cell', async ({ page }) => {
  const pageId = await newPage(page.request, 'Targeted edits');
  const token = await agentToken(page.request);
  const auth = { authorization: `Bearer ${token}` };
  const seed = await page.request.post(`/api/pages/${pageId}/blocks`, {
    headers: auth,
    data: { markdown: '## Intro\n\nLivepage has **three** kinds of block.\n\n## Tools\n\n| Tool | Does |\n| --- | --- |\n| read | Reads |\n\nLast words.' },
  });
  expect(seed.ok(), await seed.text()).toBeTruthy();
  await openPage(page, pageId);
  const editor = page.locator('.ProseMirror');
  await expect(editor).toContainText('Last words.');

  // Hosted MCP session
  let n = 0;
  let session: string | undefined;
  const rpc = async (method: string, params?: object, notify = false) => {
    const res = await page.request.post('/mcp', {
      headers: { ...auth, accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}) },
      data: { jsonrpc: '2.0', ...(notify ? {} : { id: ++n }), method, ...(params ? { params } : {}) },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    session ??= res.headers()['mcp-session-id'];
    const raw = await res.text();
    const data = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() ?? '';
    return data ? JSON.parse(data) : null;
  };
  const tool = async (name: string, args: object): Promise<string> => {
    const r = await rpc('tools/call', { name, arguments: { page: pageId, ...args } });
    const out = r?.result?.content?.[0]?.text ?? '';
    expect(out.startsWith('error:'), `${name}: ${out}`).toBe(false);
    return out;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1' } });
  await rpc('notifications/initialized', undefined, true);

  // Find the place without reading the page: outline, then one section.
  const outline = await tool('get_outline', {});
  const tools = outline.match(/## Tools {2}\[(b_\w+)\]/)![1];
  const section = await tool('read_blocks', { section: tools });
  expect(section).not.toContain('three');
  const table = section.match(/\[(b_\w+) table\]/)![1];
  const last = section.match(/\[(b_\w+) paragraph\]\nLast words\./)![1];

  // The person keeps writing above; the ids the agent holds stay good.
  await editor.locator('h2', { hasText: 'Intro' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed by a person meanwhile.');

  await tool('replace_text', { find: 'three', replace: 'four' });
  await expect(editor.locator('strong')).toHaveText('four'); // edited in place: still bold
  await tool('set_table_cell', { block_id: table, row: 2, column: 2, text: 'Reads one section' });
  await tool('add_table_row', { block_id: table, cells: ['replace_text', 'Changes words in place'] });
  await expect(editor.locator('table tr')).toHaveCount(3);
  await expect(editor.locator('table')).toContainText('Reads one section');
  await tool('replace_blocks', { block_id: last, markdown: 'New last words.\n\n- one\n- two' });
  await tool('insert_blocks', { before: tools, markdown: 'Inserted before Tools.' });
  await expect(editor.locator('li')).toHaveCount(2);

  await expect.poll(async () => (await markdown(page.request, pageId)).trim()).toBe([ // the editor keeps an empty paragraph after a list
    '## Intro', 'Typed by a person meanwhile.', 'Livepage has four kinds of block.', 'Inserted before Tools.', '## Tools',
    '| Tool | Does |\n| --- | --- |\n| read | Reads one section |\n| replace_text | Changes words in place |', 'New last words.', 'onetwo',
  ].join('\n\n'));

  // Move the Tools section to the top, then delete the inserted paragraph, over the HTTP API.
  const blocks = (await (await page.request.get(`/api/pages/${pageId}/blocks`, { headers: auth })).json()).blocks as { id: string; markdown: string }[];
  const id = (text: string) => blocks.find((b) => b.markdown.startsWith(text))!.id;
  const move = await page.request.post(`/api/pages/${pageId}/move`, { headers: auth, data: { block_id: id('## Tools'), through: id('| Tool'), before: id('## Intro') } });
  expect(move.ok(), await move.text()).toBeTruthy();
  const del = await page.request.delete(`/api/pages/${pageId}/blocks/${id('Inserted before')}`, { headers: auth });
  expect(del.ok(), await del.text()).toBeTruthy();
  await expect(editor.locator('h2').first()).toHaveText('Tools');
  await expect(editor).not.toContainText('Inserted before Tools.');
  await expect(editor).toContainText('Typed by a person meanwhile.');
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

test('headings fold: hide a section, keep it after a reload, agents still read it', async ({ page }) => {
  const pageId = await newPage(page.request, 'Folding');
  await openPage(page, pageId);
  await caretAtEnd(page);
  const k = page.keyboard;
  await k.type('## Plan'); await k.press('Enter'); await k.type('Hidden line one'); await k.press('Enter'); await k.type('Hidden line two'); await k.press('Enter');
  await k.type('## Next'); await k.press('Enter'); await k.type('Still visible'); await k.press('Enter');
  await k.type('/toggle'); await expect(page.locator('.slash-menu')).toBeVisible(); await page.getByRole('option', { name: /Toggle heading 1/ }).click(); await k.type('A toggle heading');
  await expect(page.locator('.ProseMirror h1[data-toggle="true"]')).toContainText('A toggle heading');

  const plan = page.locator('.ProseMirror h2', { hasText: 'Plan' });
  await plan.hover();
  await plan.getByRole('button', { name: 'Collapse section' }).click();
  await expect(page.getByText('Hidden line one')).toBeHidden();
  await expect(page.getByText('Still visible')).toBeVisible();
  await expect(plan.locator('.fold-more')).toHaveText('2 blocks');

  // Folding is a view choice: the page and the agents' outline still have everything.
  expect(await markdown(page.request, pageId)).toContain('Hidden line two');
  const outline = await (await page.request.get(`/api/pages/${pageId}/outline`)).json();
  expect(outline.tabs[0].headings.find((h: { text: string }) => h.text === 'Plan').blocks).toBe(3);

  await page.reload();
  await expect(page.locator('.ProseMirror h2', { hasText: 'Plan' })).toBeVisible();
  await expect(page.getByText('Hidden line one')).toBeHidden();
  await page.locator('.fold-more').click();
  await expect(page.getByText('Hidden line one')).toBeVisible();
});

test('toggle lines: any line hides what is nested under it', async ({ page }) => {
  const pageId = await newPage(page.request, 'Toggles');
  await openPage(page, pageId);
  await caretAtEnd(page);
  const k = page.keyboard;
  await k.type('/toggle'); await expect(page.locator('.slash-menu')).toBeVisible(); await k.press('Enter');
  await k.type('Why it matters'); await k.press('Enter'); // Enter at the end of an open toggle writes inside it
  await k.type('Nested one'); await k.press('Enter'); await k.press('Enter'); // Enter on the empty last line leaves it
  await k.type('Moves in'); await k.press('Tab'); // Tab right after a toggle moves the line inside
  const toggle = page.locator('.ProseMirror .toggle-block');
  await expect(toggle.locator('> p')).toHaveText(['Why it matters', 'Nested one', 'Moves in']);

  await toggle.getByRole('button', { name: 'Close toggle' }).click();
  await expect(page.getByText('Nested one')).toBeHidden();
  await expect(toggle.locator('.fold-more')).toHaveText('2 blocks');
  // Agents read it as an Obsidian foldable callout, folded or not.
  await expect.poll(() => markdown(page.request, pageId)).toContain('> [!toggle] Why it matters\n>\n> Nested one\n>\n> Moves in');

  await page.reload();
  await expect(page.locator('.ProseMirror .toggle-block')).toBeVisible();
  await expect(page.getByText('Nested one')).toBeHidden();
  await page.locator('.fold-more').click();
  await expect(page.getByText('Nested one')).toBeVisible();
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

  // A page that is already open: clicking it in the sidebar goes to its tab instead of opening it twice.
  const otherId = await newPage(page.request, 'Second tabs page');
  await strip.getByRole('button', { name: 'New tab' }).click();
  await expect(page.locator('.wt-visible .home')).toBeVisible();
  await page.locator(`.sidebar a[href="/p/${otherId}"]`).click();
  await expect(page.locator('.wt-visible').getByLabel('Page title')).toHaveValue('Second tabs page');
  await expect(strip.locator('.wt-title')).toHaveCount(3);
  await page.locator(`.sidebar a[href="/p/${pageId}"]`).click();
  await expect(page.locator('.wt-visible').getByLabel('Page title')).toHaveValue('Tabs page');
  await expect(strip.locator('.wt-title')).toHaveCount(3);
  await expect(strip.locator('.wt-tab-active .wt-title')).toHaveText('Tabs page');
  await expect(strip.locator('.wt-title', { hasText: 'Second tabs page' })).toHaveCount(1);
  // Back returns to the tab you came from.
  await page.goBack();
  await expect(page.locator('.wt-visible').getByLabel('Page title')).toHaveValue('Second tabs page');
  await expect(strip.locator('.wt-title')).toHaveCount(3);
});

// Serial: an "any available agent" task goes to whichever agent of the account polls first.
test.describe.serial('task board', () => {
test('hand a task to an agent, answer its question, see it finish', async ({ page, playwright, baseURL }) => {
  const name = `Board agent ${Math.random().toString(36).slice(2, 6)}`;
  const token = await agentToken(page.request, name);
  const pageId = await newPage(page.request, 'Task smoke page');
  const agent = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { authorization: `Bearer ${token}` } });

  await page.goto(`/tasks?new=1&page=${pageId}`);
  await page.getByLabel('What should it do?').fill('Tighten the intro');
  await page.locator('.agent-option', { hasText: name }).click();
  await page.getByRole('button', { name: `Hand to ${name}` }).click();
  await expect(page.locator('.task-sheet')).toBeVisible();

  // The agent takes it with the same call as Ask AI requests, then reports.
  const { tasks } = await (await agent.get('/api/agent-requests?wait=5')).json();
  expect(tasks.map((t: { title: string }) => t.title)).toContain('Tighten the intro');
  const id = tasks.find((t: { title: string }) => t.title === 'Tighten the intro').id;
  expect((await agent.post(`/api/tasks/${id}/ack`)).ok()).toBeTruthy();
  await agent.post(`/api/tasks/${id}/update`, { data: { status: 'needs_you', note: 'Keep the opening quote?' } });

  // The board follows along without a reload, and the person's answer goes back to the agent.
  await expect(page.locator('.task-question')).toContainText('Keep the opening quote?');
  await page.getByLabel(`Answer ${name}`).fill('Yes, keep it');
  await page.getByRole('button', { name: 'Send' }).click();
  const again = await (await agent.get('/api/agent-requests?wait=5')).json();
  expect(again.tasks.find((t: { id: string }) => t.id === id).text).toContain('Yes, keep it');
  await agent.post(`/api/tasks/${id}/update`, { data: { status: 'done', note: 'Cut it to two sentences.' } });
  await expect(page.locator('.task-sheet .task-badge')).toHaveText('Done');
  await agent.dispose();
});

test('a task nobody is listening for says so, and any agent that listens takes it', async ({ page, playwright, baseURL }) => {
  const name = `Idle agent ${Math.random().toString(36).slice(2, 6)}`;
  const token = await agentToken(page.request, name);
  const agent = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  const title = `Any agent ${Math.random().toString(36).slice(2, 6)}`;

  // Not listening yet: the picker says so and warns before handing it out.
  await page.goto('/tasks?new=1');
  await page.getByLabel('What should it do?').fill(title);
  await expect(page.locator('.agent-option', { hasText: name })).toContainText('Never connected');
  await page.locator('.agent-option', { hasText: name }).click();
  await expect(page.locator('.task-warn')).toContainText(`${name} isn't listening`);

  // It starts listening: its chip and the picker turn green, and the task goes to it the moment it's handed out.
  const poll = agent.get('/api/agent-requests?wait=20');
  await expect(page.locator('.agent-chip.on', { hasText: name })).toBeVisible();
  await expect(page.locator('.agent-option', { hasText: name })).toContainText('Listening now');
  await expect(page.locator('.task-warn')).toHaveCount(0);
  await page.locator('.agent-option', { hasText: 'Any available agent' }).click();
  await page.getByRole('button', { name: 'Hand to any agent' }).click();
  await expect(page.locator('.task-sheet')).toBeVisible();
  const { tasks } = await (await poll).json();
  const t = tasks.find((x: { title: string }) => x.title === title);
  expect(t).toBeTruthy();
  expect((await agent.post(`/api/tasks/${t.id}/ack`)).ok()).toBeTruthy();
  await agent.post(`/api/tasks/${t.id}/update`, { data: { status: 'working', note: 'On it' } });
  await expect(page.locator('.task-sheet .task-meta-agent')).toContainText(name);
  await agent.dispose();
});
});

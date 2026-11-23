// Pages you have opened are kept in this browser (IndexedDB), so the next time you open one
// its content shows at once, before the live connection finishes syncing. The server stays
// the source of truth: the saved copy is merged with it like any other collaborator's edits.
// Copies are per person, and are removed when you sign out or lose access to a page.
const INDEX_KEY = 'lp.localPages';

export const localPageName = (userId: string, pageId: string) => `lp:${userId}:${pageId}`;

function readIndex(): string[] {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]'); } catch { return []; }
}
function writeIndex(names: string[]) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(names)); } catch { /* storage blocked */ }
}

/** Remember that a local copy exists, so signing out can remove it. */
export function noteLocalPage(name: string) {
  const names = readIndex();
  if (!names.includes(name)) writeIndex([...names, name]);
}

const drop = (name: string) => new Promise<void>((done) => {
  try {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => done();
  } catch { done(); }
});

export async function forgetLocalPage(name: string) {
  writeIndex(readIndex().filter((n) => n !== name));
  await drop(name);
}

/** On sign-out: nothing of this person's pages stays behind on the device. */
export async function clearLocalPages() {
  const names = readIndex();
  writeIndex([]);
  try { localStorage.removeItem('lp.workspace'); } catch { /* storage blocked */ }
  await Promise.all(names.map(drop));
}

// Each person's assistant settings: which provider, which model, and their own API key.
// Keys are encrypted at rest (AES-256-GCM, key derived from AI_KEY_SECRET, bound to the user id)
// and never leave the server: the browser only ever sees a hint like "sk-…a1b2", and the
// sandbox that runs HTML blocks has no way to reach them.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Db } from '../db.ts';
import { config } from '../config.ts';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'custom';

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** Which wire protocol: Anthropic Messages, or OpenAI-style chat completions (most others). */
  api: 'anthropic' | 'openai';
  baseUrl: string;
  defaultModel: string;
  keyRequired: boolean;
  keyUrl?: string;
};

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', api: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-5-5', keyRequired: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5', keyRequired: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google (Gemini)', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash', keyRequired: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter (any model)', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto', keyRequired: true, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'custom', label: 'OpenAI-compatible or local (Ollama, LM Studio, vLLM…)', api: 'openai', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1', keyRequired: false },
];
export const providerInfo = (id: string) => PROVIDERS.find((p) => p.id === id);

export type AiSettings = { provider: ProviderId; model: string; baseUrl: string; keyHint: string; hasKey: boolean };
export type AiRuntime = { provider: ProviderInfo; model: string; baseUrl: string; apiKey: string };

export class AiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const aiAvailable = () => !!config.aiKeySecret;

function cipherKey(): Buffer {
  if (!config.aiKeySecret) throw new AiError(503, 'The assistant is not set up on this server: its admin needs to set AI_KEY_SECRET.');
  return createHash('sha256').update(`livepage-ai-keys:${config.aiKeySecret}`).digest();
}

export function encryptKey(userId: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(), iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptKey(userId: string, stored: string): string {
  if (!stored) return '';
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new AiError(500, 'Saved API key is unreadable. Save it again.');
  try {
    const d = createDecipheriv('aes-256-gcm', cipherKey(), Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(userId));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new AiError(500, 'Saved API key could not be decrypted (the server secret changed?). Save it again.');
  }
}

const hint = (key: string) => (key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key ? '••••' : '');

// ---- Endpoint safety: the server fetches whatever base URL people enter, so keep it off
// private networks unless the admin allows it (self-hosters running Ollama next to the app).

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const v4 = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? privateAddress(v4[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function checkBaseUrl(raw: string): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AiError(400, 'Enter a full endpoint URL, like https://api.example.com/v1'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AiError(400, 'The endpoint must be an http(s) URL.');
  if (u.username || u.password) throw new AiError(400, 'Put the API key in the key field, not in the URL.');
  if (!config.aiAllowPrivate) {
    if (u.protocol !== 'https:') throw new AiError(400, 'This server only allows https endpoints.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!addrs.length) throw new AiError(400, `Could not find ${host}.`);
    if (addrs.some(privateAddress)) {
      throw new AiError(400, 'This server does not allow private or local endpoints. A self-hosted server can allow them with AI_ALLOW_PRIVATE_ENDPOINTS=1.');
    }
  }
  return u.toString().replace(/\/+$/, '');
}

// ---- Storage

export async function getSettings(db: Db, userId: string): Promise<AiSettings | null> {
  const [row] = await db.query('select provider, model, base_url, api_key_enc, key_hint from ai_settings where user_id = $1', [userId]);
  if (!row) return null;
  return { provider: row.provider, model: row.model, baseUrl: row.base_url, keyHint: row.key_hint, hasKey: !!row.api_key_enc };
}

export type SettingsInput = { provider?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown };

/** Validate settings from the browser. A missing apiKey keeps the saved one (if the provider is unchanged). */
export async function resolveInput(db: Db, userId: string, b: SettingsInput): Promise<AiRuntime & { keyChanged: boolean }> {
  const provider = providerInfo(String(b.provider ?? ''));
  if (!provider) throw new AiError(400, 'Pick a provider.');
  const model = String(b.model ?? '').trim().slice(0, 200) || provider.defaultModel;
  const baseUrl = await checkBaseUrl(provider.id === 'custom' ? String(b.baseUrl ?? '').trim() || provider.baseUrl : provider.baseUrl);
  let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  const keyChanged = !!apiKey;
  if (!apiKey) {
    const [row] = await db.query('select provider, base_url, api_key_enc from ai_settings where user_id = $1', [userId]);
    // Only reuse a saved key for the same provider and endpoint, so a key is never sent somewhere new.
    if (row && row.provider === provider.id && row.base_url === baseUrl) apiKey = decryptKey(userId, row.api_key_enc);
  }
  if (apiKey.length > 500) throw new AiError(400, 'That API key is too long.');
  if (provider.keyRequired && !apiKey) throw new AiError(400, `Paste your ${provider.label} API key.`);
  return { provider, model, baseUrl, apiKey, keyChanged };
}

export async function saveSettings(db: Db, userId: string, b: SettingsInput): Promise<AiSettings> {
  const r = await resolveInput(db, userId, b);
  await db.query(
    `insert into ai_settings (user_id, provider, model, base_url, api_key_enc, key_hint, updated_at) values ($1,$2,$3,$4,$5,$6, now())
     on conflict (user_id) do update set provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
       api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint, updated_at = now()`,
    [userId, r.provider.id, r.model, r.baseUrl, r.apiKey ? encryptKey(userId, r.apiKey) : '', hint(r.apiKey)],
  );
  return (await getSettings(db, userId))!;
}

export async function deleteSettings(db: Db, userId: string) {
  await db.query('delete from ai_settings where user_id = $1', [userId]);
}

/** The decrypted settings for a run. Throws a friendly error if the person has not set up the assistant. */
export async function runtimeFor(db: Db, userId: string): Promise<AiRuntime> {
  const [row] = await db.query('select provider, model, base_url, api_key_enc from ai_settings where user_id = $1', [userId]);
  if (!row) throw new AiError(412, 'Set up the assistant first: pick a provider and paste your API key.');
  const provider = providerInfo(row.provider);
  if (!provider) throw new AiError(412, 'Your assistant settings are out of date. Set them up again.');
  const baseUrl = await checkBaseUrl(row.base_url); // re-checked every run: DNS can change
  return { provider, model: row.model, baseUrl, apiKey: decryptKey(userId, row.api_key_enc) };
}

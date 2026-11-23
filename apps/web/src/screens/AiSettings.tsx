import { useEffect, useState } from 'react';
import { api } from '../api';

type Provider = { id: string; label: string; defaultModel: string; keyRequired: boolean; keyUrl?: string; baseUrl?: string };
export type AiSettingsValue = { provider: string; model: string; baseUrl: string; keyHint: string; hasKey: boolean };
type Loaded = { available: boolean; settings: AiSettingsValue | null; providers: Provider[] };

/** Pick a provider and model and paste your own API key. Used on the home page and inside the Ask AI panel. */
export function AiSettings({ onSaved, compact }: { onSaved?: (s: AiSettingsValue | null) => void; compact?: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'save' | 'models'>('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Loaded>('/ai/settings').then((d) => {
      setData(d);
      const s = d.settings;
      setProvider(s?.provider ?? 'anthropic');
      setModel(s?.model ?? '');
      setBaseUrl(s?.baseUrl ?? '');
    }).catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);

  if (!data) return <p className="muted small">{msg?.text ?? 'Loading…'}</p>;
  if (!data.available) return <p className="muted small">The assistant isn't turned on for this server yet: its admin needs to set <code>AI_KEY_SECRET</code>.</p>;

  const p = data.providers.find((x) => x.id === provider) ?? data.providers[0];
  const saved = data.settings;
  const sameAsSaved = saved?.provider === provider && (provider !== 'custom' || saved.baseUrl === baseUrl.replace(/\/+$/, ''));
  const body = () => ({ provider, model: model.trim() || p.defaultModel, baseUrl: provider === 'custom' ? baseUrl.trim() || p.baseUrl : undefined, apiKey: apiKey.trim() || undefined });

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      const r = await api<{ settings: AiSettingsValue }>('/ai/settings', { method: 'PUT', body: body() });
      setData({ ...data, settings: r.settings });
      setApiKey('');
      setMsg({ ok: true, text: 'Saved. Open any page and press Ask AI.' });
      onSaved?.(r.settings);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(''); }
  };
  const loadModels = async () => {
    setBusy('models'); setMsg(null);
    try {
      const r = await api<{ models: string[] }>('/ai/models', { body: body() });
      setModels(r.models);
      setMsg({ ok: true, text: r.models.length ? `Connected. ${r.models.length} models available.` : 'Connected, but the provider listed no models. Type one in.' });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(''); }
  };
  const remove = async () => {
    await api('/ai/settings', { method: 'DELETE' });
    setData({ ...data, settings: null });
    setApiKey(''); setModel(''); setMsg({ ok: true, text: 'Removed your key and settings.' });
    onSaved?.(null);
  };

  return (
    <div className={`ai-settings ${compact ? 'compact' : ''}`}>
      <label>Provider
        <select value={provider} onChange={(e) => { setProvider(e.target.value); setModels([]); setModel(''); setMsg(null); }}>
          {data.providers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </label>
      {provider === 'custom' && (
        <label>Endpoint (OpenAI-compatible base URL)
          <input value={baseUrl} placeholder={p.baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      )}
      <label>API key {p.keyUrl && <a className="small muted" href={p.keyUrl} target="_blank" rel="noreferrer">get one</a>}
        <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={sameAsSaved && saved?.hasKey ? `saved (${saved.keyHint}); paste to replace` : p.keyRequired ? 'paste your key' : 'optional'} />
      </label>
      <label>Model
        <span className="row">
          <input list="ai-models" value={model} placeholder={p.defaultModel} onChange={(e) => setModel(e.target.value)} style={{ flex: 1 }} />
          <button type="button" onClick={loadModels} disabled={!!busy}>{busy === 'models' ? 'Checking…' : 'Test & list models'}</button>
        </span>
        <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <div className="row">
        <button type="button" className="primary" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        {saved && <button type="button" className="ghost" onClick={remove}>Remove key</button>}
      </div>
      {msg && <p className={msg.ok ? 'small ai-ok' : 'form-error'}>{msg.text}</p>}
      <p className="muted small">Your key is encrypted on the server and only used for your own requests. Livepage never sends it to the browser or to HTML blocks.</p>
    </div>
  );
}

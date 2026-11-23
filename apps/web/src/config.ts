// Runtime config comes from the server (/api/config), so one build works on any domain.
export type AppConfig = { sandboxUrl: string; signupOpen: boolean; neonAuthUrl: string | null };

export const collabUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;

let cached: AppConfig | null = null;
export async function loadConfig(): Promise<AppConfig> {
  if (!cached) cached = await (await fetch('/api/config')).json();
  return cached!;
}
export const appConfig = () => cached!;

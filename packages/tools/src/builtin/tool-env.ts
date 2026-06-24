const ALWAYS_PASS = ['PATH', 'HOME', 'LANG', 'LC_ALL'];

export function buildToolEnv(envAllowList?: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set<string>([...ALWAYS_PASS, ...(envAllowList ?? [])]);
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

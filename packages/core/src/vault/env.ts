/**
 * Secrets come from the vault only. This machine (like most developer machines) carries API keys
 * and tokens for other projects in its environment; finc must never pick one of those up, neither
 * through its own code nor through a library that reads the environment on its own.
 *
 * `scrubSecretEnv()` runs first thing in every entry point and deletes such variables from this
 * process. FINC_* settings are configuration, not secrets, and are left alone.
 */
export const SECRET_ENV_EXACT: ReadonlySet<string> = new Set(['RISEUP_PAT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'HF_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN']);
export const SECRET_ENV_PATTERN = /(^(OPENAI|ANTHROPIC|RISEUP|AZURE_OPENAI|GEMINI|MISTRAL|COHERE|GROQ|TOGETHER|OPENROUTER)_)|((_|^)SECRET(_|$))|((_|^)(API_KEY|APIKEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PAT|PASSWORD|PASSWD)$)/i;

export function isSecretEnvName(name: string): boolean {
  if (name.toUpperCase().startsWith('FINC_')) return false;
  return SECRET_ENV_EXACT.has(name.toUpperCase()) || SECRET_ENV_PATTERN.test(name);
}

/** Delete every secret-looking variable from `env` (default: this process). Returns the names removed, never the values. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (isSecretEnvName(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

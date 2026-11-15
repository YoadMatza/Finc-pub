import { AI_DEFAULTS, type AiConfig, Vault, categorizeWithAi, clearAiSuggestions, createProvider, getAiSettings, openDb, setSetting, vaultPath } from '@finc/core';
import type { Command } from 'commander';
import { openVaultInteractive } from './vault.js';

/**
 * Keys come from the vault and nowhere else. Environment variables are never consulted (and are
 * scrubbed at startup): this machine carries other projects' keys that must not be used here.
 */
export async function keyFor(provider: 'anthropic' | 'openai' | 'local'): Promise<{ key: string; source: string } | undefined> {
  if (provider === 'local') return undefined;
  const entryName = `ai_${provider}`;
  if (!Vault.exists(vaultPath())) throw new Error(`no vault yet; run finc vault init, then finc vault set ${entryName}`);
  const v = await openVaultInteractive();
  try {
    const entry = v.get(entryName);
    if (!entry) throw new Error(`no API key in the vault: run finc vault set ${entryName}`);
    // apiKey is the documented field; accept a single field under any name so a mistyped field name still works
    const values = Object.values(entry.fields);
    const key = entry.fields.apiKey ?? entry.fields.token ?? (values.length === 1 ? values[0] : undefined);
    if (!key) throw new Error(`vault entry ${entryName} has no apiKey field: run finc vault set ${entryName}`);
    return { key, source: `vault entry ${entryName}` };
  } finally {
    v.lock();
  }
}

export function registerAiCommands(program: Command): void {
  const ai = program.command('ai').description('Model-assisted categorisation of the long tail (local, Anthropic or OpenAI). Sends merchant name, amounts and months only.');

  ai.command('config')
    .description('Choose the provider and model (keys go in the vault: finc vault set ai_anthropic / ai_openai with a field "apiKey")')
    .option('--provider <p>', 'anthropic|openai|local')
    .option('--model <m>', 'model name')
    .option('--base-url <url>', 'OpenAI-compatible base URL (local: e.g. http://localhost:11434/v1)')
    .option('--clear', 'forget the configuration', false)
    .action((opts: { provider?: string; model?: string; baseUrl?: string; clear: boolean }) => {
      const db = openDb();
      try {
        if (opts.clear) {
          for (const k of ['ai.provider', 'ai.model', 'ai.baseUrl', 'ai.chatModel']) setSetting(db, k, null);
          console.log('cleared');
          return;
        }
        if (opts.provider) {
          if (!['anthropic', 'openai', 'local'].includes(opts.provider)) throw new Error('provider must be anthropic|openai|local');
          // the chat model belongs to one provider (chat v2 step 4): a new provider starts from its default
          if (opts.provider !== getAiSettings(db).provider) setSetting(db, 'ai.chatModel', null);
          setSetting(db, 'ai.provider', opts.provider);
        }
        if (opts.model) setSetting(db, 'ai.model', opts.model);
        if (opts.baseUrl) setSetting(db, 'ai.baseUrl', opts.baseUrl);
        const s = getAiSettings(db);
        const d = s.provider ? AI_DEFAULTS[s.provider] : null;
        console.log(`provider: ${s.provider ?? '(none)'}  model: ${s.model ?? d?.model ?? '-'}  base: ${s.baseUrl ?? d?.baseUrl ?? '-'}`);
        if (s.provider && s.provider !== 'local') console.log(`key: vault entry ai_${s.provider} only (finc vault set ai_${s.provider}); environment variables are never used`);
      } finally {
        db.$client.close();
      }
    });

  ai.command('dry-run')
    .description('Show exactly what would be sent (nothing leaves the machine)')
    .option('-n, --limit <n>', 'merchants', '50')
    .action(async (opts: { limit: string }) => {
      const db = openDb();
      try {
        // Same provider/model identity as a real run, so "already answered" reflects the real cache; no key, no network.
        const s = getAiSettings(db);
        const name = s.provider ?? 'fake';
        const model = s.model ?? (s.provider ? AI_DEFAULTS[s.provider].model : 'dry');
        const r = await categorizeWithAi(db, { name, model, complete: async () => '[]' }, { dryRun: true, limit: Number(opts.limit) });
        console.log(`${r.merchantsConsidered} uncategorised merchants considered, ${r.payload.length} would be sent now (${r.cached} already answered by ${name}/${model}).`);
        console.log('payload (this is the whole of it):');
        console.log(JSON.stringify(r.payload, null, 1));
      } finally {
        db.$client.close();
      }
    });

  ai.command('run')
    .description('Ask the configured model about the biggest uncategorised merchants and apply confident answers')
    .option('-n, --limit <n>', 'merchants per run', '50')
    .option('--min-confidence <x>', '0..1', '0.6')
    .action(async (opts: { limit: string; minConfidence: string }) => {
      const db = openDb();
      try {
        const s = getAiSettings(db);
        if (!s.provider) throw new Error('no provider configured: finc ai config --provider local|anthropic|openai');
        const cfg: AiConfig = { provider: s.provider, model: s.model ?? '', ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}) };
        const key = await keyFor(s.provider);
        if (key) cfg.apiKey = key.key;
        const provider = createProvider(cfg);
        console.log(`provider ${provider.name} model ${provider.model}${key ? `; key from ${key.source}, ends with …${key.key.slice(-4)}` : ''}`);
        const r = await categorizeWithAi(db, provider, { limit: Number(opts.limit), minConfidence: Number(opts.minConfidence) });
        console.log(`sent ${r.sent} merchants in ${r.batches} batch(es); applied to ${r.applied.merchants} merchants / ${r.applied.transactions} transactions; low confidence ${r.lowConfidence}; unknown ${r.unknown}; cached ${r.cached}`);
        for (const e of r.errors) console.error(`error: ${e}`);
      } finally {
        db.$client.close();
      }
    });

  ai.command('forget')
    .description('Forget cached model answers so merchants can be asked again (e.g. after changing model)')
    .action(() => {
      const db = openDb();
      try {
        console.log(`forgot ${clearAiSuggestions(db)} answers`);
      } finally {
        db.$client.close();
      }
    });
}

/**
 * `finc chat-eval [--model <id>] [--provider anthropic|openai|local] [--only id,id] [--json]` (chat v2 step 3): asks
 * the configured chat model the eval's questions about a FICTIONAL household built in memory (packages/core
 * src/ai/eval), and prints answered / correct / asked-instead / leaked. It never reads the live database's
 * transactions and writes nothing: without --provider it reads the AI settings (ai.provider / ai.chatModel, else
 * ai.model / ai.baseUrl) and closes the database again. The key comes from the vault only, as for `finc ai run` (the master password is
 * typed here; environment variables are never used). Costs a few cents per run (about 2-4 calls per case); never
 * automatic.
 */
import { AI_DEFAULTS, type AiConfig, type EvalCaseResult, type EvalSummary, Vault, buildEvalFixture, chatModelOf, createProvider, evalCases, getAiSettings, openDb, readAiSettingsReadOnly, runChatEval, vaultPath } from '@finc/core';
import type { Command } from 'commander';
import { keyFor } from './ai.js';

type ProviderName = 'anthropic' | 'openai' | 'local';
const PROVIDERS: readonly ProviderName[] = ['anthropic', 'openai', 'local'];

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** One line of an answer for the table: no newlines, no direction marks. */
const oneLine = (s: string): string => s.replace(/[‎‏؜‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();

/** The compact result table. */
export function formatEvalTable(results: EvalCaseResult[]): string[] {
  const idW = Math.max(4, ...results.map((r) => r.id.length));
  const lines = [`${'case'.padEnd(idW)}  lang  want    got     ok  leak  rnd  ${'ms'.padStart(6)}  tools / answer`];
  for (const r of results) {
    const ok = r.correct ? 'yes' : 'NO';
    const tools = r.tools.length ? r.tools.join('+') : '-';
    const why = r.error ? `error: ${r.error}` : r.correct ? '' : [r.missing.length ? `missing ${r.missing.join(', ')}` : '', r.missingInclude.length ? 'missing a name/date' : '', r.unwanted.length ? `wording: ${r.unwanted.join(', ')}` : '', r.leaks.length ? `leak: ${r.leaks.join(', ')}` : ''].filter(Boolean).join('; ');
    lines.push(`${r.id.padEnd(idW)}  ${r.lang.padEnd(4)}  ${r.modeExpected.padEnd(6)}  ${r.modeGot.padEnd(6)}  ${ok.padEnd(3)} ${(r.leaked ? 'YES' : '-').padEnd(4)}  ${String(r.rounds).padStart(3)}  ${String(r.ms).padStart(6)}  ${cut(tools, 40)}${why ? `  [${why}]` : ''}`);
    lines.push(`${' '.repeat(idW + 2)}  ${cut(oneLine(r.answer), 110)}`);
  }
  return lines;
}

export function formatEvalSummary(s: EvalSummary): string {
  return `${s.provider}/${s.model}: ${s.cases} cases · answered ${s.answered} · correct ${s.correct} · asked instead ${s.askedInstead} · leaked ${s.leaked} · errors ${s.errors} · avg rounds ${s.avgRounds} · avg ${s.avgMs} ms · ${s.calls} calls`;
}

export function registerChatEvalCommands(program: Command): void {
  program
    .command('chat-eval')
    .description('Quality check of "ask my money": fixed questions about a fictional household, sent to the configured model (fixture data only, costs a few cents)')
    .option('--provider <p>', 'anthropic|openai|local (default: the configured one)')
    .option('--model <id>', 'model id (default: the configured chat model, else the provider default)')
    .option('--only <ids>', 'comma-separated case ids')
    .option('--json', 'print the results as JSON', false)
    .action(async (opts: { provider?: string; model?: string; only?: string; json: boolean }) => {
      if (opts.provider !== undefined && !(PROVIDERS as readonly string[]).includes(opts.provider)) throw new Error('--provider must be anthropic|openai|local');
      // the configured settings, read only; with --provider the live database is not opened at all
      let provider = opts.provider as ProviderName | undefined;
      let model = opts.model;
      let baseUrl: string | undefined;
      if (!provider) {
        // a read-only connection when possible (no migration, no claim, no write); else open and close at once
        let s = readAiSettingsReadOnly();
        if (!s) {
          const db = openDb();
          try {
            s = getAiSettings(db);
          } finally {
            db.$client.close();
          }
        }
        if (!s.provider) throw new Error('no provider configured: finc ai config --provider local|anthropic|openai, or pass --provider');
        provider = s.provider;
        // the model the chat itself uses (ai.chatModel when set, else ai.model); --model still wins
        model ??= chatModelOf(s) ?? undefined;
        baseUrl = s.baseUrl ?? undefined;
      }
      const only = opts.only ? opts.only.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
      const fixture = buildEvalFixture();
      const all = evalCases(fixture);
      const ids = new Set(all.map((c) => c.id));
      const unknown = (only ?? []).filter((id) => !ids.has(id));
      if (unknown.length) throw new Error(`unknown case id(s): ${unknown.join(', ')}; known: ${[...ids].join(', ')}`);
      // the key: the vault only, like the chat route; a vault that cannot be opened here is a clear refusal
      if (provider !== 'local') {
        if (!Vault.exists(vaultPath())) throw new Error(`the vault is missing: finc vault init, then finc vault set ai_${provider}`);
        if (!process.stdin.isTTY) throw new Error(`the vault is locked: chat-eval needs the master password typed at an interactive terminal to read ai_${provider} (keys never come from the environment)`);
      }
      const key = await keyFor(provider);
      const cfg: AiConfig = { provider, model: model ?? AI_DEFAULTS[provider].model, ...(baseUrl ? { baseUrl } : {}), ...(key ? { apiKey: key.key } : {}) };
      const ai = createProvider(cfg);
      const cases = only?.length ?? ids.size;
      const out = opts.json ? console.error : console.log;
      out('chat-eval sends FIXTURE data only: a fictional household built in memory; no real data leaves this PC and the live database is not read.');
      out(`provider ${ai.name} model ${ai.model}${key ? `; key from ${key.source}` : ''}; ${cases} case${cases === 1 ? '' : 's'} (about 2-4 calls each)`);
      const { results, summary } = await runChatEval(ai, {
        db: fixture,
        cases: all,
        ...(only ? { only } : {}),
        onCase: (r) => {
          if (!opts.json) process.stdout.write(`${r.correct ? '.' : r.leaked ? 'L' : r.askedInstead ? '?' : r.modeGot === 'error' ? 'E' : 'x'}`);
        },
      });
      // a leak fails the run (exit code 2), with --json too
      if (summary.leaked) process.exitCode = 2;
      if (opts.json) {
        console.log(JSON.stringify({ summary, results }, null, 1));
        return;
      }
      process.stdout.write('\n');
      for (const l of formatEvalTable(results)) console.log(l);
      console.log(formatEvalSummary(summary));
    });
}

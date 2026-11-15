import { confirm, input, password } from '@inquirer/prompts';
import { INSTITUTIONS, Vault, VaultError, institutionSpec, maskNumber, vaultPath } from '@finc/core';
import type { Command } from 'commander';
import { isAlarmBotToken } from '../alarm.js';

function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new Error('vault commands need an interactive terminal (credentials are typed, never piped)');
  }
}

export async function askMasterPassword(message = 'Master password'): Promise<string> {
  requireTty();
  return password({ message, mask: '*' });
}

/** Open the vault, asking for the master password. Exits with a clear message on a bad password. */
export async function openVaultInteractive(): Promise<Vault> {
  const file = vaultPath();
  if (!Vault.exists(file)) {
    throw new Error(`no vault yet at ${file}. Run: finc vault init`);
  }
  const pw = await askMasterPassword();
  try {
    return await Vault.open(file, pw);
  } catch (e) {
    if (e instanceof VaultError && e.code === 'BAD_PASSWORD') throw new Error('wrong master password');
    throw e;
  }
}

/** Non-institution entries the app knows how to read, so `vault set` asks for exactly the field it needs. */
const KNOWN_GENERIC: Record<string, { label: string; key: string; pattern?: RegExp; hint?: string }> = {
  ai_openai: { label: 'OpenAI API key', key: 'apiKey', pattern: /^sk-[A-Za-z0-9_-]{20,}$/, hint: 'starts with sk-' },
  ai_anthropic: { label: 'Anthropic API key', key: 'apiKey', pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: 'starts with sk-ant-' },
  telegram: { label: 'Telegram bot token', key: 'token', pattern: /^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/, hint: 'digits:letters, from BotFather' },
  finnhub: { label: 'Finnhub API key', key: 'apiKey', pattern: /^[A-Za-z0-9]{16,64}$/, hint: 'from finnhub.io → Dashboard' },
};

/**
 * A value that must not be stored even though it looks right. The main Telegram bot must never be the alarm bot
 * (P1-05): its token would then sit outside the vault. Read straight from data/alarm-bot.json, which this CLI shares
 * with the worker (same data folder, inside the container or not); only the bot ids are compared.
 */
export function vaultValueProblem(name: string, value: string): string | null {
  if (name === 'telegram' && isAlarmBotToken(value)) return 'that is the alarm bot (finc alerts alarm); the main bot must be a different bot';
  return null;
}

async function promptFields(name: string): Promise<{ kind: 'scraper' | 'token' | 'generic'; fields: Record<string, string> }> {
  const spec = institutionSpec(name);
  const fields: Record<string, string> = {};
  const known = KNOWN_GENERIC[name];
  if (known) {
    console.log(`\n${name}: one field (${known.key}). The value is hidden and stored encrypted.\n`);
    for (;;) {
      const v = (await password({ message: `${known.label} (${known.hint})`, mask: '*' })).trim();
      if (!v) {
        console.log('  value required');
        continue;
      }
      if (known.pattern && !known.pattern.test(v)) {
        console.log(`  does not look like an ${known.label} (${known.hint}); try again`);
        continue;
      }
      const problem = vaultValueProblem(name, v);
      if (problem) {
        console.log(`  ${problem}; try again`);
        continue;
      }
      fields[known.key] = v;
      break;
    }
    return { kind: 'generic', fields };
  }
  if (spec) {
    console.log(`\n${spec.displayName}: ${spec.fields.length} field(s). Values are hidden and stored encrypted.\n`);
    for (const f of spec.fields) {
      for (;;) {
        const msg = f.hint ? `${f.label} (${f.hint})` : f.label;
        const v = (f.secret ? await password({ message: msg, mask: '*' }) : await input({ message: msg })).trim();
        if (!v) {
          console.log('  value required');
          continue;
        }
        if (f.pattern && !f.pattern.test(v)) {
          console.log(`  does not look right${f.hint ? ` (expected: ${f.hint})` : ''}; try again`);
          continue;
        }
        fields[f.key] = v;
        break;
      }
    }
    return { kind: spec.kind === 'aggregator' ? 'token' : 'scraper', fields };
  }
  console.log(`\n"${name}" is not a known institution; entering generic key/value pairs. Empty key to finish.\n`);
  for (;;) {
    const k = (await input({ message: 'field name' })).trim();
    if (!k) break;
    fields[k] = await password({ message: `value for ${k}`, mask: '*' });
  }
  if (Object.keys(fields).length === 0) throw new Error('no fields entered');
  return { kind: 'generic', fields };
}

export function registerVaultCommands(program: Command): void {
  const vault = program.command('vault').description('Encrypted local credential vault (Argon2id + XChaCha20-Poly1305)');

  vault
    .command('init')
    .description('Create the vault and choose a master password')
    .action(async () => {
      requireTty();
      const file = vaultPath();
      if (Vault.exists(file)) throw new Error(`vault already exists at ${file}`);
      console.log('Choose a master password. It is never stored; losing it means re-entering every credential.');
      const pw = await password({ message: 'Master password (min 8 chars)', mask: '*' });
      const again = await password({ message: 'Repeat', mask: '*' });
      if (pw !== again) throw new Error('passwords do not match');
      const t0 = Date.now();
      const v = await Vault.create(file, pw);
      v.lock();
      console.log(`Created ${file} (key derivation took ${Date.now() - t0} ms).`);
      console.log(`Next: finc vault set <${Object.keys(INSTITUTIONS).join('|')}>`);
    });

  vault
    .command('set <name>')
    .description('Add or replace credentials for an institution (beinleumi, isracard, max, riseup) or a generic entry')
    .action(async (name: string) => {
      const v = await openVaultInteractive();
      try {
        if (v.has(name)) {
          const ok = await confirm({ message: `"${name}" exists. Replace it?`, default: false });
          if (!ok) return;
        }
        const { kind, fields } = await promptFields(name);
        v.set(name, kind, fields);
        console.log(`Saved "${name}" (${Object.keys(fields).join(', ')}).`);
      } finally {
        v.lock();
      }
    });

  vault
    .command('list')
    .description('List entry names and field names (never values)')
    .action(async () => {
      const v = await openVaultInteractive();
      try {
        const rows = v.list();
        if (rows.length === 0) {
          console.log('(empty)');
          return;
        }
        for (const r of rows) console.log(`${r.name.padEnd(14)} ${r.kind.padEnd(8)} [${r.fields.join(', ')}]  updated ${r.updatedAt.slice(0, 16)}`);
      } finally {
        v.lock();
      }
    });

  vault
    .command('rm <name>')
    .description('Remove an entry')
    .action(async (name: string) => {
      const v = await openVaultInteractive();
      try {
        console.log(v.delete(name) ? `Removed "${name}".` : `No entry "${name}".`);
      } finally {
        v.lock();
      }
    });

  vault
    .command('passwd')
    .description('Change the master password')
    .action(async () => {
      const v = await openVaultInteractive();
      try {
        const pw = await password({ message: 'New master password (min 8 chars)', mask: '*' });
        const again = await password({ message: 'Repeat', mask: '*' });
        if (pw !== again) throw new Error('passwords do not match');
        await v.rekey(pw);
        console.log('Master password changed; vault re-encrypted.');
      } finally {
        v.lock();
      }
    });

  vault
    .command('check')
    .description('Unlock, verify each known institution has the fields its connector needs, lock')
    .action(async () => {
      const v = await openVaultInteractive();
      try {
        for (const spec of Object.values(INSTITUTIONS)) {
          const e = v.get(spec.id);
          if (!e) {
            console.log(`${spec.id.padEnd(11)} missing`);
            continue;
          }
          const missing = spec.fields.filter((f) => !e.fields[f.key]).map((f) => f.key);
          const extra = spec.id === 'isracard' && e.fields.card6Digits ? ` card ${maskNumber(e.fields.card6Digits, 2)}` : '';
          console.log(`${spec.id.padEnd(11)} ${missing.length ? `missing: ${missing.join(', ')}` : 'ok'}${extra}`);
        }
      } finally {
        v.lock();
      }
    });
}

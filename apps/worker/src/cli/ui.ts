import { clearPin, openDb, pinIsSet, recordSecurityEvent, setPin, validatePin } from '@finc/core';
import { password } from '@inquirer/prompts';
import type { Command } from 'commander';

export function registerUiCommands(program: Command): void {
  const ui = program.command('ui').description('The hub web app: PIN and where to open it');

  ui.command('pin')
    .description('Set or change the PIN that protects the hub (asked for when a browser first opens it)')
    .option('--clear', 'remove the PIN; the next browser to open the hub sets a new one', false)
    .action(async (opts: { clear: boolean }) => {
      if (!process.stdin.isTTY) throw new Error('the PIN is typed, never piped');
      const db = openDb();
      try {
        if (opts.clear) {
          clearPin(db);
          recordSecurityEvent(db, { kind: 'auth.pin_cleared', actor: 'cli' });
          console.log('PIN cleared. Every open browser session has ended; the next browser at home sets a new PIN.');
          return;
        }
        for (;;) {
          const pin = await password({ message: pinIsSet(db) ? 'New PIN' : 'Choose a PIN (6+ characters)', mask: '*' });
          const problem = validatePin(pin);
          if (problem) {
            console.log(`  ${problem}`);
            continue;
          }
          const again = await password({ message: 'Repeat the PIN', mask: '*' });
          if (again !== pin) {
            console.log('  the two do not match; try again');
            continue;
          }
          const had = pinIsSet(db);
          await setPin(db, pin);
          recordSecurityEvent(db, { kind: had ? 'auth.pin_changed' : 'auth.pin_set', actor: 'cli' });
          console.log('PIN saved (hashed); every open browser session has ended. Sign in again at http://127.0.0.1:' + (process.env.FINC_PORT ?? '7733'));
          return;
        }
      } finally {
        db.$client.close();
      }
    });

  ui.command('url')
    .description('Where the hub is served')
    .action(() => {
      console.log(`http://127.0.0.1:${process.env.FINC_PORT ?? '7733'}  (start the worker first: finc worker)`);
    });
}

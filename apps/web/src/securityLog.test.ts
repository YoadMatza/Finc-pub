import { describe, expect, it } from 'vitest';
import type { Key } from './i18n';
import { KNOWN_KINDS, SECURITY_FILTERS, absTime, actorLabel, filterEvents, filterLabelKey, formatActor, formatDetail, isRoutine, kindLabel, kindLabelKey, kindTone, matchesFilter, rawKindLabel, securityEventsPath } from './securityLog';
import type { SecurityEvent } from './types';

const t = (k: Key, vars?: Record<string, string>) => (vars ? `${k}(${Object.values(vars).join(',')})` : k);

describe('kind labels', () => {
  it('known (dotted) kinds map to their own i18n key', () => {
    expect(kindLabelKey('auth.pin_failed')).toBe('sec_k_auth_pin_failed');
    expect(kindLabel('vault.unlock_ok', t)).toBe('sec_k_vault_unlock_ok');
    expect(kindLabelKey('worker.db_owner_conflict')).toBe('sec_k_worker_db_owner_conflict');
  });
  it('every known kind is labelled in both languages', async () => {
    // i18n.tsx is TSX with React context; read the source and check both dictionaries carry every key
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8');
    for (const k of KNOWN_KINDS) expect(src.split(`  sec_k_${k.replaceAll('.', '_')}:`).length - 1, k).toBe(2);
  });
  it('unknown kinds fall back to the raw kind, readable', () => {
    expect(kindLabelKey('auth.something_new')).toBeNull();
    expect(kindLabelKey('auth_pin_ok')).toBeNull();
    expect(kindLabel('auth.something_new', t)).toBe('auth something new');
    expect(rawKindLabel('a.b:c-d')).toBe('a b c d');
    expect(rawKindLabel('___')).toBe('___');
  });
});

describe('kindTone', () => {
  it('failures, rejections and blocks are red', () => {
    for (const k of ['auth.pin_failed', 'auth.pin_locked', 'auth.refused_untrusted', 'passkey.login_failed', 'passkey.enrol_failed', 'device.pair_failed', 'device.token_rejected', 'vault.unlock_failed', 'lockdown.wrong_code', 'lockdown.blocked', 'worker.db_owner_conflict', 'backup.failed', 'backup.offsite_failed', 'backup.offsite_hostkey_changed']) expect(kindTone(k), k).toBe('neg');
  });
  it('notable changes are amber', () => {
    for (const k of ['device.expired', 'device.expiry_warning', 'lockdown.run', 'lockdown.requested', 'device.removed', 'passkey.removed', 'alarm.removed', 'settings.changed', 'alerts.settings_changed', 'auth.pin_changed', 'backup.stale', 'backup.offsite_stale', 'backup.shrank', 'tls.state_changed', 'backup.offsite_set', 'backup.offsite_removed', 'backup.restored']) expect(kindTone(k), k).toBe('warn');
  });
  it('the rest is plain', () => {
    for (const k of ['auth.pin_ok', 'auth.pin_set', 'auth.logout', 'passkey.login_ok', 'passkey.enrolled', 'device.paired', 'device.renamed', 'device.pairing_code_created', 'vault.unlock_ok', 'vault.lock', 'worker.started', 'alarm.set_up', 'alerts.chat_bound', 'sync.waiting_for_unlock', 'device.used', 'passkey.used']) expect(kindTone(k), k).toBe('normal');
  });
});

describe('actors', () => {
  it('fixed actors', () => {
    expect(actorLabel('pc', null)).toEqual({ key: 'sec_actor_pc' });
    expect(actorLabel('control', null)).toEqual({ key: 'sec_actor_control' });
    expect(actorLabel('telegram', null)).toEqual({ key: 'sec_actor_telegram' });
    expect(actorLabel('cli', null)).toEqual({ key: 'sec_actor_cli' });
    expect(actorLabel('public', null)).toEqual({ key: 'sec_actor_public' });
    expect(actorLabel('system', null)).toEqual({ key: 'sec_actor_system' });
  });
  it('devices and passkeys carry their name, else their id', () => {
    expect(actorLabel('device:7', 'Pixel 9')).toEqual({ key: 'sec_actor_device', name: 'Pixel 9' });
    expect(actorLabel('device:7', null)).toEqual({ key: 'sec_actor_device', name: '#7' });
    expect(actorLabel('device', '  ')).toEqual({ key: 'sec_actor_device_anon' });
    expect(actorLabel('passkey:3', 'Edge')).toEqual({ key: 'sec_actor_passkey', name: 'Edge' });
    expect(actorLabel('passkey:', null)).toEqual({ key: 'sec_actor_passkey_anon' });
  });
  it('unknown actors show raw', () => {
    expect(actorLabel('robot:1', null)).toEqual({ raw: 'robot:1' });
    expect(formatActor('robot', 'R2', t)).toBe('robot (R2)');
  });
  it('formatActor fills the name in', () => {
    expect(formatActor('device:7', 'Pixel', t)).toBe('sec_actor_device(Pixel)');
    expect(formatActor('pc', null, t)).toBe('sec_actor_pc');
  });
});

describe('filters', () => {
  const groups = {
    signin: ['auth.pin_ok', 'auth.pin_failed', 'auth.pin_locked', 'auth.pin_set', 'auth.pin_changed', 'auth.pin_cleared', 'auth.logout', 'auth.refused_untrusted', 'passkey.login_ok', 'passkey.login_failed'],
    devices: ['passkey.enrol_code_created', 'passkey.enrolled', 'passkey.enrol_failed', 'passkey.removed', 'device.pairing_code_created', 'device.paired', 'device.pair_failed', 'device.renamed', 'device.removed', 'device.expired', 'device.expiry_warning', 'device.token_rejected', 'device.used', 'passkey.used'],
    vault: ['vault.unlock_ok', 'vault.unlock_failed', 'vault.lock'],
    lockdown: ['lockdown.run', 'lockdown.requested', 'lockdown.wrong_code', 'lockdown.blocked'],
  } as const;
  const other = ['settings.changed', 'alerts.settings_changed', 'alerts.chat_code_created', 'alerts.chat_bound', 'alarm.set_up', 'alarm.removed', 'tls.state_changed', 'worker.started', 'worker.db_owner_conflict', 'backup.failed', 'backup.shrank', 'backup.stale', 'backup.offsite_failed', 'backup.offsite_stale', 'sync.waiting_for_unlock', 'backup.offsite_set', 'backup.offsite_removed', 'backup.offsite_hostkey_changed', 'backup.restored', 'http.body_too_large'];
  const kinds = [...KNOWN_KINDS];
  it('the known kinds are exactly the groups plus the other ones', () => {
    expect([...Object.values(groups).flat(), ...other].sort()).toEqual([...kinds].sort());
  });
  it('every chip has a label key', () => {
    expect(SECURITY_FILTERS.map(filterLabelKey)).toEqual(['sec_filter_all', 'sec_filter_signin', 'sec_filter_devices', 'sec_filter_vault', 'sec_filter_lockdown']);
  });
  it('all shows everything', () => expect(kinds.filter((k) => matchesFilter(k, 'all'))).toEqual(kinds));
  for (const [f, list] of Object.entries(groups)) {
    it(`${f} is exactly its group`, () => expect(kinds.filter((k) => matchesFilter(k, f as keyof typeof groups)).sort()).toEqual([...list].sort()));
  }
  it('the other kinds show under All only', () => {
    for (const k of other) for (const f of ['signin', 'devices', 'vault', 'lockdown'] as const) expect(matchesFilter(k, f), `${k} ${f}`).toBe(false);
  });
  it('new kinds of a known family land in the right group', () => {
    expect(matchesFilter('vault.rekeyed', 'vault')).toBe(true);
    expect(matchesFilter('device.something', 'devices')).toBe(true);
    expect(matchesFilter('auth.something', 'signin')).toBe(true);
    expect(matchesFilter('passkey.login_blocked', 'signin')).toBe(true);
  });
  it('filterEvents keeps order', () => {
    const ev = (id: number, kind: string): SecurityEvent => ({ id, at: '2026-11-11T10:00:00Z', kind, actor: 'pc', actorName: null, address: null, detail: null });
    const list = [ev(3, 'vault.lock'), ev(2, 'auth.pin_ok'), ev(1, 'vault.unlock_ok')];
    expect(filterEvents(list, 'vault').map((e) => e.id)).toEqual([3, 1]);
    expect(filterEvents(list, 'all')).toBe(list);
  });
});

describe('isRoutine', () => {
  it('only the *.used rows are routine', () => {
    expect(isRoutine('device.used')).toBe(true);
    expect(isRoutine('passkey.used')).toBe(true);
    expect(isRoutine('device.paired')).toBe(false);
    expect(isRoutine('auth.pin_ok')).toBe(false);
  });
});

describe('formatDetail', () => {
  it('device.used: what changed reads in words', () => {
    expect(formatDetail('{"changed":["address","agent"]}', t)).toBe('sec_changed_address, sec_changed_agent');
    expect(formatDetail('{"changed":["address"],"repeats":2}', t)).toBe('×2 · sec_changed_address');
    // without a translator, or with other values, it stays key: value
    expect(formatDetail('{"changed":["address"]}')).toBe('changed: address');
    expect(formatDetail('{"changed":["publicUrl"]}', t)).toBe('changed: publicUrl');
  });
  it('settings.changed with URL values', () => {
    expect(formatDetail('{"keys":["publicUrl","aiBaseUrl"],"publicUrl":"https://finc-example.example:7443","aiBaseUrl":"http://host.docker.internal:11434/v1"}', t)).toBe('keys: publicUrl, aiBaseUrl · publicUrl: https://finc-example.example:7443 · aiBaseUrl: http://host.docker.internal:11434/v1');
  });

  it('plain text stays as it is', () => {
    expect(formatDetail('vault opened from the CLI')).toBe('vault opened from the CLI');
    expect(formatDetail(null)).toBeNull();
    expect(formatDetail('  ')).toBeNull();
    expect(formatDetail('{not json')).toBe('{not json');
  });
  it('repeats read as ×n, first', () => {
    expect(formatDetail('{"repeats": 5}')).toBe('×5');
    expect(formatDetail('{"reason":"bad_code","repeats":3}')).toBe('×3 · reason: bad_code');
  });
  it('objects read as key: value, arrays joined', () => {
    expect(formatDetail('{"keys":["language","deviceIdleDays"]}')).toBe('keys: language, deviceIdleDays');
    expect(formatDetail('{"old_state":"ok","new_state":"expiring","days":12,"none":null}')).toBe('old state: ok · new state: expiring · days: 12');
    expect(formatDetail('{"nested":{"a":1}}')).toBe('nested: {"a":1}');
    expect(formatDetail('["a","b"]')).toBe('a, b');
    expect(formatDetail('{}')).toBeNull();
  });
});

describe('paging and time', () => {
  it('builds the page path', () => {
    expect(securityEventsPath(null)).toBe('/api/security-events?limit=30');
    expect(securityEventsPath(120)).toBe('/api/security-events?limit=30&before=120');
  });
  it('shows absolute time in Israel time', () => {
    // 2026-11-11 is winter time: UTC+2
    expect(absTime('2026-11-11T12:05:09Z', 'en-GB')).toBe('11/11/2026, 14:05:09');
    // summer time: UTC+3
    expect(absTime('2026-07-01T00:30:00Z', 'en-GB')).toBe('01/07/2026, 03:30:00');
    expect(absTime('not a date', 'en-GB')).toBe('not a date');
  });
});

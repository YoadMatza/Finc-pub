import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- the native plugins, mocked: FincVault (registerPlugin) and the legacy secure storage ----
const plugin = vi.hoisted(() => ({
  status: vi.fn(),
  store: vi.fn(),
  storePairing: vi.fn(),
  load: vi.fn(),
  lock: vi.fn(),
  clear: vi.fn(),
  request: vi.fn(),
  pair: vi.fn(),
  awayMs: vi.fn(),
  uncover: vi.fn(),
  clearWebCache: vi.fn(),
  pinnedHost: vi.fn(),
}));
const legacy = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), keys: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: (name: string) => {
    if (name !== 'FincVault') throw new Error(`unexpected plugin ${name}`);
    return plugin;
  },
}));
vi.mock('@aparajita/capacitor-secure-storage', () => ({ SecureStorage: legacy }));

const { getServer, setServer } = await import('./api');
const { bootScreen, forgetSession, storeFailureMessage, unlockOutcome } = await import('./lockflow');
const { awayMs, clearWebCache, forgetPairing, hasLegacyServer, hubPolicy, keepPairing, lockVault, uncover, unlockServer, vaultStatus } = await import('./native');

const TOKEN = 'tok-123';
/** the legacy (pre-vault) copy: the only place a token exists on the JS side, read once to migrate it */
const LEGACY = { url: 'https://hub.example', token: TOKEN, deviceName: 'Pixel' };
/** what JS gets from an unlock: never the token (P2-01) */
const SERVER = { url: 'https://hub.example', deviceName: 'Pixel' };
const loaded = (o: Partial<{ url: string; deviceName: string }> = {}) => ({ ok: true, ...SERVER, ...o });
const noToken = (v: unknown) => expect(JSON.stringify(v ?? null)).not.toContain(TOKEN);
const TEXTS = { title: 'finc is locked', subtitle: 'confirm', migrateSubtitle: 'move once' };
const status = (o: Partial<{ deviceSecure: boolean; strongBiometrics: boolean; hasSecret: boolean }>) => ({ deviceSecure: true, strongBiometrics: true, hasSecret: false, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  legacy.get.mockResolvedValue(null);
  legacy.keys.mockResolvedValue([]);
  legacy.remove.mockResolvedValue(true);
  plugin.clear.mockResolvedValue({ ok: true });
  plugin.lock.mockResolvedValue({ ok: true });
  // a release build pinned to the test hub's host (P1-10)
  plugin.pinnedHost.mockResolvedValue({ host: 'hub.example', enforce: true });
});

describe('boot decision', () => {
  it('no screen lock: refuse to run, whatever is stored', () => {
    expect(bootScreen(status({ deviceSecure: false, hasSecret: true }), true)).toBe('nolock');
  });
  it('a vault secret, or a legacy pairing to migrate: the lock screen', () => {
    expect(bootScreen(status({ hasSecret: true }), false)).toBe('lock');
    expect(bootScreen(status({ hasSecret: false }), true)).toBe('lock');
  });
  it('nothing stored: pair', () => {
    expect(bootScreen(status({}), false)).toBe('pair');
  });
  it('the plugin did not answer (old APK): its own screen, never the app', () => {
    expect(bootScreen(null, true)).toBe('novault');
  });

  it('boot reads only the status: no prompt, no token', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    const st = await vaultStatus();
    expect(st?.hasSecret).toBe(true);
    expect(plugin.load).not.toHaveBeenCalled();
    expect(plugin.store).not.toHaveBeenCalled();
  });
  it('vaultStatus answers null when the plugin throws', async () => {
    plugin.status.mockRejectedValue(new Error('not implemented'));
    expect(await vaultStatus()).toBeNull();
  });
  it('hasLegacyServer checks the key list only: the value (the token) is never read', async () => {
    legacy.keys.mockResolvedValue(['other', 'finc.server']);
    expect(await hasLegacyServer()).toBe(true);
    legacy.keys.mockResolvedValue(['other']);
    expect(await hasLegacyServer()).toBe(false);
    legacy.keys.mockRejectedValue(new Error('keystore'));
    expect(await hasLegacyServer()).toBe(false);
    expect(legacy.get).not.toHaveBeenCalled();
  });
});

describe('unlockServer', () => {
  it('unlocks natively behind the prompt: JS gets the url and name, never the token', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockResolvedValue(loaded());
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ server: SERVER });
    noToken(r);
    expect(plugin.load).toHaveBeenCalledWith({ title: TEXTS.title, subtitle: TEXTS.subtitle });
    expect(plugin.lock).not.toHaveBeenCalled();
  });

  it('a stray token in the native answer is not passed on', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockResolvedValue({ ...loaded(), token: TOKEN, value: JSON.stringify(LEGACY) });
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ server: SERVER });
    noToken(r);
  });

  it('migrates a legacy pairing: one store prompt, then the legacy entry is deleted', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: false }));
    legacy.get.mockResolvedValue({ ...LEGACY });
    plugin.store.mockResolvedValue({ ok: true });
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ server: SERVER });
    noToken(r); // the legacy token goes into native (the store), not back to the app
    expect(legacy.get.mock.invocationCallOrder[0]).toBeLessThan(plugin.store.mock.invocationCallOrder[0]!);
    expect(plugin.store).toHaveBeenCalledTimes(1);
    expect(plugin.store.mock.calls[0]?.[0]).toEqual({ title: TEXTS.title, subtitle: TEXTS.migrateSubtitle, value: JSON.stringify(LEGACY) });
    expect(plugin.load).not.toHaveBeenCalled();
    expect(legacy.remove).toHaveBeenCalledWith('finc.server');
    // the store came before the delete
    expect(plugin.store.mock.invocationCallOrder[0]).toBeLessThan(legacy.remove.mock.invocationCallOrder[0]!);
  });

  it('a cancelled migration keeps the legacy entry and stays locked', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: false }));
    legacy.get.mockResolvedValue({ ...LEGACY });
    plugin.store.mockResolvedValue({ ok: false, reason: 'cancelled' });
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'cancelled' });
    expect(legacy.remove).not.toHaveBeenCalled();
    expect(unlockOutcome(r)).toEqual({ kind: 'retry', message: 'lock_cancelled' });
  });

  it('no secret and no legacy entry: none (go pair)', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: false }));
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'none' });
    expect(unlockOutcome(r)).toEqual({ kind: 'pair', message: null });
  });

  it('no screen lock: no prompt at all, and no "unlocked" fallback', async () => {
    plugin.status.mockResolvedValue(status({ deviceSecure: false, hasSecret: true }));
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'no-lock' });
    expect(plugin.load).not.toHaveBeenCalled();
    expect(unlockOutcome(r)).toEqual({ kind: 'nolock' });
  });

  it('invalidated (new fingerprint enrolled): pair again, with the message', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockResolvedValue({ ok: false, reason: 'invalidated' });
    const r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'invalidated' });
    expect(unlockOutcome(r)).toEqual({ kind: 'pair', message: 'lock_invalidated' });
  });

  it('cancelled prompt: stays locked with a retry', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockResolvedValue({ ok: false, reason: 'cancelled' });
    expect(unlockOutcome(await unlockServer(TEXTS))).toEqual({ kind: 'retry', message: 'lock_cancelled' });
  });

  it('a plugin error or a nonsense answer fails closed (and relocks native)', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockRejectedValue(new Error('boom'));
    expect(unlockOutcome(await unlockServer(TEXTS))).toEqual({ kind: 'retry', message: 'lock_failed' });
    plugin.load.mockResolvedValue({ ok: true, url: 1 });
    expect(await unlockServer(TEXTS)).toEqual({ reason: 'failed' });
    expect(plugin.lock).toHaveBeenCalledTimes(1);
    plugin.load.mockResolvedValue({ value: JSON.stringify(LEGACY) }); // the old answer shape is not an unlock
    expect(await unlockServer(TEXTS)).toEqual({ reason: 'failed' });
  });
});

describe('keepPairing / forgetPairing', () => {
  it('the natively redeemed pairing goes into the vault behind the prompt: no token, no url from JS', async () => {
    plugin.storePairing.mockResolvedValue({ ok: true, ...SERVER });
    expect(await keepPairing({ title: 'Save', subtitle: 'confirm' })).toEqual({ ok: true });
    expect(plugin.storePairing).toHaveBeenCalledWith({ title: 'Save', subtitle: 'confirm' });
    expect(plugin.store).not.toHaveBeenCalled();
    expect(legacy.remove).toHaveBeenCalled();
  });
  it('a cancelled store is not a pairing', async () => {
    plugin.storePairing.mockResolvedValue({ ok: false, reason: 'cancelled' });
    const r = await keepPairing();
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
    expect(storeFailureMessage(r.reason)).toBe('pair_store_cancelled');
    expect(storeFailureMessage('no-lock')).toBe('nolock_help');
    expect(storeFailureMessage(undefined)).toBe('pair_store_failed');
  });
  it('a plugin error is a failed store', async () => {
    plugin.storePairing.mockRejectedValue(new Error('x'));
    expect(await keepPairing()).toEqual({ ok: false, reason: 'failed' });
    expect(legacy.remove).not.toHaveBeenCalled();
  });
  it('unpair / revoked / "Forget this pairing": clear() and the legacy key', async () => {
    await forgetPairing();
    expect(plugin.clear).toHaveBeenCalledTimes(1);
    expect(legacy.remove).toHaveBeenCalledWith('finc.server');
  });
});

describe('pinned hub host (security research P1-10)', () => {
  const OTHER = { ...LEGACY, url: 'https://evil.example:7443' };

  it('hubPolicy passes the native answer through and fails closed when the plugin cannot answer', async () => {
    expect(await hubPolicy()).toEqual({ host: 'hub.example', enforce: true });
    plugin.pinnedHost.mockResolvedValue({ host: ' Hub.Example ', enforce: false });
    expect(await hubPolicy()).toEqual({ host: 'hub.example', enforce: false });
    plugin.pinnedHost.mockRejectedValue(new Error('not implemented'));
    expect(await hubPolicy()).toEqual({ host: null, enforce: true });
    plugin.pinnedHost.mockResolvedValue({});
    expect(await hubPolicy()).toEqual({ host: null, enforce: true });
  });

  it('a vault pairing to another host is refused but KEPT (re-pairing is home-only): stay on the lock screen', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    plugin.load.mockResolvedValue({ ok: false, reason: 'wrong-host' }); // native refuses it
    let r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'wrong-host' });
    expect(unlockOutcome(r)).toEqual({ kind: 'retry', message: 'lock_wrong_host' });
    // and if native let it through, the JS check refuses it and relocks native
    plugin.load.mockResolvedValue(loaded({ url: OTHER.url }));
    r = await unlockServer(TEXTS);
    expect(r).toEqual({ reason: 'wrong-host' });
    expect(plugin.lock).toHaveBeenCalledTimes(1);
    expect(plugin.clear).not.toHaveBeenCalled();
    expect(legacy.remove).not.toHaveBeenCalled();
  });

  it('the built-in host on any port is used', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: true }));
    const onPort = { ...SERVER, url: 'https://hub.example:7443' };
    plugin.load.mockResolvedValue(loaded(onPort));
    expect(await unlockServer(TEXTS)).toEqual({ server: onPort });
  });

  it('a legacy pairing to another host is never moved into the vault', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: false }));
    legacy.get.mockResolvedValue({ ...OTHER });
    expect(await unlockServer(TEXTS)).toEqual({ reason: 'wrong-host' });
    expect(plugin.store).not.toHaveBeenCalled();
    expect(legacy.remove).not.toHaveBeenCalled();
  });

  it('a debug build migrates a legacy pairing to another https host', async () => {
    plugin.status.mockResolvedValue(status({ hasSecret: false }));
    legacy.get.mockResolvedValue({ ...OTHER });
    plugin.pinnedHost.mockResolvedValue({ host: 'hub.example', enforce: false });
    plugin.store.mockResolvedValue({ ok: true });
    expect(await unlockServer(TEXTS)).toEqual({ server: { url: OTHER.url, deviceName: OTHER.deviceName } });
  });

  it('the native refusal of a just-paired hub comes through as wrong-host', async () => {
    plugin.storePairing.mockResolvedValue({ ok: false, reason: 'wrong-host' });
    const r = await keepPairing();
    expect(r).toEqual({ ok: false, reason: 'wrong-host' });
    expect(storeFailureMessage(r.reason)).toBe('pair_wrong_host_any');
  });
});

describe('native timer and covers', () => {
  it('awayMs passes the native value and epoch through', async () => {
    plugin.awayMs.mockResolvedValue({ ms: 31_000, epoch: 4 });
    expect(await awayMs()).toEqual({ ms: 31_000, epoch: 4 });
    plugin.awayMs.mockResolvedValue({ ms: 0 });
    expect(await awayMs()).toEqual({ ms: 0 });
  });
  it('awayMs fails closed: an error or a nonsense value counts as a long absence', async () => {
    plugin.awayMs.mockRejectedValue(new Error('not implemented'));
    expect((await awayMs()).ms).toBe(Number.POSITIVE_INFINITY);
    plugin.awayMs.mockResolvedValue({ ms: -5, epoch: 1 });
    expect(await awayMs()).toEqual({ ms: Number.POSITIVE_INFINITY, epoch: 1 });
  });
  it('uncover passes the epoch to the plugin, reports a refusal, and never throws', async () => {
    plugin.uncover.mockResolvedValue({ ok: true });
    expect(await uncover(12)).toBe(true);
    expect(plugin.uncover).toHaveBeenLastCalledWith({ epoch: 12 });
    expect(await uncover()).toBe(true); // after an unlock or pairing: no epoch
    expect(plugin.uncover).toHaveBeenLastCalledWith({});
    plugin.uncover.mockResolvedValue({ ok: false });
    expect(await uncover(13)).toBe(false);
    plugin.uncover.mockRejectedValue(new Error('x'));
    expect(await uncover(14)).toBe(false);
  });
  it('clearWebCache calls the plugin and never throws', async () => {
    plugin.clearWebCache.mockRejectedValue(new Error('x'));
    await expect(clearWebCache()).resolves.toBeUndefined();
    expect(plugin.clearWebCache).toHaveBeenCalledTimes(1);
  });
});

describe('forgetSession (relock)', () => {
  it('drops the hub from JS memory, empties the React Query cache, and drops the native session (P2-01)', () => {
    const qc = new QueryClient();
    qc.setQueryData(['hub'], { balance: 1234 });
    setServer({ url: SERVER.url });
    forgetSession(qc);
    expect(getServer()).toBeNull();
    expect(qc.getQueryData(['hub'])).toBeUndefined();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
    expect(plugin.lock).toHaveBeenCalledTimes(1);
    expect(plugin.clear).not.toHaveBeenCalled(); // the pairing stays in the vault
  });

  it('lockVault never throws', async () => {
    plugin.lock.mockRejectedValue(new Error('x'));
    await expect(lockVault()).resolves.toBeUndefined();
  });
});

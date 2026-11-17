import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { api, getServer, loadBrowserDevice, onLocked, onUnauthorized, saveBrowserDevice, setServer } from './api';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { VaultBanner } from './components/VaultBanner';
import { useI18n } from './i18n';
import { bootScreen, forgetSession, type BootScreen, type UnlockOutcome } from './lockflow';
import { awayMs, clearWebCache, forgetPairing, hasLegacyServer, isNative, onAppState, uncover, vaultStatus, type PairedServer } from './native';
import { Accounts } from './pages/Accounts';
import { Alerts } from './pages/Alerts';
import { Categories } from './pages/Categories';
import { Trends } from './pages/Trends';
import { Events } from './pages/Events';
import { Chat } from './pages/Chat';
import { Connect } from './pages/Connect';
import { Hub } from './pages/Hub';
import { Lock } from './pages/Lock';
import { Login } from './pages/Login';
import { Pair } from './pages/Pair';
import { PasskeyEnroll } from './pages/PasskeyEnroll';
import { PairInfo } from './pages/PairInfo';
import { Recurring } from './pages/Recurring';
import { Settings } from './pages/Settings';
import { StockRules } from './pages/StockRules';
import { Transactions } from './pages/Transactions';
import { NoLock } from './pages/NoLock';
import { activeController } from './relock';
import type { PasskeysInfo } from './types';

interface AuthStatus {
  pinSet: boolean;
  authenticated: boolean;
  trusted: boolean;
  via: 'session' | 'token' | 'device' | 'passkey' | 'none';
  device: { id: number; name: string } | null;
  /** Only when a device token was sent: 'ok', or why the worker refused it. Absent from workers before 2026-11-10. */
  deviceStatus?: 'ok' | 'revoked' | 'unknown';
  /** Passkey sign-in: set up (public address + at least one passkey) and the host it is bound to. Absent from older workers. */
  passkeys?: PasskeysInfo;
}

/**
 * The phone forgets its pairing only when the worker says the token itself is gone (security research P0-03):
 * never on a throttled request, a network error, or a 401 from some other call.
 */
const tokenGone = (s: AuthStatus): boolean => !s.authenticated && s.deviceStatus !== 'ok';

/**
 * Browser: the hub is same-origin, a PIN opens a cookie session.
 * Android app: first pair (QR), then a fingerprint lock, then the same screens over the device token.
 * The token lives in the FincVault (Keystore key that needs authentication per use, security research P1-11):
 * the lock screen has native code decrypt it into native memory, and it never reaches JS (P2-01); setServer
 * gets only the hub's url after a successful unlock.
 */
// A browser paired away from home: its device token rides on every call from the first render.
if (!isNative) {
  const d = loadBrowserDevice();
  if (d) setServer({ url: '', token: d.token });
}

export function App() {
  const location = useLocation();
  const { t } = useI18n();
  const qc = useQueryClient();
  const [boot, setBootState] = useState<'loading' | BootScreen | 'ready'>(isNative ? 'loading' : 'ready');
  const [pairMessage, setPairMessage] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [covered, setCovered] = useState(false);
  // updated with the state, not on render, so an 'active' event right after an unlock sees 'ready'
  const bootRef = useRef(boot);
  const setBoot = useCallback((b: typeof boot) => {
    bootRef.current = b;
    setBootState(b);
  }, []);

  /** Decide the first screen from the vault status alone: no secret is read here. */
  const decide = useCallback(async () => {
    setBoot('loading');
    const st = await vaultStatus();
    const legacy = st?.deviceSecure && !st.hasSecret ? await hasLegacyServer() : false;
    setBoot(bootScreen(st, legacy));
    void uncover(); // nothing secret on screen yet: drop the native cover
  }, [setBoot]);

  useEffect(() => {
    if (isNative) void decide();
  }, [decide]);

  // Background: covers go up (native on pause, React here). Back: the native timer decides (relock.ts),
  // one run at a time; a lock or nolock is committed synchronously and painted before any cover comes down.
  useEffect(() => {
    if (!isNative) return;
    const ctl = activeController({
      awayMs,
      deviceSecure: async () => (await vaultStatus())?.deviceSecure ?? null,
      isReady: () => bootRef.current === 'ready',
      forgetSession: () => forgetSession(qc),
      clearWebCache,
      lock: () => flushSync(() => setBoot('lock')),
      noLock: () => flushSync(() => setBoot('nolock')),
      painted: () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      uncover,
      setCovered,
    });
    return onAppState((active) => {
      if (active) void ctl.active();
      else ctl.inactive();
    });
  }, [qc, setBoot]);

  // Native lost its session (relocked natively after 30 s away, or a new page): back to the lock screen.
  useEffect(() => {
    if (!isNative) return;
    return onLocked(() => {
      if (bootRef.current !== 'ready') return;
      forgetSession(qc);
      setBoot('lock');
    });
  }, [qc, setBoot]);

  const unpair = (message: string | null) => {
    void forgetPairing();
    setServer(null);
    qc.clear();
    setPairMessage(message);
    setBoot('pair');
  };

  const unlocked = (o: Exclude<UnlockOutcome, { kind: 'retry' }>) => {
    if (o.kind === 'ready') {
      setServer(o.server);
      setLastUrl(o.server.url);
      qc.clear();
      setBoot('ready');
      void uncover();
    } else if (o.kind === 'nolock') setBoot('nolock');
    else unpair(o.message ? t(o.message) : null);
  };

  if (!isNative && location.pathname === '/pair') return <PairInfo />;
  if (!isNative && location.pathname === '/passkey') return <PasskeyEnroll />;
  // the remote-AI consent page (remote-mcp.md §4.3): opened from a browser ChatGPT or Claude sent here, with no hub
  // session; approval is its own passkey signature, so it renders before (and without) the sign-in gate
  if (!isNative && location.pathname === '/connect') return <Connect />;
  return (
    <>
      {boot === 'loading' ? (
        <Spinner />
      ) : boot === 'nolock' || boot === 'novault' ? (
        <NoLock variant={boot} onRetry={decide} />
      ) : boot === 'pair' ? (
        <Pair
          message={pairMessage}
          lastUrl={lastUrl}
          onPaired={(s: PairedServer) => {
            setServer(s);
            setLastUrl(s.url);
            qc.clear();
            setPairMessage(null);
            setBoot('ready');
            void uncover();
          }}
        />
      ) : boot === 'lock' ? (
        <Lock onOutcome={unlocked} onForget={() => unpair(null)} />
      ) : (
        <Authed onUnpair={() => unpair(null)} onRevoked={() => unpair(t('device_revoked'))} />
      )}
      {covered && <div aria-hidden className="fixed inset-0 z-[2147483647]" style={{ background: 'var(--color-bg)' }} />}
    </>
  );
}

function Authed({ onUnpair, onRevoked }: { onUnpair: () => void; onRevoked: () => void }) {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: () => api.get<AuthStatus>('/api/auth/status'), staleTime: 60_000, retry: 1 });
  useEffect(
    () =>
      onUnauthorized(() => {
        if (isNative) {
          // a 401 alone proves nothing; ask the worker whether this token is really revoked
          void qc.invalidateQueries({ queryKey: ['auth'] });
          return;
        }
        if (getServer()) {
          // the browser's device token was revoked: forget it and fall back to the sign-in screen
          saveBrowserDevice(null);
          setServer(null);
        }
        qc.setQueryData<AuthStatus>(['auth'], (a) => (a ? { ...a, authenticated: false } : a));
      }),
    [qc],
  );
  useEffect(() => {
    if (isNative && auth.data && tokenGone(auth.data)) onRevoked();
  }, [auth.data, onRevoked]);
  if (auth.isPending) return <Spinner />;
  if (auth.error) return <div className="p-6 text-neg">finc worker unreachable: {String((auth.error as Error).message)}</div>;
  if (!auth.data.authenticated) {
    if (isNative) return <Spinner />;
    return (
      <Login
        pinSet={auth.data.pinSet}
        trusted={auth.data.trusted}
        passkeys={auth.data.passkeys ?? null}
        onDone={() => {
          qc.clear();
          void auth.refetch();
        }}
      />
    );
  }
  const signedOut = () => {
    qc.clear();
    if (isNative) onUnpair();
    else {
      saveBrowserDevice(null);
      setServer(null);
      void auth.refetch();
    }
  };
  return (
    <Shell>
      <VaultBanner />
      <Routes>
        <Route path="/" element={<Hub />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/recurring" element={<Recurring />} />
        <Route path="/categories" element={<Categories />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/events" element={<Events />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/stock-rules" element={<StockRules />} />
        <Route path="/settings" element={<Settings onSignOut={signedOut} thisDevice={auth.data.device} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

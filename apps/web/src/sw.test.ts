import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stampServiceWorker } from '../vite.config';

const SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://hub.example:7443';

/** Run public/sw.js against fake service-worker globals and return a way to send it fetch events. */
function load(network: (url: string) => Response) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return { put: async (k: string | Request, r: Response) => void m.set(typeof k === 'string' ? k : new URL(k.url).pathname, r), match: async (k: string | Request) => m.get(typeof k === 'string' ? k : new URL(k.url).pathname), addAll: async () => undefined };
    },
    async match(k: string) {
      for (const m of stores.values()) if (m.has(k)) return m.get(k);
      return undefined;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(k: string) {
      return stores.delete(k);
    },
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), skipWaiting: () => undefined, clients: { claim: () => undefined } };
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, async (r: Request) => network(r.url));
  async function get(p: string, mode: RequestMode = 'navigate'): Promise<Response | undefined> {
    let answer: Promise<Response> | undefined;
    listeners.fetch!({ request: { url: `${ORIGIN}${p}`, method: 'GET', mode }, respondWith: (x: Promise<Response>) => (answer = x) });
    const r = await answer;
    await new Promise((res) => setTimeout(res, 0)); // let the cache write finish
    return r;
  }
  return { get, stores };
}

const html = () => new Response('<!doctype html><title>finc</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('service worker (security research P3-02)', () => {
  it('keeps an HTML page as the app shell', async () => {
    const sw = load(() => html());
    await sw.get('/transactions');
    const shell = [...sw.stores.values()][0]?.get('/');
    expect(await shell?.text()).toContain('<title>finc</title>');
  });

  it('never stores a download (the APK) as the app shell', async () => {
    const sw = load(() => new Response('PK-binary', { headers: { 'content-type': 'application/vnd.android.package-archive' } }));
    await sw.get('/finc.apk');
    expect([...sw.stores.values()].every((m) => !m.has('/'))).toBe(true);
  });

  it('leaves API calls to the network', async () => {
    const sw = load(() => html());
    expect(await sw.get('/api/summary', 'cors')).toBeUndefined();
  });

  it('a build stamps its own cache name', () => {
    const a = stampServiceWorker(SOURCE, '<script src="/assets/index-A.js">');
    const b = stampServiceWorker(SOURCE, '<script src="/assets/index-B.js">');
    expect(a).toMatch(/'finc-shell-[0-9a-f]{12}'/);
    expect(a).not.toBe(b);
    expect(() => stampServiceWorker('const SHELL = 1;', '')).toThrow(/placeholder/);
  });
});

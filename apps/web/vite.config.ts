import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const worker = `http://127.0.0.1:${process.env.FINC_PORT ?? '7733'}`;

/**
 * Security research P2-01: the page's own Content-Security-Policy, as a <meta> in the BUILT index.html, so the
 * Android app (which serves its bundled copy itself, without the worker's header) has one too. In the browser the
 * worker's header CSP (apps/worker/src/api/static.ts) applies as well; both must pass, and they agree (this one only
 * adds script-src / object-src / form-action; frame-ancestors is header-only and stays there).
 *
 * - script-src 'self': the build has no inline script (checked by the build below). Capacitor's bridge JS is not
 *   an inline <script> on current WebViews: Bridge.loadWebView() uses WebViewCompat.addDocumentStartJavaScript
 *   (WebViewFeature.DOCUMENT_START_SCRIPT), which CSP does not govern. Only on a WebView without that feature would
 *   Capacitor fall back to splicing an inline <script> into index.html (JSInjector), which this policy blocks: the
 *   app then fails closed (no plugins, so no vault, no pairing, no data).
 * - connect-src 'self': in the app the hub is reached only natively (FincVault.request), never from the WebView.
 * - style-src 'unsafe-inline': React / Recharts style attributes.
 * Build-only: the dev server needs an inline React-refresh preamble, which this policy would block.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  const charset = '<meta charset="UTF-8" />';
  return {
    name: 'finc-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!html.includes(charset)) throw new Error('finc-csp-meta: <meta charset> not found in index.html');
        // fail the build if anything (a plugin, a polyfill) put an inline script in the page: script-src 'self' would block it
        const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs ?? '') || (body ?? '').trim() !== '');
        if (inline.length) throw new Error(`finc-csp-meta: ${inline.length} inline <script> in index.html; the CSP (script-src 'self') would block it`);
        if (/\son[a-z]+\s*=/i.test(html)) throw new Error('finc-csp-meta: an inline event handler in index.html');
        return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta()],
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': worker, '/health': worker } },
});

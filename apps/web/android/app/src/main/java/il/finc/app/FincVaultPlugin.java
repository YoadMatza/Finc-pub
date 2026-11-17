package il.finc.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * FincVault (P1-11) keeps ONE secret string (the paired hub: url, device token, name, as JSON)
 * encrypted with an AES-256-GCM key in the Android Keystore. The key requires user
 * authentication for every use (timeout 0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL) and the Cipher is
 * bound to the BiometricPrompt through a CryptoObject, so the secret cannot be decrypted without a
 * fresh Class 3 fingerprint/face or the phone's PIN/pattern/password. Android 11+ (minSdk 30) only.
 *
 * It also owns the "away" signals the web lock uses:
 * - awayMs(): time since the app was paused, on the monotonic clock (immune to wall-clock changes).
 * - a native cover: an opaque view over the whole content root, put up synchronously on pause/stop
 *   so the last frame (balances) never shows on return; it stays until JS calls uncover().
 *
 * It also knows the one hub this APK talks to (security research P1-10): the network security config pins that
 * host's public key, so a release build refuses to store a pairing for any other host ("wrong-host"), whatever
 * the web side asked. pinnedHost() tells the web side the same thing.
 *
 * Security research P2-01: the device token never enters JavaScript. load() / storePairing() keep the decrypted
 * pairing in native memory only (a session: this plugin instance, gone with the process, the WebView page, lock()
 * and clear()) and tell the web side just {url, deviceName}. request() sends one hub API call with the token added
 * here, to a URL built only from the session's origin plus an "/api/..." path (HubRequestRules). pair() redeems a
 * pairing code natively; the new token waits in native memory (pending) until storePairing() puts it in the vault.
 * Only the one-time migration of a pre-vault pairing (store()) still passes a token in from JS.
 *
 * All vault methods resolve; failures come back as a `reason`. request() / pair() reject on a transport failure
 * with a code ('locked', 'invalid', 'network') and a message that never names the hub. The secret is never logged.
 */
@CapacitorPlugin(name = "FincVault")
public class FincVaultPlugin extends Plugin {
  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String KEY_ALIAS = "finc_vault_key";
  private static final String PREFS = "finc_vault";
  private static final String PREF_CT = "ct";
  private static final String PREF_IV = "iv";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int GCM_TAG_BITS = 128;
  private static final int AUTHENTICATORS =
    BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
  private static final int COVER_BG = Color.parseColor("#0F1115");

  /*
   * Static so they survive the activity (and this plugin instance) being recreated while paused;
   * only touched on the main thread (lifecycle callbacks and runOnUiThread).
   */
  /** elapsedRealtime() of the earliest pause not yet consumed by awayMs(); 0 = none. */
  private static long pausedAt = 0;
  /** The cover should be up (set on pause/stop, cleared only by uncover()). */
  private static boolean coverWanted = false;
  /** Pause counter, incremented on every pause; lets JS refuse a stale uncover(). */
  private static int epoch = 0;

  /** elapsedRealtime() of the first pause since the last resume (not consumed by awayMs); 0 = none. */
  private static long sessionAwayStart = 0;

  /** Same as the web relock (relock.ts LOCK_AFTER_MS): a session does not survive more than 30 s away. */
  static final long SESSION_LOCK_AFTER_MS = 30_000;
  static final int CONNECT_TIMEOUT_MS = 15_000;
  static final int READ_TIMEOUT_MS = 30_000;
  /** Largest hub answer read into memory. */
  private static final int MAX_BODY_BYTES = 16 * 1024 * 1024;

  private View cover;
  /** One prompt at a time; a second call while a prompt is open resolves with 'failed'. */
  private boolean busy = false;

  /** An unlocked (or just redeemed) pairing; lives in native memory only, never sent to JS. */
  private static final class Session {
    final String origin;
    final String token;
    final String deviceName;

    Session(String origin, String token, String deviceName) {
      this.origin = origin;
      this.token = token;
      this.deviceName = deviceName;
    }

    String toJson() throws Exception {
      return new JSONObject().put("url", origin).put("token", token).put("deviceName", deviceName).toString();
    }
  }

  /** The unlocked pairing every request() uses; null = locked. */
  private volatile Session session = null;
  /** Redeemed by pair() but not yet in the vault (the store prompt may be cancelled and retried). */
  private volatile Session pending = null;
  /** Hub requests run here, never on Capacitor's plugin thread (it would block awayMs/lock behind a 30 s read). */
  private final ExecutorService net = Executors.newFixedThreadPool(4);

  private enum KeyState { PRESENT, ABSENT, ERROR }

  // ---------------------------------------------------------------- lifecycle / cover

  @Override
  public void load() {
    // Activity recreated while the app was away: put the cover back before the first frame.
    if (coverWanted) showCover();
    // Hub requests carry the device token only, never cookies: Capacitor's CapacitorCookies (loaded before this
    // plugin) installs a process-wide CookieHandler that HttpsURLConnection would use. Nothing in finc needs it
    // (CapacitorHttp and the CapacitorCookies document.cookie patch are both off); send() checks again per request.
    noCookieHandler();
    // A new page (reload, navigation) or a dead renderer starts locked: the JS that unlocked is gone.
    if (bridge != null) {
      bridge.addWebViewListener(new WebViewListener() {
        @Override
        public void onPageStarted(WebView webView) {
          dropSession();
        }

        @Override
        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
          dropSession();
          return false;
        }
      });
    }
  }

  /** Paused for more than 30 s right now (not yet resumed). */
  private static boolean awayTooLong() {
    long start = sessionAwayStart;
    return start != 0 && SystemClock.elapsedRealtime() - start > SESSION_LOCK_AFTER_MS;
  }

  /** No process-wide cookie store for HttpsURLConnection: hub requests never send or keep cookies. */
  private static void noCookieHandler() {
    try {
      if (CookieHandler.getDefault() != null) CookieHandler.setDefault(null);
    } catch (Exception ignored) {
      // a SecurityManager refusing it: not on Android
    }
  }

  /** Forget the unlocked and the pending pairing (native memory only; the vault is untouched). */
  private void dropSession() {
    session = null;
    pending = null;
  }

  @Override
  protected void handleOnPause() {
    epoch++;
    long now = SystemClock.elapsedRealtime();
    if (pausedAt == 0) pausedAt = now;
    if (sessionAwayStart == 0) sessionAwayStart = now;
    coverWanted = true;
    showCover();
  }

  @Override
  protected void handleOnDestroy() {
    dropSession();
    net.shutdownNow();
  }

  @Override
  protected void handleOnStop() {
    coverWanted = true;
    showCover();
  }

  @Override
  protected void handleOnStart() {
    if (coverWanted) showCover();
  }

  @Override
  protected void handleOnResume() {
    // Native half of the 30 s relock (the web side also calls lock()): more than 30 s away drops the session, so
    // the next request needs a new prompt even if the JS relock never ran.
    long start = sessionAwayStart;
    sessionAwayStart = 0;
    if (start != 0 && SystemClock.elapsedRealtime() - start > SESSION_LOCK_AFTER_MS) dropSession();
    if (coverWanted) showCover();
  }

  /** Main thread only. Adds the cover on top of android.R.id.content if it is not already there. */
  private void showCover() {
    Activity activity = getActivity();
    if (activity == null) return;
    ViewGroup content = activity.findViewById(android.R.id.content);
    if (content == null) return;
    if (cover != null && cover.getParent() == content) {
      cover.bringToFront();
      return;
    }
    if (cover != null && cover.getParent() instanceof ViewGroup) ((ViewGroup) cover.getParent()).removeView(cover);
    View v = new View(activity);
    v.setBackgroundColor(COVER_BG);
    v.setClickable(true); // swallow touches so nothing under it is reachable
    v.setFocusable(true);
    v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    v.setTranslationZ(10_000f); // above any elevated sibling
    content.addView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    cover = v;
  }

  private void hideCover() {
    coverWanted = false;
    if (cover != null && cover.getParent() instanceof ViewGroup) ((ViewGroup) cover.getParent()).removeView(cover);
    cover = null;
  }

  // ---------------------------------------------------------------- JS methods

  @PluginMethod
  public void awayMs(PluginCall call) {
    Activity activity = getActivity();
    Runnable r = () -> {
      long ms = pausedAt == 0 ? 0 : Math.max(0, SystemClock.elapsedRealtime() - pausedAt);
      pausedAt = 0;
      JSObject o = new JSObject();
      o.put("ms", ms);
      o.put("epoch", epoch);
      call.resolve(o);
    };
    if (activity != null) activity.runOnUiThread(r);
    else r.run();
  }

  @PluginMethod
  public void uncover(PluginCall call) {
    Activity activity = getActivity();
    final boolean checkEpoch = call.getData().has("epoch");
    final Integer want = checkEpoch ? call.getInt("epoch") : null;
    Runnable r = () -> {
      JSObject o = new JSObject();
      if (checkEpoch && (want == null || want != epoch)) {
        // A pause happened since JS read the epoch: keep the cover up.
        o.put("ok", false);
      } else {
        hideCover();
        o.put("ok", true);
      }
      call.resolve(o);
    };
    if (activity != null) activity.runOnUiThread(r);
    else r.run();
  }

  @PluginMethod
  public void clearWebCache(PluginCall call) {
    Activity activity = getActivity();
    Runnable r = () -> {
      try {
        if (bridge != null && bridge.getWebView() != null) bridge.getWebView().clearCache(true);
      } catch (Exception ignored) {
        // best effort
      }
      JSObject o = new JSObject();
      o.put("ok", true);
      call.resolve(o);
    };
    if (activity != null) activity.runOnUiThread(r);
    else r.run();
  }

  /**
   * Open an SEC filing (stock insights step 2) or a news article (decision aids C) in the system browser, never inside
   * finc. Only plain https links pass (ExternalLinkRules.externalUrl); anything else is rejected with code 'invalid'.
   */
  @PluginMethod
  public void openExternal(PluginCall call) {
    String url = ExternalLinkRules.externalUrl(call.getString("url"));
    if (url == null) {
      call.reject("link not allowed", "invalid");
      return;
    }
    try {
      Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      i.addCategory(Intent.CATEGORY_BROWSABLE);
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
      JSObject o = new JSObject();
      o.put("ok", true);
      call.resolve(o);
    } catch (ActivityNotFoundException e) {
      call.reject("no browser", "unavailable");
    }
  }

  /** The hub host built into this APK (Gradle fincPublicHost) and whether it is enforced (release builds only). */
  @PluginMethod
  public void pinnedHost(PluginCall call) {
    JSObject o = new JSObject();
    o.put("host", BuildConfig.FINC_PUBLIC_HOST);
    o.put("enforce", !BuildConfig.DEBUG);
    call.resolve(o);
  }

  /**
   * P1-10, defence in depth: the stored pairing's url must be https on exactly the pinned host (any port) in a
   * release build. Debug builds accept any host. Anything unparsable is refused.
   */
  static boolean allowedHub(String pairingJson, String pinnedHost, boolean enforce) {
    if (!enforce) return true;
    try {
      String url = new JSONObject(pairingJson).optString("url", "");
      URI u = new URI(url);
      String host = u.getHost();
      if (host == null || pinnedHost == null || pinnedHost.isEmpty()) return false;
      if (!"https".equalsIgnoreCase(u.getScheme()) || u.getRawUserInfo() != null) return false;
      String want = normalHost(pinnedHost);
      return !want.isEmpty() && !want.endsWith(".") && normalHost(host).equals(want);
    } catch (Exception e) {
      return false;
    }
  }

  /** Lower case and at most ONE trailing dot removed: "host." is the same name, "host.." is refused. */
  static String normalHost(String h) {
    String s = h.toLowerCase(Locale.ROOT);
    return s.endsWith(".") ? s.substring(0, s.length() - 1) : s;
  }

  @PluginMethod
  public void status(PluginCall call) {
    boolean ct = hasCiphertext();
    KeyState ks = keyState();
    JSObject r = new JSObject();
    r.put("deviceSecure", deviceSecure());
    r.put("strongBiometrics", strongBiometrics());
    if (ks == KeyState.ERROR) {
      r.put("hasSecret", ct);
      r.put("reason", "failed");
    } else {
      r.put("hasSecret", ct && ks == KeyState.PRESENT);
    }
    call.resolve(r);
  }

  /**
   * Only for moving a pre-vault pairing (JSON {url, token, deviceName} from the old secure storage) into the vault.
   * On success that pairing becomes the unlocked session; nothing comes back but {ok}.
   */
  @PluginMethod
  public void store(PluginCall call) {
    String value = call.getString("value");
    String title = call.getString("title");
    if (value == null || title == null) {
      call.reject("value and title are required");
      return;
    }
    if (hasCiphertext()) {
      // only the one-time move of a legacy pairing into an EMPTY vault; never a way to replace a stored pairing
      call.reject("a pairing is already stored", "invalid");
      return;
    }
    if (!allowedHub(value, BuildConfig.FINC_PUBLIC_HOST, !BuildConfig.DEBUG)) {
      resolveOk(call, false, "wrong-host");
      return;
    }
    final Session s = parseSession(value);
    if (s == null) {
      resolveOk(call, false, "failed");
      return;
    }
    encryptAndSave(call, title, s);
  }

  /**
   * Put the pairing redeemed by pair() into the vault (fingerprint / screen-lock prompt). On success it becomes the
   * unlocked session: {ok: true, url, deviceName}. Nothing pending (never paired, or locked since): 'failed'.
   */
  @PluginMethod
  public void storePairing(PluginCall call) {
    String title = call.getString("title");
    if (title == null) {
      call.reject("title is required");
      return;
    }
    final Session p = pending;
    if (p == null) {
      resolveOk(call, false, "failed");
      return;
    }
    if (!HubRequestRules.hubAllowed(p.origin, BuildConfig.FINC_PUBLIC_HOST, !BuildConfig.DEBUG)) {
      resolveOk(call, false, "wrong-host");
      return;
    }
    encryptAndSave(call, title, p);
  }

  /** Shared by store() and storePairing(): prompt, encrypt the session's JSON, save; on success unlock with it. */
  private void encryptAndSave(PluginCall call, String title, Session s) {
    if (!deviceSecure()) {
      resolveOk(call, false, "no-lock");
      return;
    }
    final String value;
    try {
      value = s.toJson();
    } catch (Exception e) {
      resolveOk(call, false, "failed");
      return;
    }
    Cipher cipher;
    try {
      cipher = encryptCipher();
    } catch (Exception e) {
      resolveOk(call, false, deviceSecure() ? "failed" : "no-lock");
      return;
    }
    prompt(title, call.getString("subtitle"), cipher, new Done() {
      @Override public void success(Cipher authed) {
        try {
          byte[] ct = authed.doFinal(value.getBytes(StandardCharsets.UTF_8));
          byte[] iv = authed.getIV();
          boolean saved = prefs().edit()
            .putString(PREF_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString(PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
            .commit();
          if (!saved) {
            resolveOk(call, false, "failed");
            return;
          }
          pausedAt = 0; // time the prompt kept us paused is not "away"
          sessionAwayStart = 0;
          session = s;
          if (pending == s) pending = null;
          JSObject r = new JSObject();
          r.put("ok", true);
          r.put("url", s.origin);
          r.put("deviceName", s.deviceName);
          call.resolve(r);
        } catch (Exception e) {
          resolveOk(call, false, "failed");
        }
      }
      @Override public void error(String reason) {
        resolveOk(call, false, reason);
      }
    });
  }

  /** The vault JSON as a session; null unless it has an https url and a token. */
  private static Session parseSession(String json) {
    try {
      JSONObject o = new JSONObject(json);
      String origin = HubRequestRules.origin(o.optString("url", ""));
      String token = o.optString("token", "");
      if (origin == null || token.isEmpty()) return null;
      String name = o.optString("deviceName", "");
      return new Session(origin, token, name.isEmpty() ? "phone" : name);
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * Prompt, decrypt, and keep the pairing as the unlocked session. Resolves {ok: true, url, deviceName} (never the
   * token) or {ok: false, reason}. A pairing for a host this build does not pin is refused ('wrong-host') and kept.
   */
  @PluginMethod
  public void load(PluginCall call) {
    String title = call.getString("title");
    if (title == null) {
      call.reject("title is required");
      return;
    }
    if (!deviceSecure()) {
      resolveOk(call, false, "no-lock");
      return;
    }
    if (!hasCiphertext()) {
      resolveOk(call, false, "none");
      return;
    }
    KeyState ks = keyState();
    if (ks == KeyState.ERROR) {
      resolveOk(call, false, "failed");
      return;
    }
    if (ks == KeyState.ABSENT) {
      // Definitely gone (e.g. Keystore cleared) while ciphertext exists: nothing can decrypt it.
      wipe();
      resolveOk(call, false, "invalidated");
      return;
    }
    final byte[] ct;
    final byte[] iv;
    try {
      ct = Base64.decode(prefs().getString(PREF_CT, ""), Base64.NO_WRAP);
      iv = Base64.decode(prefs().getString(PREF_IV, ""), Base64.NO_WRAP);
    } catch (IllegalArgumentException e) {
      resolveOk(call, false, "failed");
      return;
    }
    Cipher cipher;
    try {
      cipher = decryptCipher(iv);
    } catch (KeyPermanentlyInvalidatedException e) {
      wipe();
      resolveOk(call, false, "invalidated");
      return;
    } catch (Exception e) {
      resolveOk(call, false, "failed");
      return;
    }
    prompt(title, call.getString("subtitle"), cipher, new Done() {
      @Override public void success(Cipher authed) {
        try {
          byte[] plain = authed.doFinal(ct);
          pausedAt = 0; // time the prompt kept us paused is not "away"
          sessionAwayStart = 0;
          Session s = parseSession(new String(plain, StandardCharsets.UTF_8));
          if (s == null) {
            resolveOk(call, false, "failed");
            return;
          }
          if (!HubRequestRules.hubAllowed(s.origin, BuildConfig.FINC_PUBLIC_HOST, !BuildConfig.DEBUG)) {
            // paired before P1-10 with a host this build does not pin: refused, but KEPT (re-pairing is home-only)
            resolveOk(call, false, "wrong-host");
            return;
          }
          session = s;
          JSObject r = new JSObject();
          r.put("ok", true);
          r.put("url", s.origin);
          r.put("deviceName", s.deviceName);
          call.resolve(r);
        } catch (Exception e) {
          resolveOk(call, false, "failed");
        }
      }
      @Override public void error(String reason) {
        resolveOk(call, false, reason);
      }
    });
  }

  /** Relock: the unlocked and the pending pairing leave native memory; the vault keeps the pairing. */
  @PluginMethod
  public void lock(PluginCall call) {
    dropSession();
    resolveOk(call, true, null);
  }

  /** Forget the pairing: the vault, the key, and the session. */
  @PluginMethod
  public void clear(PluginCall call) {
    dropSession();
    wipe();
    JSObject r = new JSObject();
    r.put("ok", true);
    call.resolve(r);
  }

  // ---------------------------------------------------------------- hub requests (P2-01)

  /**
   * One hub API call with the device token added here. {path: "/api/...", method, body?: string (JSON),
   * headers?: {accept, accept-language, content-type only}} -> {status, data (parsed JSON or text), headers:
   * {content-type?, retry-after?}}. Rejects: 'locked' (no unlocked session), 'invalid' (path, method, body),
   * 'network' (no answer, timeout, TLS / pin failure). Redirects are not followed.
   */
  @PluginMethod
  public void request(PluginCall call) {
    final Session s = session;
    if (s == null) {
      call.reject("finc is locked", "locked");
      return;
    }
    if (awayTooLong()) {
      // away (paused) more than 30 s and not resumed yet: JS still running in the background gets nothing
      dropSession();
      call.reject("finc is locked", "locked");
      return;
    }
    final String method = HubRequestRules.method(call.getString("method", "GET"));
    final String url = HubRequestRules.apiUrl(s.origin, call.getString("path"));
    final String body = call.getString("body");
    if (method == null || url == null || HubRequestRules.nativeOnlyPath(call.getString("path")) || (body != null && "GET".equals(method))) {
      call.reject("refused: not a hub API request", "invalid");
      return;
    }
    final Map<String, String> headers = new LinkedHashMap<>();
    JSObject given = call.getObject("headers", new JSObject());
    if (given != null) {
      Iterator<String> keys = given.keys();
      while (keys.hasNext()) {
        String k = keys.next();
        String v = given.optString(k, null);
        if (HubRequestRules.callerHeaderAllowed(k, v)) headers.put(k.trim().toLowerCase(Locale.ROOT), v);
      }
    }
    headers.put("authorization", "Bearer " + s.token);
    execute(call, () -> {
      Answer a = send(url, method, headers, body);
      if (session != s) {
        // relocked (or forgotten) while the request ran: its answer is not handed over
        call.reject("finc is locked", "locked");
        return;
      }
      // no answer hands JS a token (defence in depth; pairing goes through pair(), which keeps it here)
      if (a.data instanceof JSONObject) ((JSONObject) a.data).remove("token");
      call.resolve(a.toJs(true));
    });
  }

  /**
   * Redeem a pairing code at the hub, natively: POST {origin}/api/devices/pair {code, name}, no token, and no cookie
   * (no CookieHandler is installed, see noCookieHandler).
   * The origin must pass the pinned-host check (release builds). On success the token stays here as `pending`
   * and JS gets {ok: true, url, device: {id, name}}; storePairing() then puts it in the vault. A refusal by the hub
   * resolves {ok: false, status, data} (any "token" field removed); a bad host resolves {ok: false, reason}.
   */
  @PluginMethod
  public void pair(PluginCall call) {
    final String origin = HubRequestRules.origin(call.getString("url"));
    final String code = call.getString("code");
    String n = call.getString("name", "phone");
    final String name = n == null || n.trim().isEmpty() ? "phone" : (n.length() > 60 ? n.substring(0, 60) : n);
    if (origin == null || !HubRequestRules.hubAllowed(origin, BuildConfig.FINC_PUBLIC_HOST, !BuildConfig.DEBUG)) {
      resolveOk(call, false, "wrong-host");
      return;
    }
    if (!HubRequestRules.validPairingCode(code)) {
      call.reject("refused: not a pairing code", "invalid");
      return;
    }
    final String url = HubRequestRules.apiUrl(origin, "/api/devices/pair");
    final String body;
    try {
      body = new JSONObject().put("code", code).put("name", name).toString();
    } catch (Exception e) {
      call.reject("refused: not a pairing code", "invalid");
      return;
    }
    pending = null;
    execute(call, () -> {
      Answer a = send(url, "POST", new LinkedHashMap<>(), body);
      JSONObject d = a.data instanceof JSONObject ? (JSONObject) a.data : null;
      String token = d != null ? d.optString("token", "") : "";
      JSONObject device = d != null ? d.optJSONObject("device") : null;
      if (a.status >= 200 && a.status < 300 && !token.isEmpty() && device != null) {
        String finalOrigin = HubRequestRules.pairedOrigin(d.optString("url", ""), origin, BuildConfig.FINC_PUBLIC_HOST, !BuildConfig.DEBUG);
        String deviceName = device.optString("name", "");
        pending = new Session(finalOrigin, token, deviceName.isEmpty() ? name : deviceName);
        JSObject dev = new JSObject();
        dev.put("id", device.opt("id"));
        dev.put("name", deviceName.isEmpty() ? name : deviceName);
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("url", finalOrigin);
        r.put("device", dev);
        call.resolve(r);
        return;
      }
      if (d != null) d.remove("token");
      JSObject r = a.toJs(false);
      r.put("ok", false);
      call.resolve(r);
    });
  }

  private interface NetJob {
    void run() throws Exception;
  }

  /** Run a network job off the plugin thread; any failure rejects with a message that never names the hub. */
  private void execute(PluginCall call, NetJob job) {
    try {
      net.execute(() -> {
        try {
          job.run();
        } catch (SocketTimeoutException e) {
          call.reject("the hub did not answer in time", "network");
        } catch (SSLException e) {
          call.reject("secure connection to the hub failed (certificate or pin)", "network");
        } catch (IOException e) {
          call.reject("no answer from the hub", "network");
        } catch (Exception e) {
          call.reject("the request failed", "network");
        }
      });
    } catch (Exception e) {
      call.reject("the request failed", "network");
    }
  }

  /** A hub answer: status, parsed body (JSONObject / JSONArray / String), and the headers JS may see. */
  private static final class Answer {
    int status;
    Object data = "";
    String contentType;
    String retryAfter;

    JSObject toJs(boolean withData) {
      JSObject r = new JSObject();
      r.put("status", status);
      r.put("data", withData || data instanceof JSONObject ? data : "");
      JSObject h = new JSObject();
      if (contentType != null) h.put("content-type", contentType);
      if (retryAfter != null) h.put("retry-after", retryAfter);
      r.put("headers", h);
      return r;
    }
  }

  /**
   * One HTTPS request. HttpsURLConnection is Android's own stack, so the network security config (the hub's
   * public-key pins, P1-10) applies; the WebView's networking is never used for the hub.
   */
  private static Answer send(String url, String method, Map<String, String> headers, String body) throws Exception {
    noCookieHandler(); // never cookies: neither sent nor stored (the handler is read when the request runs)
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    if (!(c instanceof HttpsURLConnection)) {
      c.disconnect();
      throw new IOException("not https");
    }
    try {
      c.setInstanceFollowRedirects(false);
      c.setUseCaches(false);
      c.setConnectTimeout(CONNECT_TIMEOUT_MS);
      c.setReadTimeout(READ_TIMEOUT_MS);
      c.setRequestMethod(method);
      c.setRequestProperty("accept", "application/json");
      for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
      if (body != null) {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        c.setRequestProperty("content-type", "application/json");
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(b.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(b);
        }
      }
      Answer a = new Answer();
      a.status = c.getResponseCode();
      a.contentType = c.getHeaderField("content-type");
      a.retryAfter = c.getHeaderField("retry-after");
      InputStream in = a.status >= 400 ? c.getErrorStream() : null;
      if (in == null) {
        try {
          in = c.getInputStream();
        } catch (IOException e) {
          in = c.getErrorStream();
        }
      }
      String text = in == null ? "" : readAll(in);
      a.data = parseBody(text);
      return a;
    } finally {
      c.disconnect();
    }
  }

  private static String readAll(InputStream in) throws IOException {
    try (InputStream s = in) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[16 * 1024];
      int total = 0;
      int n;
      while ((n = s.read(buf)) > 0) {
        total += n;
        if (total > MAX_BODY_BYTES) throw new IOException("answer too large");
        out.write(buf, 0, n);
      }
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  /** JSON object or array when the text is one; otherwise the text itself. */
  private static Object parseBody(String text) {
    String t = text.trim();
    try {
      if (t.startsWith("{")) return new JSObject(t);
      if (t.startsWith("[")) return new JSArray(t);
    } catch (Exception ignored) {
      // not JSON after all: hand over the text
    }
    return text;
  }

  // ---------------------------------------------------------------- prompt

  private interface Done {
    /** authed is the CryptoObject's cipher, unlocked by the authentication. */
    void success(Cipher authed);
    void error(String reason);
  }

  /** BiometricPrompt is its own window/activity, so the cover never blocks it. */
  private void prompt(String title, String subtitle, Cipher cipher, Done done) {
    final FragmentActivity activity = getActivity();
    if (activity == null) {
      done.error("failed");
      return;
    }
    activity.runOnUiThread(() -> {
      if (busy) {
        done.error("failed");
        return;
      }
      busy = true;
      try {
        BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setConfirmationRequired(false)
          .setAllowedAuthenticators(AUTHENTICATORS);
        if (subtitle != null && !subtitle.isEmpty()) info.setSubtitle(subtitle);

        BiometricPrompt bp = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
          new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
              busy = false;
              BiometricPrompt.CryptoObject co = result.getCryptoObject();
              Cipher c = co != null ? co.getCipher() : null;
              if (c == null) done.error("failed");
              else done.success(c);
            }

            @Override
            public void onAuthenticationError(int code, @NonNull CharSequence msg) {
              busy = false;
              done.error(mapError(code));
            }
            // onAuthenticationFailed is one wrong finger; the prompt stays open, nothing to do.
          });
        bp.authenticate(info.build(), new BiometricPrompt.CryptoObject(cipher));
      } catch (Exception e) {
        busy = false;
        done.error("failed");
      }
    });
  }

  private static String mapError(int code) {
    switch (code) {
      case BiometricPrompt.ERROR_USER_CANCELED:
      case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
      case BiometricPrompt.ERROR_CANCELED:
        return "cancelled";
      case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
        return "no-lock";
      default:
        return "failed";
    }
  }

  // ---------------------------------------------------------------- crypto

  /**
   * An ENCRYPT_MODE cipher on the vault key, creating the key if missing. If the key was
   * permanently invalidated (new biometric enrolled, lock removed) delete it and make a new one.
   */
  private Cipher encryptCipher() throws Exception {
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    try {
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
    } catch (KeyPermanentlyInvalidatedException e) {
      wipe();
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
    }
    return cipher;
  }

  private Cipher decryptCipher(byte[] iv) throws Exception {
    SecretKey key = existingKey();
    if (key == null) throw new KeyPermanentlyInvalidatedException();
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
    return cipher;
  }

  /** null only when the alias is definitely absent; Keystore failures throw. */
  private SecretKey existingKey() throws Exception {
    KeyStore ks = KeyStore.getInstance(KEYSTORE);
    ks.load(null);
    return (SecretKey) ks.getKey(KEY_ALIAS, null);
  }

  private SecretKey getOrCreateKey() throws Exception {
    SecretKey existing = existingKey();
    if (existing != null) return existing;
    KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
      .setInvalidatedByBiometricEnrollment(true)
      .build();
    KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    gen.init(spec);
    return gen.generateKey();
  }

  // ---------------------------------------------------------------- state

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private boolean hasCiphertext() {
    SharedPreferences p = prefs();
    return p.contains(PREF_CT) && p.contains(PREF_IV);
  }

  /** PRESENT / ABSENT only when the Keystore answered; any exception is ERROR, never "missing". */
  private KeyState keyState() {
    try {
      KeyStore ks = KeyStore.getInstance(KEYSTORE);
      ks.load(null);
      return ks.containsAlias(KEY_ALIAS) ? KeyState.PRESENT : KeyState.ABSENT;
    } catch (Exception e) {
      return KeyState.ERROR;
    }
  }

  /** Deletes the ciphertext and the key. Called only for clear(), permanent invalidation, or a definitely absent key. */
  private void wipe() {
    prefs().edit().remove(PREF_CT).remove(PREF_IV).commit();
    try {
      KeyStore ks = KeyStore.getInstance(KEYSTORE);
      ks.load(null);
      if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
    } catch (Exception ignored) {
      // a stale key without ciphertext is harmless; the next store replaces it
    }
  }

  private boolean deviceSecure() {
    KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
    return km != null && km.isDeviceSecure();
  }

  private boolean strongBiometrics() {
    return BiometricManager.from(getContext())
      .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
  }

  private static void resolveOk(PluginCall call, boolean ok, String reason) {
    JSObject r = new JSObject();
    r.put("ok", ok);
    if (reason != null) r.put("reason", reason);
    call.resolve(r);
  }
}

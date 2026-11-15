package il.finc.app;

import java.net.URI;
import java.util.Locale;

/**
 * Pure rules for the native hub requests (security research P2-01), kept free of Android classes so a plain JVM
 * unit test can check them (app/src/test/.../HubRequestRulesTest.java). The web side mirrors validApiPath in
 * apps/web/src/api.ts (checkApiPath); both must stay identical.
 *
 * The URL of every request with the device token is built here, ONLY from the unlocked pairing's origin plus an
 * "/api/..." path: JavaScript cannot pick the scheme, the host, the port, or escape the /api/ prefix.
 */
final class HubRequestRules {
  private HubRequestRules() {}

  /** Longest path (with query) accepted. */
  static final int MAX_PATH = 8192;

  /**
   * "https://host[:port]" from a hub URL, lower-case host, path/query/fragment dropped; null for anything that is
   * not https, has user info, has no host, or has a bad port. Every hub request is https (the pins need it).
   */
  static String origin(String url) {
    if (url == null) return null;
    try {
      URI u = new URI(url.trim());
      if (!"https".equalsIgnoreCase(u.getScheme())) return null;
      if (u.getRawUserInfo() != null) return null;
      String host = u.getHost();
      if (host == null || host.isEmpty()) return null;
      int port = u.getPort();
      if (port == 0 || port > 65535) return null;
      String h = host.toLowerCase(Locale.ROOT);
      if (h.endsWith("..")) return null;
      if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
      if (h.isEmpty()) return null;
      return "https://" + h + (port > 0 ? ":" + port : "");
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * P1-10: in a release build (enforce) the hub must be exactly the pinned host, any port. Debug builds accept any
   * https origin. Takes the result of origin(), or a raw URL (it is normalised first).
   */
  static boolean hubAllowed(String url, String pinnedHost, boolean enforce) {
    String o = origin(url);
    if (o == null) return false;
    if (!enforce) return true;
    if (pinnedHost == null) return false;
    String want = pinnedHost.trim().toLowerCase(Locale.ROOT);
    if (want.endsWith(".") && !want.endsWith("..")) want = want.substring(0, want.length() - 1);
    if (want.isEmpty() || want.endsWith(".")) return false;
    String host = URI.create(o).getHost();
    return want.equals(host);
  }

  /**
   * Mirror of hubhost.ts pairedOrigin (P2-05): after redeeming a code at `checkedOrigin`, the hub names its public
   * address. It is used only if it is an acceptable hub; otherwise the checked origin stays.
   */
  static String pairedOrigin(String returnedUrl, String checkedOrigin, String pinnedHost, boolean enforce) {
    String back = origin(returnedUrl);
    if (back != null && hubAllowed(back, pinnedHost, enforce)) return back;
    return checkedOrigin;
  }

  /**
   * The path a request may name: "/api/..." plus an optional query. Printable ASCII only, no backslash, no
   * fragment; in the part before "?": no "//", no "..", no "." segment, and no "%" at all (the hub decodes
   * escapes before routing, so "/api/devices/%70air" would reach the pair route; the app's paths never need one).
   */
  static boolean validApiPath(String p) {
    if (p == null || p.length() > MAX_PATH || !p.startsWith("/api/") || p.length() == "/api/".length()) return false;
    for (int i = 0; i < p.length(); i++) {
      char c = p.charAt(i);
      if (c <= 0x20 || c >= 0x7f || c == '\\' || c == '#') return false;
    }
    int q = p.indexOf('?');
    String path = q < 0 ? p : p.substring(0, q);
    if (path.contains("%")) return false;
    return !(path.contains("//") || path.contains("..") || path.contains("/./") || path.endsWith("/."));
  }

  /**
   * Paths request() refuses although they are valid: redeeming a pairing code mints a new device token, so that
   * goes only through the plugin's pair(), which keeps the token in native memory.
   */
  static boolean nativeOnlyPath(String p) {
    if (p == null) return true;
    int q = p.indexOf('?');
    String path = (q < 0 ? p : p.substring(0, q)).toLowerCase(Locale.ROOT);
    while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
    return path.equals("/api/devices/pair");
  }

  /**
   * The full request URL, or null. Re-parses the result and checks that scheme, host and port are still the
   * pairing's own (belt and braces on top of validApiPath).
   */
  static String apiUrl(String origin, String path) {
    if (origin == null || !validApiPath(path)) return null;
    String o = origin(origin);
    if (o == null || !o.equals(origin)) return null;
    String url = origin + path;
    try {
      URI want = new URI(origin);
      URI got = new URI(url);
      if (!"https".equals(got.getScheme())) return null;
      if (got.getRawUserInfo() != null) return null;
      if (got.getHost() == null || !got.getHost().equals(want.getHost())) return null;
      if (got.getPort() != want.getPort()) return null;
      if (got.getRawPath() == null || !got.getRawPath().startsWith("/api/")) return null;
      return url;
    } catch (Exception e) {
      return null;
    }
  }

  /** GET / POST / PUT / PATCH / DELETE (any case) in upper case; null for anything else. */
  static String method(String m) {
    if (m == null) return null;
    String u = m.trim().toUpperCase(Locale.ROOT);
    switch (u) {
      case "GET":
      case "POST":
      case "PUT":
      case "PATCH":
      case "DELETE":
        return u;
      default:
        return null;
    }
  }

  /**
   * Whether a header from the web side may be sent. Only a small allow-list passes: never Authorization or
   * Cookie (native adds the token itself), nor Host, lengths, encodings or proxy headers. Values with CR/LF/NUL
   * are refused.
   */
  static boolean callerHeaderAllowed(String name, String value) {
    if (name == null || value == null) return false;
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c == '\r' || c == '\n' || c == 0) return false;
    }
    switch (name.trim().toLowerCase(Locale.ROOT)) {
      case "accept":
      case "accept-language":
      case "content-type":
        return true;
      default:
        return false;
    }
  }

  /** A pairing code as the hub makes it (random, URL-safe). */
  static boolean validPairingCode(String code) {
    return code != null && code.matches("[A-Za-z0-9_-]{8,128}");
  }
}

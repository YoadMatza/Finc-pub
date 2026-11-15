package il.finc.app;

import java.net.URI;

/**
 * Which links finc may hand to the system browser (stock insights step 2: SEC filings). Kept free of Android
 * classes so a plain JVM test checks it (app/src/test/.../ExternalLinkRulesTest.java). The web side has the same
 * rule in apps/web/src/insightsCompany.ts (secLink); both must stay identical.
 *
 * Only https on exactly www.sec.gov, default port, no user info, nothing that a parser could read two ways.
 */
final class ExternalLinkRules {
  private ExternalLinkRules() {}

  static final String SEC_PREFIX = "https://www.sec.gov/";
  static final int MAX_LENGTH = 2048;

  /** The URL itself when it may be opened, else null. */
  static String secUrl(String url) {
    if (url == null || url.length() > MAX_LENGTH || !url.startsWith(SEC_PREFIX)) return null;
    for (int i = 0; i < url.length(); i++) {
      char c = url.charAt(i);
      if (c <= 0x20 || c == 0x7f || c == '\\' || c > 0x7e) return null;
    }
    try {
      URI u = new URI(url);
      if (!"https".equals(u.getScheme())) return null;
      if (u.getRawUserInfo() != null) return null;
      if (!"www.sec.gov".equals(u.getHost())) return null;
      if (u.getPort() != -1) return null;
      if (u.getRawAuthority() == null || !u.getRawAuthority().equals("www.sec.gov")) return null;
      return url;
    } catch (Exception e) {
      return null;
    }
  }
}

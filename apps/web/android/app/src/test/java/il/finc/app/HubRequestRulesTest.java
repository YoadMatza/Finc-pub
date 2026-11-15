package il.finc.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Security research P2-01: the native request() builds every URL with the device token from the pairing's origin
 * plus an "/api/..." path only. The same cases are mirrored in apps/web/src/nativeApi.test.ts (checkApiPath).
 */
public class HubRequestRulesTest {
  private static final String HUB = "https://hub.example:7443";

  @Test
  public void apiPathsAreAccepted() {
    for (String p : new String[] {
      "/api/hub", "/api/hub?month=2026-11&view=all", "/api/transactions/12", "/api/transactions?q=a..b",
      "/api/passkeys/abc-DEF_1", "/api/x?q=%D7%90", "/api/events/3/txns",
    }) {
      assertTrue(p, HubRequestRules.validApiPath(p));
      assertEquals(p, HUB + p, HubRequestRules.apiUrl(HUB, p));
    }
  }

  @Test
  public void anythingElseIsRefused() {
    for (String p : new String[] {
      null, "", "/api", "/api/", "api/hub", "/health", "//evil.example/api/x", "https://evil.example/api/x",
      "/api//x", "/api/../admin", "/api/x/..", "/api/./x", "/api/x/.", "/api/%2e%2e/x", "/api/%2E/x",
      "/api/x%2fy", "/api/x%5Cy", "/api/x%00", "/api/devices/%70air", "/api/devices/pai%72",
      "/api/%61pi/x", "/api/x%20y", "/api/x/%D7%90", "/api/x\\y", "/api/x#frag", "/api/x y", "/api/x\ny",
      "/api/א", "/apix/y", "/API/hub", "/api/x\t",
    }) {
      assertFalse(String.valueOf(p), HubRequestRules.validApiPath(p));
      assertNull(String.valueOf(p), HubRequestRules.apiUrl(HUB, p));
    }
    StringBuilder longPath = new StringBuilder("/api/");
    while (longPath.length() <= HubRequestRules.MAX_PATH) longPath.append('a');
    assertFalse(HubRequestRules.validApiPath(longPath.toString()));
  }

  @Test
  public void anAtSignInThePathCannotChangeTheHost() {
    String url = HubRequestRules.apiUrl(HUB, "/api/@evil.example");
    assertEquals(HUB + "/api/@evil.example", url);
  }

  @Test
  public void apiUrlNeedsACleanOrigin() {
    assertNull(HubRequestRules.apiUrl("http://hub.example", "/api/hub"));
    assertNull(HubRequestRules.apiUrl("https://hub.example/base", "/api/hub"));
    assertNull(HubRequestRules.apiUrl("https://u:p@hub.example", "/api/hub"));
    assertNull(HubRequestRules.apiUrl(null, "/api/hub"));
    assertEquals("https://hub.example/api/hub", HubRequestRules.apiUrl("https://hub.example", "/api/hub"));
  }

  @Test
  public void originIsHttpsSchemeHostPortOnly() {
    assertEquals(HUB, HubRequestRules.origin("https://Hub.Example:7443/some/path?x=1#y"));
    assertEquals("https://hub.example", HubRequestRules.origin("https://hub.example."));
    assertNull(HubRequestRules.origin("http://hub.example"));
    assertNull(HubRequestRules.origin("https://user:pw@hub.example"));
    assertNull(HubRequestRules.origin("finc://pair"));
    assertNull(HubRequestRules.origin("not a url"));
    assertNull(HubRequestRules.origin(null));
  }

  @Test
  public void pinnedHostOnlyInARelease() {
    assertTrue(HubRequestRules.hubAllowed("https://hub.example:7443", "hub.example", true));
    assertTrue(HubRequestRules.hubAllowed("https://HUB.example.", "hub.example", true));
    assertFalse(HubRequestRules.hubAllowed("https://evil.example", "hub.example", true));
    assertFalse(HubRequestRules.hubAllowed("https://hub.example.evil.example", "hub.example", true));
    assertFalse(HubRequestRules.hubAllowed("http://hub.example", "hub.example", true));
    assertFalse(HubRequestRules.hubAllowed("https://hub.example", "", true));
    assertFalse(HubRequestRules.hubAllowed("https://hub.example", null, true));
    // debug: any https host, never http
    assertTrue(HubRequestRules.hubAllowed("https://evil.example", "hub.example", false));
    assertFalse(HubRequestRules.hubAllowed("http://evil.example", "hub.example", false));
  }

  @Test
  public void pairedOriginKeepsTheCheckedOneUnlessTheAnswerIsAcceptable() {
    assertEquals("https://hub.example:7443", HubRequestRules.pairedOrigin("https://hub.example:7443/", "https://hub.example", "hub.example", true));
    assertEquals("https://hub.example", HubRequestRules.pairedOrigin("https://evil.example", "https://hub.example", "hub.example", true));
    assertEquals("https://hub.example", HubRequestRules.pairedOrigin("http://hub.example", "https://hub.example", "hub.example", true));
    assertEquals("https://hub.example", HubRequestRules.pairedOrigin("", "https://hub.example", "hub.example", true));
    assertEquals("https://other.example", HubRequestRules.pairedOrigin("https://other.example", "https://hub.example", "hub.example", false));
  }

  @Test
  public void pairingGoesOnlyThroughPair() {
    assertTrue(HubRequestRules.nativeOnlyPath("/api/devices/pair"));
    assertTrue(HubRequestRules.nativeOnlyPath("/api/devices/pair/"));
    assertTrue(HubRequestRules.nativeOnlyPath("/api/devices/PAIR?x=1"));
    assertTrue(HubRequestRules.nativeOnlyPath(null));
    assertFalse(HubRequestRules.nativeOnlyPath("/api/devices/pairings"));
    assertFalse(HubRequestRules.nativeOnlyPath("/api/devices"));
  }

  @Test
  public void methodsAndHeaders() {
    assertEquals("PATCH", HubRequestRules.method("patch"));
    assertEquals("GET", HubRequestRules.method("GET"));
    assertNull(HubRequestRules.method("TRACE"));
    assertNull(HubRequestRules.method("CONNECT"));
    assertNull(HubRequestRules.method(null));
    assertTrue(HubRequestRules.callerHeaderAllowed("Content-Type", "application/json"));
    assertTrue(HubRequestRules.callerHeaderAllowed("accept", "application/json"));
    assertFalse(HubRequestRules.callerHeaderAllowed("Authorization", "Bearer x"));
    assertFalse(HubRequestRules.callerHeaderAllowed("cookie", "s=1"));
    assertFalse(HubRequestRules.callerHeaderAllowed("Host", "evil.example"));
    assertFalse(HubRequestRules.callerHeaderAllowed("X-Forwarded-For", "1.2.3.4"));
    assertFalse(HubRequestRules.callerHeaderAllowed("accept", "a\r\nAuthorization: x"));
  }

  @Test
  public void pairingCodes() {
    assertTrue(HubRequestRules.validPairingCode("abcDEF12_-xyz"));
    assertFalse(HubRequestRules.validPairingCode("short"));
    assertFalse(HubRequestRules.validPairingCode("has space 123"));
    assertFalse(HubRequestRules.validPairingCode(null));
  }
}

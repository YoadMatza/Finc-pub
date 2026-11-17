package il.finc.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Stock insights step 2: only SEC pages go to the system browser. Mirrors apps/web/src/insightsCompany.test.ts. */
public class ExternalLinkRulesTest {
  @Test
  public void secLinksAreAccepted() {
    for (String u : new String[] {
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000100/aapl-20260930.htm",
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=320193",
      "https://www.sec.gov/ix?doc=/Archives/edgar/data/320193/x.htm#part1",
    }) {
      assertEquals(u, u, ExternalLinkRules.secUrl(u));
    }
  }

  @Test
  public void anythingElseIsRefused() {
    for (String u : new String[] {
      null,
      "",
      "http://www.sec.gov/Archives/x.htm",
      "https://sec.gov/Archives/x.htm",
      "https://data.sec.gov/x",
      "https://www.sec.gov.evil.com/x",
      "https://www.sec.gov@evil.com/x",
      "https://www.sec.gov:8443/x",
      "https://www.sec.gov:443/x",
      "https://user:pw@www.sec.gov/x",
      "https://www.sec.gov",
      "HTTPS://WWW.SEC.GOV/x",
      "javascript:alert(1)//https://www.sec.gov/",
      "intent://www.sec.gov/#Intent;scheme=https;end",
      " https://www.sec.gov/x",
      "https://www.sec.gov/\\@evil.com",
      "https://www.sec.gov/a b",
      "https://www.sec.gov/a\nb",
      "https://www.sec.gov/א",
      "https://www.sec.gov/" + "a".repeat(3000),
    }) {
      assertNull(String.valueOf(u), ExternalLinkRules.secUrl(u));
    }
  }

  /** Decision aids C: news articles open in the browser. Mirrors apps/web/src/insightsNews.test.ts (newsLink). */
  @Test
  public void newsLinksAreAccepted() {
    for (String u : new String[] {
      "https://example.com/a?b=1",
      "https://news.example.co.il/2026/11/16/story.html#top",
      "https://finnhub.io/api/news?id=abc123",
      "https://www.sec.gov/Archives/x.htm",
    }) {
      assertEquals(u, u, ExternalLinkRules.newsUrl(u));
      assertEquals(u, u, ExternalLinkRules.externalUrl(u));
    }
  }

  @Test
  public void badNewsLinksAreRefused() {
    for (String u : new String[] {
      null,
      "",
      "http://example.com/",
      "javascript:alert(1)",
      "data:text/html,x",
      "intent://example.com/#Intent;scheme=https;end",
      "file:///sdcard/x",
      "https://",
      "https://localhost/x",
      "https://example./x",
      "https://user:pw@example.com/",
      "https://example.com@evil.com/",
      "https://example.com:8443/x",
      "https://exa mple.com/",
      "https://example.com\\@evil.com",
      "https://example.com/א",
      "https://example.com/a\nb",
      "HTTPS://EXAMPLE.COM/",
      "https://example.com/" + "a".repeat(3000),
    }) {
      assertNull(String.valueOf(u), ExternalLinkRules.newsUrl(u));
      assertNull(String.valueOf(u), ExternalLinkRules.externalUrl(u));
    }
  }
}

import { describe, expect, it } from 'vitest';
import { connectErrorKey, requestOptionsFrom, safeConnectRedirect, validRequestId } from './connect';

describe('safeConnectRedirect', () => {
  it("accepts ChatGPT's and Claude's https callbacks", () => {
    expect(safeConnectRedirect('https://chatgpt.com/connector_platform_oauth_redirect?code=abc&state=x&iss=https%3A%2F%2Fh')).toBe(
      'https://chatgpt.com/connector_platform_oauth_redirect?code=abc&state=x&iss=https%3A%2F%2Fh',
    );
    expect(safeConnectRedirect('https://claude.ai/api/mcp/auth_callback?code=1')).toBe('https://claude.ai/api/mcp/auth_callback?code=1');
    expect(safeConnectRedirect('https://claude.com/api/mcp/auth_callback?error=access_denied')).toBe('https://claude.com/api/mcp/auth_callback?error=access_denied');
    expect(safeConnectRedirect('https://ChatGPT.com/connector/oauth/abc')).toBe('https://chatgpt.com/connector/oauth/abc');
  });
  it('refuses http and other schemes', () => {
    expect(safeConnectRedirect('http://chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('javascript:alert(1)')).toBeNull();
    expect(safeConnectRedirect('JavaScript://chatgpt.com/%0aalert(1)')).toBeNull();
    expect(safeConnectRedirect('data:text/html,hi')).toBeNull();
    expect(safeConnectRedirect('//chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('/settings')).toBeNull();
  });
  it('refuses other hosts and look-alikes', () => {
    expect(safeConnectRedirect('https://evil.com/x')).toBeNull();
    expect(safeConnectRedirect('https://chatgpt.com.evil.com/x')).toBeNull();
    expect(safeConnectRedirect('https://evilchatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('https://www.chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('https://api.claude.ai/x')).toBeNull();
    expect(safeConnectRedirect('https://chatgpt.com./x')).toBeNull();
    expect(safeConnectRedirect('https://openai.com/x')).toBeNull();
  });
  it('refuses user info', () => {
    expect(safeConnectRedirect('https://user@chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('https://user:pw@claude.ai/x')).toBeNull();
    expect(safeConnectRedirect('https://chatgpt.com@evil.com/x')).toBeNull();
    expect(safeConnectRedirect('https://@chatgpt.com/x')).toBeNull();
  });
  it('refuses any port, the default one too', () => {
    expect(safeConnectRedirect('https://chatgpt.com:8443/x')).toBeNull();
    expect(safeConnectRedirect('https://claude.ai:443/x')).toBeNull();
    expect(safeConnectRedirect('https://claude.ai:/x')).toBeNull();
  });
  it('refuses backslashes, whitespace and junk', () => {
    expect(safeConnectRedirect('https:\\\\chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('https://evil.com\\@chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect(' https://chatgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('https://chat\tgpt.com/x')).toBeNull();
    expect(safeConnectRedirect('')).toBeNull();
    expect(safeConnectRedirect(null)).toBeNull();
    expect(safeConnectRedirect(42)).toBeNull();
    expect(safeConnectRedirect('https://')).toBeNull();
  });
});

describe('validRequestId', () => {
  it('accepts URL-safe ids only', () => {
    expect(validRequestId('a1B2_c3-d4')).toBe(true);
    expect(validRequestId('')).toBe(false);
    expect(validRequestId(null)).toBe(false);
    expect(validRequestId('../x')).toBe(false);
    expect(validRequestId('a b')).toBe(false);
    expect(validRequestId('x'.repeat(201))).toBe(false);
  });
});

describe('connectErrorKey', () => {
  it('maps each code and nothing else', () => {
    expect(connectErrorKey('not_found')).toBe('connect_err_not_found');
    expect(connectErrorKey('expired')).toBe('connect_err_expired');
    expect(connectErrorKey('window_closed')).toBe('connect_err_window_closed');
    expect(connectErrorKey('used')).toBe('connect_err_used');
    expect(connectErrorKey('toString')).toBeNull();
    expect(connectErrorKey(undefined)).toBeNull();
  });
});

describe('requestOptionsFrom', () => {
  it('takes bare or wrapped options', () => {
    const opts = { challenge: 'abc', rpId: 'h' };
    expect(requestOptionsFrom(opts)).toEqual(opts);
    expect(requestOptionsFrom({ options: opts })).toEqual(opts);
    expect(requestOptionsFrom({ error: 'x' })).toBeNull();
    expect(requestOptionsFrom(null)).toBeNull();
  });
});

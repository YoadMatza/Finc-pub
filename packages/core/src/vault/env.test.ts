import { describe, expect, it } from 'vitest';
import { isSecretEnvName, scrubSecretEnv } from './env.js';

describe('secret environment scrub', () => {
  it('removes API keys, tokens and passwords of any project but keeps finc configuration', () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'sk-other-project',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      RISEUP_PAT: 'riseup_pat_x',
      SOME_SERVICE_TOKEN: 't',
      MY_APP_PASSWORD: 'p',
      AWS_SECRET_ACCESS_KEY: 's',
      STRIPE_SECRET: 's',
      FINC_PORT: '7733',
      FINC_DATA_DIR: './data',
      TZ: 'Asia/Jerusalem',
      PATH: '/usr/bin',
      LOG_LEVEL: 'info',
    };
    const removed = scrubSecretEnv(env).sort();
    expect(removed).toEqual(['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'MY_APP_PASSWORD', 'OPENAI_API_KEY', 'RISEUP_PAT', 'SOME_SERVICE_TOKEN', 'STRIPE_SECRET']);
    expect(Object.keys(env).sort()).toEqual(['FINC_DATA_DIR', 'FINC_PORT', 'LOG_LEVEL', 'PATH', 'TZ']);
    expect(isSecretEnvName('FINC_SYNC_TIMES')).toBe(false);
    expect(isSecretEnvName('openai_api_key')).toBe(true);
    expect(isSecretEnvName('ProgramFiles')).toBe(false);
  });
});

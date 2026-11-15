import { describe, expect, it } from 'vitest';
import { PINNED } from './version.js';

describe('pins', () => {
  it('pins israeli-bank-scrapers', () => {
    expect(PINNED.israeliBankScrapers).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

import { cleanErrorText, redact, stripUrlQuery } from '@finc/core';
import pino from 'pino';

/** Options shared by the process logger and tests (a test can point the same options at its own stream). */
export const LOG_OPTIONS: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  // P2-09: every log object goes through redact(): credential-shaped keys censored at any depth, error text cleaned,
  // URL query strings stripped. Runs before pino's serializers, so an Error stays an Error for the err serializer.
  formatters: {
    log: (obj) => (Object.keys(obj).length ? (redact(obj) as Record<string, unknown>) : obj),
  },
  hooks: {
    // the message string(s): URL query strings stripped (a string with no "://" passes untouched)
    logMethod(args, method) {
      // log.error(err) or log.error({ err }) without a message: pino would use the error's raw message as msg; give
      // it the cleaned one
      if (args.length === 1) {
        const a = args[0] as unknown;
        const e = a instanceof Error ? a : a && typeof a === 'object' && (a as { msg?: unknown }).msg === undefined ? (a as { err?: unknown }).err : undefined;
        if (e instanceof Error) (args as unknown[]).push(cleanErrorText(e.message, 1000));
      }
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as unknown;
        if (typeof a === 'string' && a.includes('://')) (args as unknown[])[i] = stripUrlQuery(a);
      }
      return method.apply(this, args);
    },
  },
};

/** Process-wide logger. */
export const log = pino(LOG_OPTIONS);

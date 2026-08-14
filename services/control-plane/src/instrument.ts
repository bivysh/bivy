// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Optional Sentry error reporting.
//
// @sentry/node is a large dependency; importing it eagerly adds seconds to a
// cold `tsx` boot even when no DSN is configured (dev, tests, self-host). So the
// SDK is loaded LAZILY — only when SENTRY_DSN is set, which is only on the hosted
// deploy. With no DSN, initSentry() returns cheap no-ops and @sentry/node is
// never imported. We use Sentry for error capture only (tracesSampleRate 0), so
// loading it after express/http is imported is fine — the late import only costs
// automatic performance tracing, which is off.
//
// The control plane stores only metadata (never prompts, transcripts, files, or
// model credentials), so captured events cannot contain session content.

export interface SentryFacade {
  captureException: (error: unknown) => void;
}

const noop: SentryFacade = {
  captureException: () => {},
};

export async function initSentry(): Promise<SentryFacade> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return noop;

  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE,
    // Errors only by default; performance tracing multiplies quota use and the
    // free tier is small. Opt in with SENTRY_TRACES_SAMPLE_RATE.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    serverName: "control-plane",
  });

  return {
    captureException: (error) => {
      Sentry.captureException(error);
    },
  };
}

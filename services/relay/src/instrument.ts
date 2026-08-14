// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Optional Sentry error reporting for the relay.
//
// @sentry/node is a large dependency; importing it eagerly slows a cold `tsx`
// boot even with no DSN configured (dev, tests, self-host), which matters here
// because the relay's own e2e boots it alongside the control plane. So the SDK
// is loaded LAZILY — only when SENTRY_DSN is set (the hosted deploy). With no DSN,
// initSentry() returns a cheap no-op and @sentry/node is never imported.
//
// The relay forwards opaque E2E frames it cannot read, so nothing sensitive is
// available to capture even when enabled.

export interface SentryFacade {
  captureException: (error: unknown) => void;
}

const noop: SentryFacade = { captureException: () => {} };

export async function initSentry(): Promise<SentryFacade> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return noop;

  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE,
    // Errors only by default; tracing is a paid-plan cost multiplier and the
    // relay has no meaningful spans to sample. Opt in with the env var.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    serverName: process.env.RELAY_SHARD_ID ? `relay-${process.env.RELAY_SHARD_ID}` : "relay",
  });

  return {
    captureException: (error) => {
      Sentry.captureException(error);
    },
  };
}

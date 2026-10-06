/**
 * Sentry Client-Side Configuration
 *
 * This file configures the Sentry SDK for client-side error tracking.
 */

import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,

    // Replay configuration for session replay
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],

    // Performance Monitoring - sample rate for traces
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Session Replay - capture replays only on errors
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: process.env.NODE_ENV === 'production' ? 1.0 : 0,

    // Ignore common non-actionable errors
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
      /Loading chunk \d+ failed/,
      'Network request failed',
      'Failed to fetch',
      'AbortError',
      'User cancelled',
      'ChunkLoadError',
      'Script error.',
    ],

    // Don't track development errors unless explicitly enabled
    beforeSend(event, hint) {
      if (process.env.NODE_ENV === 'development' && !process.env.NEXT_PUBLIC_SENTRY_DEBUG) {
        console.error('[Sentry Client]', hint.originalException)
        return null
      }
      return event
    },

  })
}

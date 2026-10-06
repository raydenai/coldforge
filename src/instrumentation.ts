/**
 * Next.js Instrumentation
 *
 * This file is used to initialize Sentry and other monitoring tools
 * when the Next.js server starts.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Validate configuration before anything else starts. Throws in production
    // so a misconfigured deployment fails at boot rather than at the first
    // request that touches a missing secret.
    const { validateEnv } = await import('@/lib/env')
    validateEnv()

    // Server-side Sentry initialization
    const { initSentry } = await import('@/lib/sentry')
    initSentry()
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    // Edge runtime Sentry initialization
    const { initSentry } = await import('@/lib/sentry')
    initSentry()
  }
}

export const onRequestError = async (
  err: Error & { digest?: string },
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) => {
  void context
  // Track request errors in Sentry
  const { trackAPIError } = await import('@/lib/sentry')

  trackAPIError(err, {
    method: request.method,
    path: request.path,
    statusCode: 500,
  })
}

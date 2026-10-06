// Request logging middleware for Next.js API routes
import { NextRequest, NextResponse } from 'next/server'
import { logger, logRequest, logError, generateRequestId, type RequestContext } from './index'
import {
  createRequestContext,
  runWithContextAsync,
  updateRequestContext,
  getRequestContext,
  getRequestDuration,
} from './context'

/**
 * Extract request metadata from NextRequest
 */
export function extractRequestMetadata(request: NextRequest): {
  method: string
  path: string
  query: Record<string, string>
  userAgent: string | undefined
  ip: string | undefined
  requestId: string
} {
  const url = new URL(request.url)
  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  return {
    method: request.method,
    path: url.pathname,
    query,
    userAgent: request.headers.get('user-agent') || undefined,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        undefined,
    requestId: request.headers.get('x-request-id') || generateRequestId(),
  }
}

/**
 * Middleware wrapper that adds request logging and context
 * Use this to wrap API route handlers
 */
export function withRequestLogging<T extends (request: NextRequest, ...args: unknown[]) => Promise<NextResponse>>(
  handler: T,
  _options?: {
    logRequestBody?: boolean
    logResponseBody?: boolean
  }
): T {
  return (async (request: NextRequest, ...args: unknown[]) => {
    const metadata = extractRequestMetadata(request)

    const context = createRequestContext(
      metadata.method,
      metadata.path,
      {
        requestId: metadata.requestId,
        query: metadata.query,
        userAgent: metadata.userAgent,
        ip: metadata.ip,
      }
    )

    return runWithContextAsync(context, async () => {
      let response: NextResponse
      let statusCode = 500

      try {
        // Execute the handler
        response = await handler(request, ...args)
        statusCode = response.status

        // Add request ID to response headers
        response.headers.set('x-request-id', context.requestId)

        return response
      } catch (error) {
        // Log any uncaught errors
        if (error instanceof Error) {
          logError(error, {
            requestId: context.requestId,
            method: metadata.method,
            path: metadata.path,
            userId: context.userId,
          })
        }
        throw error
      } finally {
        // Log the request completion
        const duration = getRequestDuration()
        const ctx = getRequestContext()

        logRequest(
          metadata.method,
          metadata.path,
          statusCode,
          duration,
          {
            requestId: context.requestId,
            userId: ctx?.userId,
            organizationId: ctx?.organizationId,
            userAgent: metadata.userAgent,
            ip: metadata.ip,
          }
        )
      }
    })
  }) as T
}

/**
 * Helper to update context with user information after authentication
 * Call this after successful auth to add userId to all subsequent logs
 */
export function setAuthContext(userId: string, organizationId?: string): void {
  updateRequestContext({
    userId,
    organizationId,
  })
}

/**
 * Create a logging context for non-HTTP operations (e.g., background jobs, webhooks)
 */
export function createJobContext(
  jobName: string,
  options?: {
    jobId?: string
    userId?: string
    organizationId?: string
  }
): RequestContext {
  return {
    requestId: options?.jobId || generateRequestId(),
    method: 'JOB',
    path: jobName,
    userId: options?.userId,
    organizationId: options?.organizationId,
    startTime: Date.now(),
  }
}

/**
 * Higher-order function to wrap API handlers with logging
 * Simpler alternative to middleware for individual routes
 */
export function withLogging(
  operation: string,
  handler: (request: NextRequest) => Promise<{ response: NextResponse; userId?: string; organizationId?: string }>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const metadata = extractRequestMetadata(request)
    const startTime = Date.now()
    let statusCode = 500
    let userId: string | undefined
    let organizationId: string | undefined

    try {
      const result = await handler(request)
      statusCode = result.response.status
      userId = result.userId
      organizationId = result.organizationId

      // Add request ID to response
      result.response.headers.set('x-request-id', metadata.requestId)

      return result.response
    } catch (error) {
      if (error instanceof Error) {
        logError(error, {
          operation,
          requestId: metadata.requestId,
          method: metadata.method,
          path: metadata.path,
        })
      }
      throw error
    } finally {
      const duration = Date.now() - startTime
      logRequest(metadata.method, metadata.path, statusCode, duration, {
        requestId: metadata.requestId,
        userId,
        organizationId,
        userAgent: metadata.userAgent,
        ip: metadata.ip,
      })
    }
  }
}

/**
 * Log operation start (for long-running operations)
 */
export function logOperationStart(operation: string, context?: Record<string, unknown>): void {
  const reqContext = getRequestContext()

  logger.info({
    type: 'operation_start',
    operation,
    requestId: reqContext?.requestId,
    userId: reqContext?.userId,
    ...context,
  }, `Starting: ${operation}`)
}

/**
 * Log operation end (for long-running operations)
 */
export function logOperationEnd(
  operation: string,
  success: boolean,
  durationMs: number,
  context?: Record<string, unknown>
): void {
  const reqContext = getRequestContext()

  // Bound: pino's level methods rely on `this`, so a detached reference throws.
  const log = success ? logger.info.bind(logger) : logger.error.bind(logger)

  log({
    type: 'operation_end',
    operation,
    success,
    durationMs,
    requestId: reqContext?.requestId,
    userId: reqContext?.userId,
    ...context,
  }, `${success ? 'Completed' : 'Failed'}: ${operation} (${durationMs}ms)`)
}

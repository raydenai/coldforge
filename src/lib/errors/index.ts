// Error handling utilities for InstantScale
// Comprehensive error class hierarchy with typed errors

/**
 * Base application error class
 * All custom errors should extend this class
 */
export class AppError extends Error {
  public readonly code: string
  public readonly statusCode: number
  public readonly isOperational: boolean
  public readonly details?: Record<string, unknown>

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    details?: Record<string, unknown>
  ) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.details = details
    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    }
  }
}

/**
 * Validation errors (400)
 * Used when request data fails validation
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, true, details)
  }
}

/**
 * Authentication errors (401)
 * Used when user is not authenticated
 */
export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_ERROR', 401, true)
  }
}

/**
 * Authorization errors (403)
 * Used when user lacks permission for an action
 */
export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 'AUTHORIZATION_ERROR', 403, true)
  }
}

/**
 * Not found errors (404)
 * Used when a requested resource doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource', id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      'NOT_FOUND',
      404,
      true
    )
  }
}

/**
 * Conflict errors (409)
 * Used when operation conflicts with existing state (e.g., duplicate)
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', 409, true, details)
  }
}

/**
 * Rate limit errors (429)
 * Used when user exceeds rate limits
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number

  constructor(retryAfter: number = 60) {
    super('Too many requests', 'RATE_LIMIT', 429, true, { retryAfter })
    this.retryAfter = retryAfter
  }
}

/**
 * External service errors (502/503)
 * Used when external services fail.
 *
 * `cause` accepts either an explicit message or the underlying error that was
 * caught. When omitted, a generic message naming the service is used so the
 * error is still safe to surface without leaking provider internals.
 */
export class ExternalServiceError extends AppError {
  public readonly service: string

  constructor(service: string, cause?: string | Error, details?: Record<string, unknown>) {
    const originalMessage = cause instanceof Error ? cause.message : cause
    super(
      typeof cause === 'string' ? cause : `External service error: ${service}`,
      'EXTERNAL_SERVICE_ERROR',
      502,
      true,
      { service, originalMessage, ...details }
    )
    this.service = service
  }
}

/**
 * Database errors (500)
 * Used for database operation failures
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DATABASE_ERROR', 500, true, details)
  }
}

/**
 * Email/SMTP errors (500)
 * Used for email sending failures
 */
export class EmailError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'EMAIL_ERROR', 500, true, details)
  }
}

/**
 * DNS errors (500)
 * Used for DNS configuration/lookup failures
 */
export class DnsError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'DNS_ERROR', 500, true, details)
  }
}

/**
 * Configuration errors (500)
 * Used when system configuration is invalid
 */
export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', 500, false, details)
  }
}

/**
 * Bad request errors (400)
 * Generic bad request for malformed requests
 */
export class BadRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BAD_REQUEST', 400, true, details)
  }
}

/**
 * Quota exceeded errors (402/403)
 * Used when user exceeds plan limits
 */
export class QuotaExceededError extends AppError {
  constructor(resource: string, limit: number, details?: Record<string, unknown>) {
    super(
      `${resource} quota exceeded. Limit: ${limit}`,
      'QUOTA_EXCEEDED',
      403,
      true,
      { resource, limit, ...details }
    )
  }
}

// Type guard for checking if error is an AppError
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

// Convert unknown error to AppError
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error
  }

  if (error instanceof Error) {
    return new AppError(error.message, 'INTERNAL_ERROR', 500, false)
  }

  return new AppError('An unexpected error occurred', 'UNKNOWN_ERROR', 500, false)
}

// Error response helper for API routes (legacy - use handleApiError instead)
export function errorResponse(error: unknown) {
  const appError = toAppError(error)

  return Response.json(appError.toJSON(), {
    status: appError.statusCode,
  })
}

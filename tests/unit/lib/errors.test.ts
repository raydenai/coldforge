import { describe, it, expect } from 'vitest'
import {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ConflictError,
  ExternalServiceError,
  isAppError,
  toAppError,
  errorResponse,
} from '@/lib/errors'

describe('errors', () => {
  describe('AppError', () => {
    it('should create error with all properties', () => {
      const error = new AppError('Test error', 'TEST_CODE', 400, true, { key: 'value' })

      expect(error.message).toBe('Test error')
      expect(error.code).toBe('TEST_CODE')
      expect(error.statusCode).toBe(400)
      expect(error.isOperational).toBe(true)
      expect(error.details).toEqual({ key: 'value' })
      expect(error.name).toBe('AppError')
    })

    it('should use default values', () => {
      const error = new AppError('Test error', 'TEST_CODE')

      expect(error.statusCode).toBe(500)
      expect(error.isOperational).toBe(true)
      expect(error.details).toBeUndefined()
    })

    it('should have stack trace', () => {
      const error = new AppError('Test error', 'TEST_CODE')
      expect(error.stack).toBeDefined()
    })

    it('should serialize to JSON correctly', () => {
      const error = new AppError('Test error', 'TEST_CODE', 400, true, { detail: 'info' })
      const json = error.toJSON()

      expect(json).toEqual({
        error: {
          code: 'TEST_CODE',
          message: 'Test error',
          details: { detail: 'info' },
        },
      })
    })

    it('should serialize without context when not provided', () => {
      const error = new AppError('Test error', 'TEST_CODE')
      const json = error.toJSON()

      expect(json).toEqual({
        error: {
          code: 'TEST_CODE',
          message: 'Test error',
        },
      })
    })
  })

  describe('ValidationError', () => {
    it('should create validation error with defaults', () => {
      const error = new ValidationError('Invalid input')

      expect(error.message).toBe('Invalid input')
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.statusCode).toBe(400)
      expect(error.isOperational).toBe(true)
      expect(error.name).toBe('ValidationError')
    })

    it('should include details', () => {
      const error = new ValidationError('Invalid input', { field: 'email' })

      expect(error.details).toEqual({ field: 'email' })
    })

    it('should be instance of AppError', () => {
      const error = new ValidationError('Invalid input')
      expect(error).toBeInstanceOf(AppError)
    })
  })

  describe('AuthenticationError', () => {
    it('should create authentication error with default message', () => {
      const error = new AuthenticationError()

      expect(error.message).toBe('Authentication required')
      expect(error.code).toBe('AUTHENTICATION_ERROR')
      expect(error.statusCode).toBe(401)
      expect(error.name).toBe('AuthenticationError')
    })

    it('should allow custom message', () => {
      const error = new AuthenticationError('Token expired')
      expect(error.message).toBe('Token expired')
    })
  })

  describe('AuthorizationError', () => {
    it('should create authorization error with default message', () => {
      const error = new AuthorizationError()

      expect(error.message).toBe('Access denied')
      expect(error.code).toBe('AUTHORIZATION_ERROR')
      expect(error.statusCode).toBe(403)
      expect(error.name).toBe('AuthorizationError')
    })

    it('should allow custom message', () => {
      const error = new AuthorizationError('Admin access required')
      expect(error.message).toBe('Admin access required')
    })
  })

  describe('NotFoundError', () => {
    it('should create not found error with default resource', () => {
      const error = new NotFoundError()

      expect(error.message).toBe('Resource not found')
      expect(error.code).toBe('NOT_FOUND')
      expect(error.statusCode).toBe(404)
      expect(error.name).toBe('NotFoundError')
    })

    it('should use custom resource name', () => {
      const error = new NotFoundError('User')
      expect(error.message).toBe('User not found')
    })

    it('should use custom resource for campaign', () => {
      const error = new NotFoundError('Campaign')
      expect(error.message).toBe('Campaign not found')
    })

    it('should include the id when provided', () => {
      const error = new NotFoundError('Domain', 'dom_123')
      expect(error.message).toBe("Domain with id 'dom_123' not found")
    })
  })

  describe('RateLimitError', () => {
    it('should create rate limit error with default retry', () => {
      const error = new RateLimitError()

      expect(error.message).toBe('Too many requests')
      expect(error.code).toBe('RATE_LIMIT')
      expect(error.statusCode).toBe(429)
      expect(error.details).toEqual({ retryAfter: 60 })
      expect(error.retryAfter).toBe(60)
      expect(error.name).toBe('RateLimitError')
    })

    it('should use custom retry after', () => {
      const error = new RateLimitError(120)
      expect(error.details).toEqual({ retryAfter: 120 })
      expect(error.retryAfter).toBe(120)
    })
  })

  describe('ConflictError', () => {
    it('should create conflict error', () => {
      const error = new ConflictError('Email already exists')

      expect(error.message).toBe('Email already exists')
      expect(error.code).toBe('CONFLICT')
      expect(error.statusCode).toBe(409)
      expect(error.name).toBe('ConflictError')
    })
  })

  describe('ExternalServiceError', () => {
    it('should create external service error', () => {
      const error = new ExternalServiceError('Stripe')

      expect(error.message).toBe('External service error: Stripe')
      expect(error.code).toBe('EXTERNAL_SERVICE_ERROR')
      expect(error.statusCode).toBe(502)
      expect(error.details).toEqual({ service: 'Stripe', originalMessage: undefined })
      expect(error.service).toBe('Stripe')
      expect(error.name).toBe('ExternalServiceError')
    })

    it('should include original error message', () => {
      const originalError = new Error('Connection timeout')
      const error = new ExternalServiceError('Stripe', originalError)

      expect(error.details).toEqual({
        service: 'Stripe',
        originalMessage: 'Connection timeout',
      })
    })

    it('should use an explicit message when given a string cause', () => {
      const error = new ExternalServiceError('Winnr', 'Mailbox provisioning failed')

      expect(error.message).toBe('Mailbox provisioning failed')
      expect(error.details).toEqual({
        service: 'Winnr',
        originalMessage: 'Mailbox provisioning failed',
      })
    })
  })

  describe('isAppError', () => {
    it('should return true for AppError', () => {
      const error = new AppError('Test', 'TEST')
      expect(isAppError(error)).toBe(true)
    })

    it('should return true for AppError subclasses', () => {
      expect(isAppError(new ValidationError('test'))).toBe(true)
      expect(isAppError(new AuthenticationError())).toBe(true)
      expect(isAppError(new AuthorizationError())).toBe(true)
      expect(isAppError(new NotFoundError())).toBe(true)
      expect(isAppError(new RateLimitError())).toBe(true)
      expect(isAppError(new ConflictError('test'))).toBe(true)
      expect(isAppError(new ExternalServiceError('test'))).toBe(true)
    })

    it('should return false for regular Error', () => {
      expect(isAppError(new Error('test'))).toBe(false)
    })

    it('should return false for non-error values', () => {
      expect(isAppError('string')).toBe(false)
      expect(isAppError(123)).toBe(false)
      expect(isAppError(null)).toBe(false)
      expect(isAppError(undefined)).toBe(false)
      expect(isAppError({})).toBe(false)
    })
  })

  describe('toAppError', () => {
    it('should return same error if already AppError', () => {
      const error = new AppError('Test', 'TEST', 400)
      const result = toAppError(error)

      expect(result).toBe(error)
    })

    it('should convert regular Error to AppError', () => {
      const error = new Error('Something went wrong')
      const result = toAppError(error)

      expect(result).toBeInstanceOf(AppError)
      expect(result.message).toBe('Something went wrong')
      expect(result.code).toBe('INTERNAL_ERROR')
      expect(result.statusCode).toBe(500)
      expect(result.isOperational).toBe(false)
    })

    it('should handle non-Error values', () => {
      const result = toAppError('string error')

      expect(result).toBeInstanceOf(AppError)
      expect(result.message).toBe('An unexpected error occurred')
      expect(result.code).toBe('UNKNOWN_ERROR')
      expect(result.isOperational).toBe(false)
    })

    it('should handle null', () => {
      const result = toAppError(null)
      expect(result.code).toBe('UNKNOWN_ERROR')
    })

    it('should handle undefined', () => {
      const result = toAppError(undefined)
      expect(result.code).toBe('UNKNOWN_ERROR')
    })

    it('should handle object without message', () => {
      const result = toAppError({ foo: 'bar' })
      expect(result.code).toBe('UNKNOWN_ERROR')
    })
  })

  describe('errorResponse', () => {
    it('should create JSON response for AppError', async () => {
      const error = new ValidationError('Invalid email', { field: 'email' })
      const response = errorResponse(error)

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid email',
          details: { field: 'email' },
        },
      })
    })

    it('should create JSON response for regular Error', async () => {
      const error = new Error('Something failed')
      const response = errorResponse(error)

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something failed',
        },
      })
    })

    it('should handle NotFoundError', async () => {
      const error = new NotFoundError('Campaign')
      const response = errorResponse(error)

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.error.message).toBe('Campaign not found')
    })

    it('should handle RateLimitError', async () => {
      const error = new RateLimitError(30)
      const response = errorResponse(error)

      expect(response.status).toBe(429)
      const body = await response.json()
      expect(body.error.details).toEqual({ retryAfter: 30 })
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  validateWithZeroBounce,
  ZeroBounceAddressMismatchError,
  ZeroBounceInvalidResponseError,
  ZeroBounceNotConfiguredError,
  ZeroBounceResponseError,
  ZeroBounceTimeoutError,
} from '@/lib/outreach/validation-provider'
import { ZEROBOUNCE } from '@/lib/outreach/validation'

const okBody = {
  address: 'person@example.com',
  status: 'valid',
  sub_status: '',
  processed_at: '2026-10-05T12:00:00.000Z',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ZeroBounce adapter boundaries (no network)', () => {
  it('uses the fixed origin, form encoding, manual redirects, and makes exactly one request', async () => {
    const fetchImpl = vi.fn(async () => Response.json(okBody))
    const receipt = await validateWithZeroBounce(' Person@Example.com ', { apiKey: 'test-key', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(ZEROBOUNCE.endpoint)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(String(init.body)).toContain('email=person%40example.com')
    expect(String(init.body)).toContain('timeout=10')
    expect(receipt.status).toBe('valid')
    expect(receipt.address).toBe('person@example.com')
  })

  it('fails closed when no key is configured', async () => {
    await expect(validateWithZeroBounce('person@example.com', { apiKey: '' })).rejects.toBeInstanceOf(ZeroBounceNotConfiguredError)
  })

  it('refuses a receipt for a different address', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...okBody, address: 'other@example.com' }))
    await expect(validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl })).rejects.toBeInstanceOf(ZeroBounceAddressMismatchError)
  })

  it('refuses redirects instead of following them', async () => {
    const fetchImpl = vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false } as unknown as Response))
    await expect(validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl })).rejects.toBeInstanceOf(ZeroBounceResponseError)
  })

  it('rejects an oversized or non-JSON body', async () => {
    const oversized = vi.fn(async () => new Response('x'.repeat(64), { status: 200 }))
    await expect(
      validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl: oversized, maxResponseChars: 32 })
    ).rejects.toBeInstanceOf(ZeroBounceInvalidResponseError)

    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl: notJson })).rejects.toBeInstanceOf(ZeroBounceInvalidResponseError)
  })

  it('rejects a provider HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 }))
    const error = await validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZeroBounceResponseError)
    expect((error as Error).message).not.toContain('test-key')
  })

  it('aborts at the deadline without retrying', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    )
    const promise = validateWithZeroBounce('person@example.com', { apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 3000 })
    const assertion = expect(promise).rejects.toBeInstanceOf(ZeroBounceTimeoutError)
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never trusts an unparseable processed_at and always returns a server receivedAt', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...okBody, processed_at: 'not-a-date' }))
    const receipt = await validateWithZeroBounce('person@example.com', {
      apiKey: 'test-key',
      fetchImpl,
      now: () => new Date('2026-10-06T01:00:00.000Z'),
    })
    expect(receipt.processedAt).toBeNull()
    expect(receipt.receivedAt).toBe('2026-10-06T01:00:00.000Z')
  })

  it('normalizes a real provider processed_at as a reference', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...okBody, processed_at: '2026-10-05T12:00:00Z' }))
    const receipt = await validateWithZeroBounce('person@example.com', {
      apiKey: 'test-key',
      fetchImpl,
      now: () => new Date('2026-10-06T01:00:00.000Z'),
    })
    expect(receipt.processedAt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('never puts the api key or address in a thrown message', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...okBody, address: 'other@example.com' }))
    const error = await validateWithZeroBounce('person@example.com', { apiKey: 'super-secret-key', fetchImpl }).catch((e: unknown) => e)
    expect(String(error)).not.toContain('super-secret-key')
    expect(String(error)).not.toContain('person@example.com')
  })
})

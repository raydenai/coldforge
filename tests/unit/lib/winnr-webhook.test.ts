/**
 * Winnr webhook signature verification tests.
 *
 * Official delivery contract, from the top-level `webhooks` section of the
 * public Winnr OpenAPI document (`https://app.winnr.app/openapi.yaml`,
 * downloaded 2026-10-05, SHA256
 * 675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994):
 *
 *   - `X-Winnr-Timestamp` — unix seconds when the delivery was signed
 *   - `X-Winnr-Signature` — `v1=<hex>` where hex is
 *     HMAC-SHA256("{timestamp}.{raw_body}") keyed with the endpoint's
 *     `whsec_` secret. During the 24h rotation grace window there are TWO
 *     comma-separated `v1=` values (old and new secret) — accept the delivery
 *     if ANY value matches.
 *
 * Replay bound: 300 seconds (launch plan Task 2). Constant-time comparison.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { verifyWinnrSignature } from '@/lib/winnr/webhook'

// Generate a fixture-only key so no credential-shaped literal is committed.
const SECRET = `whsec_${randomBytes(24).toString('hex')}`
const NOW = 1_800_000_000_000 // epoch millis
const TS = Math.floor(NOW / 1000) // unix seconds
const BODY = JSON.stringify({ id: 'evt_01J9XK4T8Q2M5N7P', type: 'message.relayed' })

function sign(timestamp: number | string, raw: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
}

function headers(timestamp: string | null, signature: string | null) {
  return { timestamp, signature }
}

describe('verifyWinnrSignature', () => {
  it('accepts a correctly signed delivery', () => {
    expect(verifyWinnrSignature(BODY, headers(String(TS), `v1=${sign(TS, BODY)}`), SECRET, NOW)).toBe(
      true
    )
  })

  it('verifies over raw bytes, whether passed as string or Buffer', () => {
    const signature = `v1=${sign(TS, BODY)}`
    const bufferSignature = sign(TS, Buffer.from(BODY, 'utf8'))
    expect(bufferSignature).toBe(sign(TS, BODY))
    expect(verifyWinnrSignature(Buffer.from(BODY, 'utf8'), headers(String(TS), signature), SECRET, NOW)).toBe(
      true
    )
    expect(verifyWinnrSignature(Buffer.from(BODY, 'utf8'), headers(String(TS), `v1=${bufferSignature}`), SECRET, NOW)).toBe(true)
  })

  it('accepts uppercase hex signatures', () => {
    const signature = `v1=${sign(TS, BODY).toUpperCase()}`
    expect(verifyWinnrSignature(BODY, headers(String(TS), signature), SECRET, NOW)).toBe(true)
  })

  it('rejects a wrong secret', () => {
    expect(
      verifyWinnrSignature(BODY, headers(String(TS), `v1=${sign(TS, BODY, 'whsec_other')}`), SECRET, NOW)
    ).toBe(false)
  })

  it('rejects an absent or blank secret', () => {
    const signature = `v1=${sign(TS, BODY)}`
    expect(verifyWinnrSignature(BODY, headers(String(TS), signature), '', NOW)).toBe(false)
    expect(verifyWinnrSignature(BODY, headers(String(TS), signature), '   ', NOW)).toBe(false)
  })

  it('rejects absent timestamp or signature headers', () => {
    const signature = `v1=${sign(TS, BODY)}`
    expect(verifyWinnrSignature(BODY, headers(null, signature), SECRET, NOW)).toBe(false)
    expect(verifyWinnrSignature(BODY, headers(String(TS), null), SECRET, NOW)).toBe(false)
    expect(verifyWinnrSignature(BODY, headers('', ''), SECRET, NOW)).toBe(false)
  })

  it('rejects non-numeric, whitespace-padded or newline timestamps', () => {
    for (const bad of ['not-a-number', '12.5', ' 123456', '123456 ', '123456\n', '+123456', '-123456']) {
      const signature = `v1=${sign(bad, BODY)}`
      expect(verifyWinnrSignature(BODY, headers(bad, signature), SECRET, NOW), bad).toBe(false)
    }
  })

  it('rejects a non-finite clock value', () => {
    const signature = `v1=${sign(TS, BODY)}`
    expect(verifyWinnrSignature(BODY, headers(String(TS), signature), SECRET, Number.NaN)).toBe(false)
    expect(verifyWinnrSignature(BODY, headers(String(TS), signature), SECRET, Number.POSITIVE_INFINITY)).toBe(
      false
    )
  })

  it('enforces the 300-second replay bound in both directions', () => {
    expect(verifyWinnrSignature(BODY, headers(String(TS - 300), `v1=${sign(TS - 300, BODY)}`), SECRET, NOW)).toBe(
      true
    )
    expect(verifyWinnrSignature(BODY, headers(String(TS + 300), `v1=${sign(TS + 300, BODY)}`), SECRET, NOW)).toBe(
      true
    )
    expect(verifyWinnrSignature(BODY, headers(String(TS - 301), `v1=${sign(TS - 301, BODY)}`), SECRET, NOW)).toBe(
      false
    )
    expect(verifyWinnrSignature(BODY, headers(String(TS + 301), `v1=${sign(TS + 301, BODY)}`), SECRET, NOW)).toBe(
      false
    )
  })

  it('accepts any of the comma-separated rotation signatures', () => {
    const good = sign(TS, BODY)
    const other = sign(TS, BODY, 'whsec_previous')

    expect(verifyWinnrSignature(BODY, headers(String(TS), `v1=${other},v1=${good}`), SECRET, NOW)).toBe(true)
    expect(verifyWinnrSignature(BODY, headers(String(TS), `v1=${good},v1=${other}`), SECRET, NOW)).toBe(true)
    expect(verifyWinnrSignature(BODY, headers(String(TS), ` v1=${other} , v1=${good} `), SECRET, NOW)).toBe(true)
  })

  it('rejects malformed signature lists and values', () => {
    const good = sign(TS, BODY)
    for (const bad of ['', 'deadbeef', 'v2=deadbeef', 'v1=', 'v1=zz', 'v1=deadbeef,', ',v1=deadbeef', `v1=${good}extra`, `v1=${good.slice(0, -2)}`]) {
      expect(verifyWinnrSignature(BODY, headers(String(TS), bad), SECRET, NOW), bad).toBe(false)
    }
  })

  it('rejects a signature computed for a different body or timestamp', () => {
    expect(verifyWinnrSignature('{"other":true}', headers(String(TS), `v1=${sign(TS, BODY)}`), SECRET, NOW)).toBe(
      false
    )
    expect(verifyWinnrSignature(BODY, headers(String(TS), `v1=${sign(TS + 10, BODY)}`), SECRET, NOW)).toBe(false)
  })

  it('never throws on hostile input', () => {
    expect(
      verifyWinnrSignature(BODY, headers('123', `v1=${'a'.repeat(10000)}`), SECRET, NOW)
    ).toBe(false)
    expect(verifyWinnrSignature(BODY, headers('123', 'v1=,'), SECRET, NOW)).toBe(false)
  })
})

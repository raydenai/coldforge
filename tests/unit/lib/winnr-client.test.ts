/**
 * Winnr typed adapter contract tests.
 *
 * Wire contracts below are taken from the public Winnr OpenAPI document
 * (`https://app.winnr.app/openapi.yaml`, downloaded 2026-10-05, SHA256
 * 675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994) and the
 * launch plan `docs/superpowers/plans/2026-10-05-winnr-launch.md` Task 2.
 *
 * Every test uses an injected fake fetch — no network, no credentials.
 */
import { describe, it, expect, vi } from 'vitest'
import { WinnrClient, WinnrError } from '@/lib/winnr/client'

const BASE = 'https://api.winnr.app'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function empty(status = 200): Response {
  return new Response('', { status })
}

type FetchMock = ReturnType<typeof vi.fn>

function callAt(fetchMock: FetchMock, i = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[i] as unknown[]
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit }
}

function makeClient(fetchMock: FetchMock, token = 'wnr_test_token') {
  return WinnrClient({ token, fetch: fetchMock as unknown as typeof fetch, timeoutMs: 50 })
}

const accountEnvelope = {
  meta: { request_id: 'req_1', timestamp: '2026-10-05T00:00:00Z' },
  data: {
    id: 'acct_1',
    name: 'Acme Outreach',
    plan: 'Startup',
    domains_limit: 25,
    universal_inbox_enabled: true,
    api_token: { id: 'tok_1', name: 'coldforge', permissions: ['read', 'write'] },
    secret_internal_field: 'must-be-stripped',
  },
}

describe('WinnrClient construction', () => {
  it('rejects an empty token', () => {
    expect(() => WinnrClient({ token: '' })).toThrow(WinnrError)
  })

  it('rejects a token containing whitespace or newlines', () => {
    expect(() => WinnrClient({ token: 'wnr_bad token' })).toThrow(WinnrError)
    expect(() => WinnrClient({ token: 'wnr_bad\ntoken' })).toThrow(WinnrError)
    expect(() => WinnrClient({ token: 'wnr_bad\ttoken' })).toThrow(WinnrError)
  })

  it('never puts the token value in the error message', () => {
    try {
      WinnrClient({ token: 'wnr_top_secret_value with space' })
      expect.unreachable('expected construction to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(WinnrError)
      expect((error as Error).message).not.toContain('top_secret')
      expect((error as Error).message).not.toContain('wnr_top_secret_value')
    }
  })
})

describe('WinnrClient.getAccount', () => {
  it('normalizes the envelope, strips unknown fields and defaults missing permissions to []', async () => {
    const fetchMock = vi.fn(async () => json(accountEnvelope))
    const account = await makeClient(fetchMock).getAccount()

    expect(account).toEqual({
      id: 'acct_1',
      name: 'Acme Outreach',
      plan: 'Startup',
      permissions: ['read', 'write'],
      universalInboxEnabled: true,
    })
    expect(Object.keys(account).sort()).toEqual([
      'id',
      'name',
      'permissions',
      'plan',
      'universalInboxEnabled',
    ])
  })

  it('fails closed with [] permissions when the token scope is absent', async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: { id: 'acct_1', name: 'Acme', plan: 'Startup', universal_inbox_enabled: false } })
    )

    const account = await makeClient(fetchMock).getAccount()
    expect(account.permissions).toEqual([])
  })

  it('throws a typed error for a malformed success response', async () => {
    const fetchMock = vi.fn(async () => json({ unexpected: true }))
    await expect(makeClient(fetchMock).getAccount()).rejects.toBeInstanceOf(WinnrError)
  })

  it('uses the fixed origin, bearer auth and rejects redirects', async () => {
    const fetchMock = vi.fn(async () => json(accountEnvelope))
    await makeClient(fetchMock).getAccount()

    const { url, init } = callAt(fetchMock)
    expect(url).toBe(`${BASE}/v1/account`)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer wnr_test_token')
  })
})

describe('WinnrClient.listMailboxes', () => {
  it('maps email-users to mailboxes without leaking credentials or unknown fields', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            id: 'm1',
            full_address: 'a@example.com',
            name: 'Alice',
            status: 'active',
            daily_send_limit: 50,
            smtp_host: 'smtp.example.com',
            imap_host: 'imap.example.com',
            password: 'super-secret-password',
          },
        ],
        pagination: { has_more: true, cursor: 'cur_2', count: 1 },
        meta: {},
      })
    )

    const page = await makeClient(fetchMock).listMailboxes({ limit: 500 })

    expect(page).toEqual({
      items: [{ id: 'm1', email: 'a@example.com', name: 'Alice', status: 'active', dailyLimit: 50 }],
      nextCursor: 'cur_2',
      hasMore: true,
    })
    expect(JSON.stringify(page)).not.toContain('super-secret-password')
    expect(JSON.stringify(page)).not.toContain('smtp.example.com')

    const { url } = callAt(fetchMock)
    expect(url).toBe(`${BASE}/v1/email-users?limit=100`)
  })

  it('reports an absent cursor as null', async () => {
    const fetchMock = vi.fn(async () => json({ data: [], pagination: { has_more: false } }))
    const page = await makeClient(fetchMock).listMailboxes()
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false })
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/email-users`)
  })
})

describe('WinnrClient.listDomains', () => {
  it('maps domain fields and surfaces dns health', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            id: 'd1',
            name: 'example.com',
            status: 'complete',
            dns_provider: 'cloudflare',
            dns_health: { status: 'healthy', issues: [], checked_at: '2026-10-05T00:00:00Z' },
            payment_amount: 11.5,
          },
        ],
        pagination: { has_more: false, cursor: null },
      })
    )

    const page = await makeClient(fetchMock).listDomains()
    expect(page.items).toEqual([
      {
        id: 'd1',
        name: 'example.com',
        status: 'complete',
        dnsHealth: 'healthy',
        checkedAt: '2026-10-05T00:00:00Z',
      },
    ])
    expect(page.hasMore).toBe(false)
  })

  it('keeps dns health unknown when the check has not run', async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: [{ id: 'd2', name: 'b.example', status: 'pending', dns_health: null }], pagination: { has_more: false } })
    )

    const page = await makeClient(fetchMock).listDomains()
    expect(page.items[0]).toMatchObject({ dnsHealth: null, checkedAt: null })
  })
})

describe('WinnrClient.listWarming', () => {
  it('maps offset pagination to page/perPage/total/hasMore', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            id: 'w1',
            full_address: 'warm@example.com',
            warming_status: 'active',
            warming_health_score: 92,
            warming_total_sent: 120,
            warming_total_replies: 14,
            warming_last_sync: '2026-10-05T01:00:00Z',
            warming_credentials_stale: false,
          },
        ],
        pagination: { page: 2, per_page: 50, total: 120, has_more: true },
      })
    )

    const page = await makeClient(fetchMock).listWarming({ page: 2, perPage: 50 })
    expect(page).toEqual({
      items: [
        {
          id: 'w1',
          email: 'warm@example.com',
          status: 'active',
          healthScore: 92,
          sent: 120,
          replies: 14,
          lastSyncedAt: '2026-10-05T01:00:00Z',
        },
      ],
      page: 2,
      perPage: 50,
      total: 120,
      hasMore: true,
    })
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/warming?page=2&per_page=50`)
  })

  it('keeps missing metrics unknown and total null', async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: [{ id: 'w2', full_address: 'x@example.com', warming_status: 'paused' }] })
    )

    const page = await makeClient(fetchMock).listWarming()
    expect(page.items[0]).toMatchObject({
      status: 'paused',
      healthScore: null,
      sent: null,
      replies: null,
      lastSyncedAt: null,
    })
    expect(page.total).toBeNull()
  })
})

describe('WinnrClient.getWarmingMetrics', () => {
  it('maps daily metrics and keeps absent numbers null', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: {
          metrics: [
            { date: '2026-10-01', sent: 10, inbox: 8, spam: 2, replies: 3, inbox_rate: 0.8 },
            { date: '2026-10-02' },
          ],
        },
      })
    )

    const metrics = await makeClient(fetchMock).getWarmingMetrics('w1')
    expect(metrics).toEqual([
      { date: '2026-10-01', sent: 10, inbox: 8, spam: 2, replies: 3, inboxRate: 0.8 },
      { date: '2026-10-02', sent: null, inbox: null, spam: null, replies: null, inboxRate: null },
    ])
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/warming/w1/metrics`)
  })
})

describe('WinnrClient.listInbox', () => {
  it('sanitizes message fields so no HTML reaches consumers', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          {
            id: 'e1',
            uid: '100',
            message_id: '<m1@example.com>',
            thread_id: 't1',
            from: 'Bob <bob@prospect.com>',
            to: 'me@example.com',
            subject: 'Re: <b>pricing</b> call',
            body_preview: '<p>Hello <img src=x onerror=alert(1)>world</p>',
            received_at: '2026-10-05T00:00:00Z',
            mailbox: 'me@example.com',
          },
        ],
        pagination: { has_more: false, cursor: null },
      })
    )

    const page = await makeClient(fetchMock).listInbox({ mailboxId: 'm1', limit: 100 })
    expect(page.items[0]).toEqual({
      id: 'e1',
      uid: '100',
      messageId: '<m1@example.com>',
      threadId: 't1',
      from: 'Bob',
      to: 'me@example.com',
      subject: 'Re: pricing call',
      preview: 'Hello world',
      receivedAt: '2026-10-05T00:00:00Z',
      mailbox: 'me@example.com',
    })
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/email-users/m1/inbox?limit=100`)

    // Human-readable fields are HTML-free; identifiers keep their exact value.
    const message = page.items[0]
    for (const value of [message.from, message.to, message.subject, message.preview, message.mailbox]) {
      expect(value).not.toMatch(/[<>]/)
    }
    expect(message.messageId).toBe('<m1@example.com>')
  })

  it('lists account-wide inbox when no mailbox id is given', async () => {
    const fetchMock = vi.fn(async () => json({ data: [], pagination: { has_more: false } }))
    await makeClient(fetchMock).listInbox()
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/inbox`)
  })
})

describe('WinnrClient.sendMessage', () => {
  it('maps camelCase input to the wire send schema and returns the provider message id', async () => {
    const fetchMock = vi.fn(async () =>
      json({ data: { success: true, message_id: '<sent@example.com>' } })
    )

    const result = await makeClient(fetchMock).sendMessage({
      mailboxId: 'm1',
      to: 'lead@prospect.com',
      subject: 'Quick question',
      body: '<p>Hi</p>',
      html: true,
      inReplyTo: '<prior@example.com>',
      references: '<prior@example.com>',
    })

    expect(result).toEqual({ messageId: '<sent@example.com>' })

    const { url, init } = callAt(fetchMock)
    expect(url).toBe(`${BASE}/v1/email-users/m1/inbox/send`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      to: 'lead@prospect.com',
      subject: 'Quick question',
      body: '<p>Hi</p>',
      html: true,
      in_reply_to: '<prior@example.com>',
      references: '<prior@example.com>',
    })
  })

  it('rejects a provider-declared failure without marking the outcome unknown', async () => {
    const fetchMock = vi.fn(async () => json({ data: { success: false, message_id: null } }))

    try {
      await makeClient(fetchMock).sendMessage({
        mailboxId: 'm1',
        to: 'lead@prospect.com',
        subject: 'Hi',
        body: 'Hi',
      })
      expect.unreachable('expected send to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(WinnrError)
      expect(error).toMatchObject({ outcomeUnknown: false, status: 200 })
    }
  })

  it('marks a success without a message id as outcome unknown', async () => {
    const fetchMock = vi.fn(async () => json({ data: { success: true, message_id: '' } }))

    await expect(
      makeClient(fetchMock).sendMessage({
        mailboxId: 'm1',
        to: 'lead@prospect.com',
        subject: 'Hi',
        body: 'Hi',
      })
    ).rejects.toMatchObject({ outcomeUnknown: true })
  })

  it('does not retry and marks a transport failure as outcome unknown', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    await expect(
      makeClient(fetchMock).sendMessage({
        mailboxId: 'm1',
        to: 'lead@prospect.com',
        subject: 'Hi',
        body: 'Hi',
      })
    ).rejects.toMatchObject({ outcomeUnknown: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry and marks a 5xx as outcome unknown', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'server_error' } }, 503))

    await expect(
      makeClient(fetchMock).sendMessage({
        mailboxId: 'm1',
        to: 'lead@prospect.com',
        subject: 'Hi',
        body: 'Hi',
      })
    ).rejects.toMatchObject({ outcomeUnknown: true, status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a 4xx as a definite rejection', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'validation_error' } }, 422))

    await expect(
      makeClient(fetchMock).sendMessage({
        mailboxId: 'm1',
        to: 'lead@prospect.com',
        subject: 'Hi',
        body: 'Hi',
      })
    ).rejects.toMatchObject({ outcomeUnknown: false, status: 422 })
  })
})

describe('WinnrClient read retry behavior', () => {
  it('retries a GET once on a 5xx and then succeeds', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      return calls === 1 ? json({ error: { code: 'server_error' } }, 500) : json(accountEnvelope)
    })

    const account = await makeClient(fetchMock).getAccount()
    expect(account.id).toBe('acct_1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx GET', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'not_found' } }, 404))
    await expect(makeClient(fetchMock).getAccount()).rejects.toMatchObject({ status: 404 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('WinnrClient sanitized HTTP errors', () => {
  it('never echoes the raw provider body, secret or URL in the error message', async () => {
    const fetchMock = vi.fn(async () =>
      json(
        {
          error: {
            code: 'validation_error',
            message: 'raw upstream detail wnr_leaked_token https://api.winnr.app/v1/account',
          },
        },
        422
      )
    )

    try {
      await makeClient(fetchMock).getAccount()
      expect.unreachable('expected error')
    } catch (error) {
      const typed = error as WinnrError
      expect(typed).toBeInstanceOf(WinnrError)
      expect(typed.code).toBe('winnr_http_422')
      expect(typed.message).not.toContain('raw upstream detail')
      expect(typed.message).not.toContain('wnr_leaked_token')
      expect(typed.message).not.toContain('api.winnr.app')
    }
  })

  it('parses Retry-After seconds from a 429', async () => {
    const fetchMock = vi.fn(async () =>
      json({ error: { code: 'rate_limited' } }, 429, { 'retry-after': '30' })
    )

    await expect(makeClient(fetchMock).getAccount()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
      outcomeUnknown: false,
    })
  })
})

describe('WinnrClient id encoding safety', () => {
  it('rejects slash, dotpath and whitespace ids before any request', async () => {
    const fetchMock = vi.fn(async () => json({ data: {} }))
    const client = makeClient(fetchMock)

    for (const bad of ['a/b', '..', '../account', '.', 'a b', 'a\\b', '']) {
      await expect(client.getWarmingMetrics(bad)).rejects.toBeInstanceOf(WinnrError)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('component-encodes safe special characters instead of allowing path traversal', async () => {
    const fetchMock = vi.fn(async () => json({ data: { metrics: [] } }))
    await makeClient(fetchMock).getWarmingMetrics('user+tag:1')
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/warming/user%2Btag%3A1/metrics`)
  })
})

describe('WinnrClient warming mutations', () => {
  it.each([{ success: false }, { data: { success: false } }, { error: { code: 'failed' } }, 42])(
    'holds an ambiguous 200 response instead of recording success: %j', async (body) => {
      const fetchMock = vi.fn(async () => json(body))
      await expect(makeClient(fetchMock).pauseWarming('w1')).rejects.toMatchObject({ outcomeUnknown: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([[], ['w1'], ['w1', 'other'], ['w1', 'w1', 'w2']])(
    'holds incomplete or mismatched enable receipts: %j', async (...enabledIds) => {
      const fetchMock = vi.fn(async () => json({ data: { enabled: enabledIds.map(id => ({
        id, full_address: `${id}@example.com`, warming_status: 'active',
      })) } }))
      await expect(makeClient(fetchMock).enableWarming(['w1', 'w2'], {
        emailsPerDay: 10, responseRate: 30, rampupEnabled: true, rampupSpeed: 'slow',
      })).rejects.toMatchObject({ outcomeUnknown: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )
  it('pause/resume/disable resolve on an empty 200 and use the documented paths', async () => {
    const fetchMock = vi.fn(async () => empty(200))
    const client = makeClient(fetchMock)

    await expect(client.pauseWarming('w1')).resolves.toBeUndefined()
    await expect(client.resumeWarming('w1')).resolves.toBeUndefined()
    await expect(client.disableWarming(['w1', 'w2'])).resolves.toBeUndefined()

    expect(callAt(fetchMock, 0).url).toBe(`${BASE}/v1/warming/w1/pause`)
    expect(callAt(fetchMock, 1).url).toBe(`${BASE}/v1/warming/w1/resume`)
    expect(callAt(fetchMock, 2).url).toBe(`${BASE}/v1/warming/disable`)
    expect(JSON.parse(String(callAt(fetchMock, 2).init.body))).toEqual({ user_ids: ['w1', 'w2'] })
  })

  it('treats a nonempty non-JSON 200 on a void mutation as outcome unknown', async () => {
    const fetchMock = vi.fn(async () => new Response('accepted', { status: 200 }))
    await expect(makeClient(fetchMock).pauseWarming('w1')).rejects.toMatchObject({
      outcomeUnknown: true,
    })
  })

  it('accepts a nonempty JSON 200 on a void mutation', async () => {
    const fetchMock = vi.fn(async () => json({ data: { status: 'paused' } }))
    await expect(makeClient(fetchMock).pauseWarming('w1')).resolves.toBeUndefined()
  })

  it('enableWarming maps settings to snake_case and returns normalized mailboxes', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: {
          enabled: [{ id: 'w1', full_address: 'a@example.com', warming_status: 'active' }],
        },
      })
    )

    const enabled = await makeClient(fetchMock).enableWarming(['w1'], {
      emailsPerDay: 20,
      responseRate: 30,
      rampupEnabled: true,
      rampupSpeed: 'normal',
    })

    expect(enabled).toEqual([
      {
        id: 'w1',
        email: 'a@example.com',
        status: 'active',
        healthScore: null,
        sent: null,
        replies: null,
        lastSyncedAt: null,
      },
    ])
    expect(callAt(fetchMock).url).toBe(`${BASE}/v1/warming/enable`)
    expect(JSON.parse(String(callAt(fetchMock).init.body))).toEqual({
      user_ids: ['w1'],
      settings: {
        emails_per_day: 20,
        response_rate: 30,
        rampup_enabled: true,
        rampup_speed: 'normal',
      },
    })
  })

  it('enableWarming rejects ids needing unsafe encoding', async () => {
    const fetchMock = vi.fn(async () => json({ data: { enabled: [] } }))
    await expect(
      makeClient(fetchMock).enableWarming(['../evil'], {
        emailsPerDay: 20,
        responseRate: 30,
        rampupEnabled: true,
        rampupSpeed: 'normal',
      })
    ).rejects.toBeInstanceOf(WinnrError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Winnr reviewed boundary regressions', () => {
  it('does not claim the cursor list is complete when pagination is absent', async () => {
    const fetchMock = vi.fn(async () => json({ data: [] }))
    await expect(makeClient(fetchMock).listMailboxes()).rejects.toMatchObject({ code: 'malformed_response' })
  })

  it('rejects a next page flag without its cursor', async () => {
    const fetchMock = vi.fn(async () => json({ data: [], pagination: { has_more: true } }))
    await expect(makeClient(fetchMock).listMailboxes()).rejects.toMatchObject({ code: 'malformed_response' })
  })
  it('never propagates a provider code that contains a credential', async () => {
    const token = 'wnr_secret_fixture'
    const fetchMock = vi.fn(async () => json({ error: { code: token } }, 401))
    try {
      await makeClient(fetchMock, token).getAccount()
      expect.unreachable('expected rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'winnr_http_401' })
      expect(JSON.stringify(error)).not.toContain(token)
    }
  })

  it('uses the documented warm-up page size when the last response omits it', async () => {
    const fetchMock = vi.fn(async () => json({
      data: Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, full_address: 'a@example.com', warming_status: 'active' })),
      pagination: { page: 2, total: 120 },
    }))
    await expect(makeClient(fetchMock).listWarming({ page: 2 })).resolves.toMatchObject({
      page: 2, perPage: 100, total: 120, hasMore: false,
    })
  })
})

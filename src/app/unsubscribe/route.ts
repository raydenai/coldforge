/**
 * Unsubscribe endpoint (SEC-004).
 *
 * This route did not exist. `src/lib/sending/sender.ts` emitted
 * `List-Unsubscribe-Post` and `src/app/api/sending/process/route.ts` built a
 * `/unsubscribe?lead=..&campaign=..` link, so every commercial email advertised
 * a one-click opt-out that resolved to a 404.
 *
 * POST is the RFC 8058 one-click target. Mailbox providers (Gmail, Yahoo) POST
 * `List-Unsubscribe=One-Click` here with no user interaction and no cookies, so
 * it must not require auth, must not be CSRF-protected in the usual sense, and
 * must be idempotent. Authorisation comes from the signed token instead.
 *
 * GET is the human-facing path from clicking the link in the message body.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  verifyUnsubscribeToken,
  UnsubscribeTokenError,
} from '@/lib/compliance/unsubscribe-token'
import { recordSuppression } from '@/lib/compliance/suppression'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/** Resolve the lead's address from the token's lead id. */
async function resolveLeadEmail(leadId: string, organizationId: string): Promise<string | null> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('leads')
    .select('email')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .limit(1)
    .single()

  if (error || !data?.email) return null
  return data.email
}

/**
 * Apply the opt-out.
 *
 * Idempotent: repeating it is a no-op, which matters because providers may
 * retry the one-click POST.
 */
async function applyUnsubscribe(token: string): Promise<
  { ok: true } | { ok: false; status: number; message: string }
> {
  let payload
  try {
    payload = verifyUnsubscribeToken(token)
  } catch (error) {
    if (error instanceof UnsubscribeTokenError) {
      // Do not distinguish "bad signature" from "unknown lead" to the caller;
      // that difference is an enumeration oracle.
      return { ok: false, status: 400, message: 'This unsubscribe link is not valid.' }
    }
    throw error
  }

  const email = await resolveLeadEmail(payload.leadId, payload.workspaceId)
  if (!email) {
    return { ok: false, status: 400, message: 'This unsubscribe link is not valid.' }
  }

  const result = await recordSuppression({
    email,
    leadId: payload.leadId,
    workspaceId: payload.workspaceId,
    reason: 'unsubscribe',
    source: 'one-click',
    notes: `campaign:${payload.campaignId}`,
  })

  if (!result.success) {
    // Fail loudly. A silent failure here means we keep mailing someone who
    // asked us to stop.
    return {
      ok: false,
      status: 500,
      message: 'We could not record your request. Please contact support.',
    }
  }

  return { ok: true }
}

/**
 * RFC 8058 one-click. Called by the mailbox provider, not the human.
 * Always returns 200 on success with no body requirements.
 */
export async function POST(request: NextRequest) {
  const url = new URL(request.url)
  let token = url.searchParams.get('token')

  // Providers post `List-Unsubscribe=One-Click` as form data; the token stays in
  // the URL. Accept a form-encoded token too, for senders that put it there.
  if (!token) {
    try {
      const form = await request.formData()
      const candidate = form.get('token')
      if (typeof candidate === 'string') token = candidate
    } catch {
      // No form body. Fall through to the missing-token response.
    }
  }

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const result = await applyUnsubscribe(token)

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status })
  }

  return NextResponse.json({ unsubscribed: true })
}

/** Human-facing confirmation. */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token')

  if (!token) {
    return htmlResponse(400, 'Invalid link', 'This unsubscribe link is missing its token.')
  }

  const result = await applyUnsubscribe(token)

  if (!result.ok) {
    return htmlResponse(result.status, 'Unsubscribe failed', result.message)
  }

  return htmlResponse(
    200,
    'You have been unsubscribed',
    'You will not receive further emails from this sender. No further action is needed.'
  )
}

function htmlResponse(status: number, heading: string, body: string) {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(heading)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem;
         color: #18181b; line-height: 1.6; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 .5rem; }
  p { color: #52525b; margin: 0; }
</style>
</head>
<body>
  <h1>${esc(heading)}</h1>
  <p>${esc(body)}</p>
</body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    }
  )
}

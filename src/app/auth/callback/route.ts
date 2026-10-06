import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { DEFAULT_POST_CONFIRMATION, sanitizeInternalPath } from '@/lib/auth/redirect'

// Auth callbacks read and write session cookies per request; never cache.
export const dynamic = 'force-dynamic'

/**
 * Email-confirmation / PKCE callback. Supabase redirects here with a `code`
 * after the user clicks the confirmation link; exchanging it stores the
 * session cookies that the rest of the app (and middleware) relies on.
 *
 * Failures (missing code, expired/reused code, or a confirmation link opened
 * in a browser that lacks the PKCE code-verifier cookie) are routed through
 * the login page with a stable, non-sensitive marker. The raw Supabase error
 * and the token/code are never placed in the URL or rendered.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = sanitizeInternalPath(
    searchParams.get('next'),
    DEFAULT_POST_CONFIRMATION
  )

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      return NextResponse.redirect(new URL(next, origin))
    }
  }

  const loginUrl = new URL('/login', origin)
  loginUrl.searchParams.set('error', 'confirm')
  loginUrl.searchParams.set('redirect', next)
  return NextResponse.redirect(loginUrl)
}

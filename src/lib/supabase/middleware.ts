import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Retained authenticated application areas.
const PROTECTED_PATHS = [
  '/dashboard',
  '/campaigns',
  '/leads',
  '/accounts',
  '/domains',
  '/warmup',
  '/inbox',
  '/winnr',
  '/settings',
  '/operations',
  '/agents',
  '/pipeline',
  '/analytics',
]

// Auth surfaces that authenticated users should be moved away from.
const AUTH_PATHS = ['/login', '/register', '/forgot-password']

/**
 * Build a redirect that keeps any session cookies refreshed while resolving
 * the current user. Without copying them, a middleware redirect drops the
 * refreshed token and the browser keeps replaying a stale session.
 */
function redirectWithRefreshedCookies(
  sessionResponse: NextResponse,
  redirect: NextResponse
): NextResponse {
  sessionResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
  return redirect
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh session if expired
  const { data: { user } } = await supabase.auth.getUser()

  const isProtectedPath = PROTECTED_PATHS.some(path => request.nextUrl.pathname.startsWith(path))
  const isAuthPath = AUTH_PATHS.some(path => request.nextUrl.pathname.startsWith(path))

  // Redirect unauthenticated users from protected routes
  if (isProtectedPath && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirect', request.nextUrl.pathname)
    return redirectWithRefreshedCookies(supabaseResponse, NextResponse.redirect(url))
  }

  // Redirect authenticated users from auth routes to the current app entry
  if (isAuthPath && user) {
    const url = request.nextUrl.clone()
    url.pathname = '/operations'
    url.searchParams.delete('redirect')
    return redirectWithRefreshedCookies(supabaseResponse, NextResponse.redirect(url))
  }

  return supabaseResponse
}

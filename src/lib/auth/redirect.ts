/**
 * Safe post-auth navigation helper.
 *
 * Auth flows accept a caller-supplied destination (`next` on the callback,
 * `redirect` on the login form). That value is untrusted input and must never
 * be used verbatim: it could point off-origin (open redirect) or back into an
 * auth route, producing a redirect loop. This module is the single place that
 * decides whether a destination is a safe, app-internal path.
 */

/** Current authenticated app entry. */
export const DEFAULT_APP_ENTRY = '/operations'

/** Post-confirmation entry point (membership/bootstrap lives behind this). */
export const DEFAULT_POST_CONFIRMATION = '/onboarding'

/**
 * Route prefixes that must never be a post-auth destination: navigating back
 * into the auth surface would remove the freshly established session or loop.
 */
const BLOCKED_PREFIXES = ['/login', '/register', '/forgot-password', '/auth', '/api']

function isBlockedPath(pathname: string): boolean {
  return BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Return a safe same-origin path or the supplied fallback.
 *
 * Rejected inputs: missing/empty values, absolute URLs (`https://evil`),
 * protocol-relative URLs (`//evil`), backslash tricks (`/\evil`, `%5C`),
 * control characters, and auth-loop paths. Query strings and fragments are
 * preserved for accepted paths.
 */
export function sanitizeInternalPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_APP_ENTRY
): string {
  const candidate = value?.trim()
  if (!candidate || !candidate.startsWith('/')) {
    return fallback
  }

  // A protocol-relative or backslash-prefixed value is treated as external by
  // browsers even though it starts with "/".
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return fallback
  }

  // Reject raw control characters and backslashes anywhere in the value.
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) {
    return fallback
  }

  // Reject values that only become external after percent-decoding
  // (e.g. "/%2F%2Fevil.example" or "/%5Cevil.example").
  const decoded = decodeOnce(candidate)
  if (
    decoded !== null &&
    (decoded.startsWith('//') ||
      decoded.startsWith('/\\') ||
      /[\u0000-\u001f\u007f\\]/.test(decoded))
  ) {
    return fallback
  }

  const [pathname = ''] = candidate.split(/[?#]/, 1)
  if (isBlockedPath(pathname)) {
    return fallback
  }

  return candidate
}

# Auth startup: email confirmation and safe sign-in navigation

Scope: the retained email/password signup and sign-in path. No OAuth, no
password reset, no auth-security setting changes. Hosted Supabase configuration
(site URL, redirect allow-list) is owned by the parent and is **not** changed by
this work.

## Flow

1. `/register` calls `supabase.auth.signUp` with the user metadata
   (`full_name`, `organization_name`) **and** an explicit same-origin
   `emailRedirectTo` of `<origin>/auth/callback`. `@supabase/ssr`'s browser
   client uses the PKCE flow, so the code verifier is stored in a browser
   cookie.
2. Supabase emails a confirmation link. When the user clicks it, Supabase
   verifies the email and redirects to `/auth/callback?code=...`.
3. `src/app/auth/callback/route.ts` (server) exchanges the code with the
   existing cookie-backed server client
   (`src/lib/supabase/server.ts` → `exchangeCodeForSession`). The session
   cookies are written by that client's `setAll` adapter.
4. On success the user is sent to the sanitized `next` path, defaulting to
   `/onboarding` (existing membership/bootstrap behavior lives behind the
   dashboard/onboarding layout).
5. On a missing, expired, or cross-browser code the user is sent to
   `/login?error=confirm&redirect=<safe next>`, which renders clear sign-in
   guidance. The raw Supabase error and the auth code are never placed in the
   URL or rendered.

If email confirmation is disabled (immediate session returned by `signUp`),
`/register` sends the user straight to `/onboarding`. If confirmation is
required, it sends them to `/login?verify=email`; the login form now renders
the matching confirmation notice.

## Redirect safety

`src/lib/auth/redirect.ts#sanitizeInternalPath` is the single gate for both the
callback `next` and the login `redirect` query values. It accepts only
same-origin, app-internal paths (query/fragment preserved) and falls back
otherwise. Rejected:

- absolute URLs (`https://evil.example`) and protocol-relative URLs (`//evil`);
- backslash and percent-encoded bypasses (`/\evil`, `/%5Cevil`, `/%2F%2Fevil`);
- control characters;
- auth-loop destinations (`/login`, `/register`, `/forgot-password`, `/auth`,
  `/api`).

The login form defaults to `/operations` (current authenticated entry); the
callback defaults to `/onboarding`.

## Middleware

`src/lib/supabase/middleware.ts` now guards the retained app areas
`/operations`, `/agents`, `/pipeline`, and `/analytics` in addition to the
existing list, and still redirects authenticated users away from auth routes.
Any redirect it issues copies the cookies produced while refreshing the
session, so a refreshed token is not dropped by the redirect (previously the
redirect response discarded the refreshed cookie and could loop on a stale
session).

## Hosted configuration required (parent-owned)

For the hosted project with confirmation required:

- **Site URL** must be the deployed origin, not `localhost`.
- **Redirect URLs** allow-list must include `<deployed-origin>/auth/callback`
  (and the local dev equivalent) so `emailRedirectTo` is accepted.

Until the Site URL/redirect allow-list are updated, Supabase will reject or
rewrite the callback destination; that is a hosted-setting gate, not an
application defect.

## Cross-browser confirmation (PKCE)

Because the browser client uses PKCE, the confirmation link only yields a
session in the browser that started the signup (where the code-verifier cookie
lives). If the link is opened elsewhere, `exchangeCodeForSession` fails; the
callback routes to login with sign-in guidance instead of reporting a false
success. The email itself is typically already confirmed by Supabase at that
point, so signing in with the email and password is the correct next step.

## Tests

Focused fake-client tests (no live Supabase, no user/email creation):

- `tests/unit/lib/auth-redirect.test.ts` — accepted/rejected redirect cases.
- `tests/unit/lib/auth-callback-route.test.ts` — success, default/blocked
  `next`, invalid/expired code, and missing-code (cross-browser) behavior,
  asserting no token/raw-error leakage.
- `tests/unit/lib/supabase-middleware.test.ts` — retained-path protection and
  refreshed-cookie preservation across redirects.
- `tests/unit/components/register-page.test.tsx` — metadata + `emailRedirectTo`
  payload and session/no-session navigation.
- `tests/unit/components/login-form.test.tsx` — `verify=email` / `error=confirm`
  notices and safe redirect/default/rejection cases.

Cookie persistence for the exchange itself is delegated to the unchanged
read-only `src/lib/supabase/server.ts` adapter; the middleware tests cover the
cookie-preservation contract on the redirect side.

## Provenance

- Supabase SSR: creating a client —
  https://supabase.com/docs/guides/auth/server-side/creating-a-client
- Supabase SSR: advanced guide (PKCE, `exchangeCodeForSession`) —
  https://supabase.com/docs/guides/auth/server-side/advanced-guide
- Supabase password-based auth (`signUp` + `emailRedirectTo`) —
  https://supabase.com/docs/guides/auth/passwords
- Supabase redirect URLs —
  https://supabase.com/docs/guides/auth/redirect-urls
- Installed contracts: `@supabase/ssr@0.8.0`
  (`createBrowserClient` defaults `flowType: 'pkce'`),
  `@supabase/auth-js@2.90.1` (`signUp(credentials)`,
  `exchangeCodeForSession(authCode: string)`).

## Hosted configuration checkpoint

The parent configured `https://coldforge-wheat.vercel.app` as Site URL and
allow-listed `https://coldforge-wheat.vercel.app/auth/callback`, then verified
both through a readback. Email confirmation remains required; signup and email
provider settings were preserved. No auth email or test user was created.
Deployment and real user confirmation still require live verification.

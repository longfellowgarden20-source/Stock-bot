---
name: feedback-mistakes
description: Mistakes Claude has made in this project — never repeat these
metadata:
  type: feedback
---

# Mistakes to Never Repeat

## 1. `export const revalidate` fails without env vars at build time
Using `export const revalidate = N` on pages that call Supabase causes prerender errors because env vars aren't available at Next.js build time. Always use `export const dynamic = 'force-dynamic'` for pages that hit a database.

**Why:** Vercel tries to prerender revalidated pages at build time, but SUPABASE_SERVICE_ROLE_KEY isn't injected until runtime.
**How to apply:** Any Next.js page that reads from Supabase must use `force-dynamic`, not `revalidate`.

---

## 2. middleware.ts is deprecated in Next.js 16 — use proxy.ts
Next.js 16 renamed `middleware.ts` to `proxy.ts` and `export function middleware` to `export function proxy`. Using the old name causes `MIDDLEWARE_INVOCATION_FAILED` 500 errors in production.

**Why:** Next.js 16 breaking change.
**How to apply:** Always use `proxy.ts` with `export async function proxy(req)` in this project.

---

## 3. Don't have both middleware.ts and proxy.ts at the same time
Having both files causes a build error: "Both middleware file and proxy file are detected."

**Why:** Next.js only allows one.
**How to apply:** Delete middleware.ts before adding proxy.ts.

---

## 4. web-push package must be explicitly installed
`lib/web-push.ts` imports from `web-push` but it wasn't in package.json. Always run `npm install web-push @types/web-push` when adding push notification code.

**Why:** It's not a Next.js built-in.
**How to apply:** Check package.json before assuming a package is available.

---

## 5. PushToggle.tsx Uint8Array type mismatch
`urlBase64ToUint8Array()` returns `Uint8Array<ArrayBufferLike>` which isn't directly assignable to `applicationServerKey`. Must use `.buffer as ArrayBuffer`.

**Why:** TypeScript strict mode + browser API type mismatch.
**How to apply:** Always cast: `urlBase64ToUint8Array(vapid).buffer as ArrayBuffer`

---

## 6. git push fails if no remote is configured
After committing, if there's no `origin` remote set, push silently fails with exit 128. Always check `git remote -v` first or set remote before pushing.

**Why:** Repo was local-only initially.
**How to apply:** Run `git remote add origin <url>` before first push.

---

## 7. Supabase `auth.create_user(jsonb)` function doesn't exist
This SQL function doesn't exist in Supabase. Use the Supabase dashboard UI (Authentication → Users → Add user) or the admin API instead.

**Why:** Supabase doesn't expose this as a raw SQL function.
**How to apply:** Never suggest `auth.create_user()` SQL. Use dashboard UI or service role API.

---

## 8. Proxy redirect loop if sign-in page isn't excluded
If the proxy checks for the auth cookie on ALL routes including `/sign-in`, it causes infinite redirects. Always explicitly exclude `/sign-in`, `/_next`, `/api`, and `/favicon` from the auth check.

**Why:** Unauthenticated user hits `/sign-in` → proxy redirects to `/sign-in` → infinite loop.
**How to apply:** Always check `if (pathname === '/sign-in') return NextResponse.next()` before the cookie check.

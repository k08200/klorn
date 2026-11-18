# Account enumeration: accepted residual

Status as of 2026-11-18. Whether an email address has a Klorn password account
can be learned from `POST /api/auth/register`. This note records why that stays,
what bounds it, and what would have to change to close it.

## What answers

| Route | Unknown address | Known address | Oracle? |
|---|---|---|---|
| `POST /api/auth/register` | 201 + session token | 409 `Email already registered` | **Yes — accepted** |
| `POST /api/auth/login` | 401 `Invalid email or password` | 401, same body (wrong password) | Body: no. Timing: yes (see below) |
| `POST /api/auth/forgot-password` | 200 `{ success: true }` | 200, same body | Body: no. Timing: yes (see below) |
| Per-account / per-address 429 | same body as the per-IP limiter | same | No |

## Why register stays an oracle

Register hands back a session for a brand-new account at once
(`packages/api/src/routes/auth.ts`, `signToken` + `registerDevice` before the
201): the account is usable before its address is verified. Answering an
existing address the same way as a new one would mean either returning a
session for someone else's account (impossible) or returning no session for a
new one — that is, a verification step before first use. That is a material
change to sign-up, so it was not made. The web login page
(`packages/web/src/app/login/page.tsx`) and the mobile welcome screen
(`apps/mobile/src/screens/login/WelcomeScreen.tsx`) rely on the 409 to say
"already registered".

Closing it later takes, together: register returns no session (202 "check your
email") for every address; the verification link signs the new account in; an
existing address gets a "someone tried to create an account with your email —
sign in or reset your password" mail instead of the 409 (rate-limited per
address); and the clients drop their 409 branch.

## What bounds it

- **Per IP:** register 5 per 15 minutes, login 10 per 15 minutes (route
  limits in `routes/auth.ts`), global 100 per minute
  (`packages/api/src/security/rate-limit-identity.ts`), all keyed on the
  derived client address.
- **Per address:** register 10 attempts per 15 minutes
  (`packages/api/src/security/register-throttle.ts`), login 30 per 15 minutes
  (`packages/api/src/security/login-throttle.ts`). Both count before any
  lookup and answer the per-IP limiter's 429 body, so the lock is no oracle of
  its own.
- Probing at the per-IP rate costs one source address per 5 addresses per
  15 minutes.

## Timing residuals, not addressed

Moot while register answers outright, recorded so they are not mistaken for
closed:

- Login skips the bcrypt compare for an unknown address, so a known one
  answers measurably slower.
- Forgot-password returns at once for an unknown address and awaits a token
  write and the reset mail for a known one.

Equalizing these (a dummy compare; a fire-and-forget mail) only pays off once
register stops answering.

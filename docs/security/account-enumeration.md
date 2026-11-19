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
| Per-account / per-address 429 | per-IP limiter's `{ error }` shape | same | No |

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

- **Per IP (the only bound on a sweep):** register 5 per 15 minutes, login 10
  per 15 minutes (route limits in `packages/api/src/routes/auth.ts`), global
  100 per minute (`packages/api/src/security/rate-limit-identity.ts`), all
  keyed on the derived client address. One request per address answers the
  question, so a sweep costs one source address per 5 addresses per 15
  minutes.
- **Side effect of a probe:** a probe of an address with no account creates
  that account (unverified) and sends a verification mail to it. The owner
  takes such an account back by password reset (which revokes every session)
  or by Google sign-in (which wipes an unverified password account's
  sessions).

## Per-address windows

Not a bound on enumeration — they count attempts on one address, whoever
sends them. Register: 10 per 15 minutes
(`packages/api/src/security/register-throttle.ts`), counted after the beta
gate and before the account lookup. Login: 30 per 15 minutes
(`packages/api/src/security/login-throttle.ts`). Both count for every address
alike and answer a 429 in the per-IP limiter's `{ error }` shape, so the lock
says nothing about whether the address has an account. Residual: two or more
coordinated source addresses can lock sign-up (or sign-in) for one address for
the rest of a 15-minute window.

Forgot-password: 5 requests per address per hour
(`packages/api/src/security/password-reset-throttle.ts`), counted for every
address before the account lookup. A locked address answers the same 200
`{ success: true }` as any other request and sends no mail, so there is no
per-address 429 to tell addresses apart; the per-IP 429 is unchanged. A
request within 5 minutes of the last mailed link keeps that link and sends
nothing (it still counts toward the hour). Residual: anyone can spend an
address's hour, and the owner gets no new mail until it ends; a link mailed
during that hour stays valid until it ends, since the hour is no longer than a
link lives.

## Timing residuals, not addressed

Moot while register answers outright, recorded so they are not mistaken for
closed:

- Login skips the bcrypt compare for an unknown address, so a known one
  answers measurably slower.
- Forgot-password returns at once for an unknown address and awaits a token
  write and the reset mail for a known one — except when the address's
  window is spent or a link went out in the last 5 minutes, when a known
  address answers as fast as an unknown one.

Equalizing these (a dummy compare; a fire-and-forget mail) only pays off once
register stops answering.

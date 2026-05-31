# OAuth Consent Screen — exact field values

Copy into Google Cloud Console → APIs & Services → OAuth consent screen /
Branding. Values derived from the codebase (2026-05-31). The Cloud project and
the Search Console domain verification must be on the **same Google account**
(`k0820086@gmail.com`).

| Field | Value |
|---|---|
| User type | External |
| App name | `Klorn` |
| App logo | 120×120 px PNG, ≤1 MB, identical to homepage mark (`/brand/mark.svg` rasterized) |
| User support email | `hello@klorn.ai` *(must be monitored)* |
| App homepage | `https://app.klorn.ai` |
| Privacy policy URL | `https://app.klorn.ai/privacy` *(must exactly match homepage footer link)* |
| Terms of service URL | `https://app.klorn.ai/terms` |
| Developer contact email | `k0820086@gmail.com` *(monitor during review)* |
| Authorized domain | `klorn.ai` |

## Authorized redirect URIs (OAuth client → Credentials)
- `https://app.klorn.ai/api/auth/google/callback`  (prod)
- `http://localhost:3001/api/auth/google/callback`  (dev — keep out of the
  verified production client if possible; use a separate dev client)

> Source: `GOOGLE_REDIRECT_URI` in `packages/api/src/gmail.ts:8-9`; prod
> derived from `WEB_URL` in `packages/api/src/routes/auth.ts`.

## Scopes to register (after Issue A fix)
```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.readonly      (RESTRICTED)
https://www.googleapis.com/auth/gmail.send          (SENSITIVE)
https://www.googleapis.com/auth/gmail.modify        (RESTRICTED)
https://www.googleapis.com/auth/calendar.events     (SENSITIVE) ← change from /calendar
```

## Pre-submit verification
- [ ] Every domain above is verified in Google Search Console.
- [ ] Consent-screen privacy link === homepage footer privacy link (byte-equal).
- [ ] App name/logo === demo video === homepage.
- [ ] No scope registered that isn't demonstrated in the video.
- [ ] Reviewer test account + step-by-step access notes attached (beta gate).

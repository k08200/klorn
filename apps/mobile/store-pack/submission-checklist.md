# iOS submission checklist — founder run-book

Ordered, follow-along sequence from a clean repo to "Waiting for Review".
Assumes the founder-ops prerequisites in `apps/mobile/STORE_SUBMISSION.md`
(Apple Developer membership, APNs key on Render, CASA started) — this file is
the **execution order**, that file is the **why**. Times are realistic for a
first-ever submission; repeat submissions are ~10× faster.

Total first-run estimate: **~1 working day** of hands-on time, spread over
2–4 calendar days (TestFlight processing + review wait).

---

## Phase 0 — Preflight (~30 min)

- [ ] Apple Developer Program active ($99/yr) and you can log into App Store Connect.
- [ ] Web prod is current: `app.klorn.ai` serves the build with native login/push code (`STORE_SUBMISSION.md` §E) — the shell shows whatever is deployed, so the store binary is only as good as prod.
- [ ] Demo account prepared (see `store-pack/review-notes.md` §1 prep checklist — demo Gmail seeded + linked). **~1 h, can run in parallel.**
- [ ] Decide the two conditional privacy answers (Purchases, Crash Data) per `store-pack/privacy-labels.md` — check whether `NEXT_PUBLIC_REVENUECAT_IOS_KEY` and `NEXT_PUBLIC_SENTRY_DSN` are set on the prod web deploy.
- [ ] Fix the privacy-manifest Name gap (`privacy-labels.md` action item 1).

## Phase 1 — Xcode: signing + capabilities (~45 min)

```bash
cd apps/mobile
npm install
npm run sync          # SHELL build — never set KLORN_PROBE for the store
npm run open:ios      # opens ios/App/App.xcworkspace? → use the workspace Xcode opens
```

In Xcode, App target → **Signing & Capabilities**:

- [ ] Set your Team (writes `DEVELOPMENT_TEAM` — currently absent in `project.pbxproj`).
- [ ] Bundle id confirms as `ai.klorn.app`; version 1.0 (1).
- [ ] Add capability **Push Notifications**.
- [ ] Add capability **Background Modes** → check *Remote notifications* (matches `Info.plist` `UIBackgroundModes`). These two create the `.entitlements` file with `aps-environment`.
- [ ] Add `PrivacyInfo.xcprivacy` to target membership: Project Navigator → right-click `App` group → *Add Files…* → select the file → check the **App** target. (File exists in repo; without membership it is not bundled → ITMS-91053 risk.)
- [ ] Sanity build to a simulator: app boots to the app.klorn.ai login screen.

## Phase 2 — Archive + upload (~30 min + ~15–45 min Apple processing)

In Xcode:

- [ ] Select destination **Any iOS Device (arm64)**.
- [ ] Product → **Archive** (5–10 min build).
- [ ] Organizer opens → **Distribute App** → *App Store Connect* → *Upload* (accept defaults: symbols on, auto-signing).
- [ ] Wait for the "processing completed" email from Apple (15–45 min). Export-compliance prompt should NOT appear (`ITSAppUsesNonExemptEncryption=false` in `Info.plist:52-53` answers it in-binary); if it does, answer "standard HTTPS only / exempt".

## Phase 3 — App Store Connect record + metadata (~1–1.5 h)

At appstoreconnect.apple.com → My Apps → **+ New App**:

- [ ] Platform iOS, name **Klorn: AI Email Firewall**, primary language English (U.S.), bundle id `ai.klorn.app`, SKU e.g. `klorn-ios-1`.
- [ ] Paste everything from `store-pack/metadata.md`: subtitle, promo text, description, keywords, support/marketing URLs, category (Productivity / Business).
- [ ] Add **Korean** localization; paste the KO block.
- [ ] Pricing: Free (IAP separately later if RevenueCat ships).
- [ ] Age rating questionnaire → 4+ (all "No"; see `metadata.md`).
- [ ] **App Privacy** section → answer per `store-pack/privacy-labels.md` (must match `PrivacyInfo.xcprivacy`).
- [ ] Privacy Policy URL: `https://app.klorn.ai/privacy`.
- [ ] Upload screenshots per `store-pack/screenshots-plan.md` (capture is its own ~2 h block — can be done any time before this step).
- [ ] App Review Information: demo account email + password, your phone + email, paste notes from `store-pack/review-notes.md` §2 (with the demo-video link filled in).

## Phase 4 — TestFlight internal pass (~30 min hands-on, same day)

Do NOT skip — this is the only end-to-end test of the store-signed binary.

- [ ] TestFlight tab → the processed build → add yourself as internal tester.
- [ ] Install via TestFlight on a real iPhone.
- [ ] Verify: login (email/password demo account) → command center renders → notification permission prompt appears → send yourself a PUSH-tier email → **visible push arrives with the app closed** → tapping it opens the app. (This is the 4.2 make-or-break; `APNS_PRODUCTION=true` must be set on Render for TestFlight/App Store builds — `STORE_SUBMISSION.md` §A.4.)
- [ ] Verify account deletion is reachable (Settings) and external links open in the system browser.
- [ ] If anything fails: fix → bump build number (`CURRENT_PROJECT_VERSION` 2) → re-archive → re-upload (Phase 2, now ~20 min).

## Phase 5 — Submit for review (~10 min + 1–3 day wait)

- [ ] App Store tab → select the tested build for version 1.0.
- [ ] Release option: **Manually release** (recommended for v1 — you control launch timing after approval).
- [ ] Re-open the demo Gmail once to confirm the linked inbox is live (review can start within hours).
- [ ] **Submit for Review.** Typical wait: 24–72 h. Keep the contact phone reachable.

## Phase 6 — After the verdict

- **Approved** → release manually → smoke-test the live App Store install → rotate the demo account password.
- **Rejected** → read the resolution center message; the two most likely codes and their pre-built answers:
  - **4.2 (minimum functionality)** → reply with the native-functionality section of `review-notes.md` §2 + the push demo video; if it persists, the escalation path is a phone call with App Review (request it in Resolution Center).
  - **2.1 (couldn't log in / blank content)** → almost always the demo Gmail token went stale or the seeded inbox looked empty — refresh the link, re-verify on device, resubmit (no new binary needed).
- [ ] Post-launch bookkeeping: file the standing items — CASA/OAuth verification progress (§D), RevenueCat products before charging in-app (§C), Sign in with Apple decision (4.8 de-risk, currently exempt via email/password — `STORE_SUBMISSION.md`).

---

## Time budget summary

| Phase | Hands-on | Wall-clock |
|---|---|---|
| 0 Preflight (incl. demo account) | 1.5 h | 1.5 h |
| 1 Xcode signing/capabilities | 45 min | 45 min |
| 2 Archive + upload | 30 min | 1–1.5 h |
| 3 ASC metadata (+ screenshots 2 h) | 3–3.5 h | 3–3.5 h |
| 4 TestFlight verification | 30 min | 1 h |
| 5 Submit | 10 min | +1–3 days review |
| **Total** | **~1 working day** | **2–4 calendar days** |

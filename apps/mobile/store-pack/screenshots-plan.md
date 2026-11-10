# Screenshot plan — App Store + Google Play

Revised 2026-10-16 for the bundled app. Screens come from the app's own mock
build (fixtures in `src/api/mock/`, no network, no real mail), so nothing
personal can leak into a listing.

Two sources:

| Source | What it gives | Use it for |
|---|---|---|
| **Store capture** — `store-pack/capture/` (this folder) | 8 screens × 5 store sizes × KO + EN, light, at exact store pixel sizes | **Uploading** |
| **CI artifact `mobile-screenshots`** — `npm run e2e`, uploaded by the `App — typecheck, test, build, screenshots` job in `.github/workflows/mobile.yml` (`apps/mobile/test-results/`) | every screen and state at 7 device sizes, light + dark, **Korean only, device scale 1** (e.g. 390×844 px) | Choosing frames, design review, foldable / Flip shots. Not upload-ready: the pixel sizes are below what the stores accept for the main sets |

## Exporting the store set

```bash
cd apps/mobile
npm ci
npx playwright install chromium        # skip in images that preinstall Chromium
npx playwright test --config store-pack/capture/playwright.store.config.ts
# → test-results/store-shots/<target>/<ko|en>/<NN-screen>.png
#   (set KLORN_STORE_SHOTS_DIR to write elsewhere)
```

Ran on 2026-10-16: 80 passed in ~2 min; PNGs are RGB without alpha (both
stores reject transparency). Check sizes before uploading:
`sips -g pixelWidth -g pixelHeight test-results/store-shots/*/*/*.png` (macOS)
or `file …/*.png`.

| Target folder | Viewport × scale | Pixels | Store slot |
|---|---|---|---|
| `ios-6.9` | 440×956 @3 | **1320 × 2868** | App Store iPhone 6.9" |
| `ipad-13` | 1032×1376 @2 | **2064 × 2752** | App Store iPad 13" |
| `play-phone` | 360×640 @3 | **1080 × 1920** (9:16) | Play phone |
| `play-tablet-7` | 960×540 @2 | **1920 × 1080** (16:9, rail layout) | Play 7" tablet |
| `play-tablet-10` | 1280×720 @2 | **2560 × 1440** (16:9, sidebar layout) | Play 10" tablet |

---

## Required sizes (as I know them — confirm in each console)

Apple and Google change these; the upload page in each console is the source
of truth. Double-check before the first upload.

**App Store Connect** (Media Manager, per localization)

- **iPhone 6.9"** — 1320×2868 (also accepted: 1290×2796, 1260×2736),
  portrait or landscape. Required unless you supply **6.5"** instead
  (1284×2778 or 1242×2688). Smaller iPhone sizes are scaled from these.
- **iPad 13"** — 2064×2752 (also accepted: 2048×2732). **Required**: the app
  ships for iPad (`TARGETED_DEVICE_FAMILY = "1,2"`).
- 1–10 screenshots per size; PNG or JPEG, no transparency. App previews
  (video) optional.

**Google Play Console** (Main store listing, per language)

- **Phone**: 2–8 screenshots, PNG or JPEG without alpha, each side 320–3840
  px, the long side at most 2× the short side (so the CI artifact's 412×915 —
  ratio 2.2 — is rejected even before the size rule). For Play to feature the
  app, at least 4 at ≥1080 px, 16:9 or 9:16.
- **7-inch tablet** and **10-inch tablet**: up to 8 each, same file rules;
  supply them — the app is built for large screens and Play's large-screen
  listing quality checks look for them.
- **Foldables**: no separate upload slot that I know of; foldable layouts go in
  the tablet sets or the phone set. Confirm in the console.
- **Feature graphic**: **1024×500**, JPEG or 24-bit PNG — required, and not in
  the repo yet; make one from the brand assets (`website/brand/`).
- **App icon**: 512×512 32-bit PNG — export from `apps/mobile/assets/icon-only.png`
  (1024×1024): `sips -z 512 512 icon-only.png --out play-icon-512.png`.

---

## The set (order = what search results show first)

Same eight screens for every target. Captions are for framed marketing shots
(text above the screenshot); neither console has a caption field, so either
burn them into a frame or upload the raw screens. Captions use the app's own
words — Today, Mail, Approvals, Done — and the exact lane names.

| # | File | Screen | Caption EN | Caption KO |
|---|---|---|---|---|
| 1 | `01-today.png` | Today: "Needs you now" (PUSH + MEETING with reasons), lane counts, next event, approvals waiting | **What needs you, first.** | **지금 챙길 것부터.** |
| 2 | `02-mail.png` | Mail: every account in one list, lane chips PUSH · MEETING · QUEUE · INFO · SILENT, source badges | **Every account, one list, five lanes.** | **모든 계정을 한 목록에, 다섯 레인으로.** |
| 3 | `03-reader.png` | A PUSH message with "Why we told you now" and context lines | **Every message says why it's there.** | **메일마다 이유가 한 줄로.** |
| 4 | `08-swipe-done.png` | Mid-swipe right on a row: "Done" | **Swipe right: done. Your mailbox stays as it is.** | **오른쪽으로 밀면 처리 완료. 메일함은 그대로.** |
| 5 | `04-confirm-send.png` | The "Review & send" confirmation sheet | **Nothing is sent until you confirm.** | **확인하기 전에는 보내지 않습니다.** |
| 6 | `05-calendar.png` | Calendar week across connected calendars | **Your calendars beside your mail.** | **메일 옆에 캘린더를.** |
| 7 | `06-approvals.png` | Assistant › Approvals | **Drafts and events wait for your yes.** | **초안과 일정은 승인을 기다립니다.** |
| 8 | `07-push-priming.png` | The notification explanation before the OS prompt | **Only rings when it matters.** | **꼭 필요할 때만 울려요.** |

Per store: App Store — all 8 for `ios-6.9` and `ipad-13`. Play phone — all 8
from `play-phone`. Play tablets — 4–6 from `play-tablet-7` / `play-tablet-10`
(today, mail, reader, confirm, calendar, approvals; the priming screen and the
swipe read better on phones).

Upload the `ko` folder to the Korean localization and `en` to English (U.S.).

### Foldable / Flip extras (Play, optional, from the CI artifact)

These need the hinge emulation, which forces device scale 1, so they come only
from `mobile-screenshots` at 884×1104 px (fine for Play's 320–3840 rule; below
the 1080 px "featured" bar). Korean only.

| Show | Artifact file |
|---|---|
| Fold, book posture — list and message one per side | `mail/list-fold-hinge-884x1104-light.png`, `mail-fold-hinge-884x1104-light.png` |
| Fold, tabletop — read above, reply below | `mail/reader-fold-tabletop-884x1104-light.png`, `today-fold-tabletop-884x1104-light.png` |
| Z Flip cover screen — one PUSH item, Done / Later | `cover-flip-360x400-light.png` (also `cover-360x400-light.png` from the hub spec) — 360×400 is too small for a Play slot; use it in a framed composite or the feature graphic only |

---

## Map of the e2e screenshot names (CI artifact `mobile-screenshots`)

All under `apps/mobile/test-results/shots/` (or `$KLORN_SHOTS_DIR`), Korean
UI, `{theme}` = `light` | `dark`, device scale 1.

| Spec | Output pattern | Devices / variants |
|---|---|---|
| `e2e/screens.spec.ts` | `today-{device}-{theme}.png` | `iphone-390x844`, `android-412x915`, `fold-open-884x1104`, `fold-hinge-884x1104`, `fold-tabletop-884x1104`, `ipad-portrait-1024x1366`, `ipad-landscape-1366x1024`, `ipad-mini-portrait-744x1133` |
| | `cover-flip-360x400-{theme}.png`, `welcome-390x844-{theme}.png`, `mail-fold-hinge-884x1104-{theme}.png` | |
| | `state-{loading,empty,error,noAccounts}-390x844.png`, `state-offline-cached-390x844.png`, `state-offline-empty-390x844.png` | light only |
| `e2e/mail.spec.ts` → `mail/` | `list-`, `reader-`, `lanesheet-`, `subscriptions-{device}-{theme}.png` | `iphone-390x844`, `android-412x915`, `fold-open-884x1104`, `fold-hinge-884x1104`, `fold-tabletop-884x1104`, `ipad-landscape-1366x1024` |
| | `swipe-done-reveal-`, `done-snackbar-`, `multiselect-`, `accounts-sheet-`, `menu-sheet-`, `row-actions-`, `later-sheet-`, `reader-draft-`, `reader-html-images-blocked-`, `reader-html-images-shown-`, `reader-plain-`, `composer-reply-`, `confirm-send-`, `receipt-`, `composer-new-`, `search-`, `subscriptions-confirm-`, `state-{loading,empty,error,noAccounts}-`, `state-offline-cached-`, `state-offline-empty-`, `state-push-empty-`, `state-reader-loading-`, `state-reader-error-` + `390x844-{theme}.png` | phone only |
| `e2e/hub.spec.ts` | `{screen}-{device}-{theme}.png` with screen ∈ `calendar`, `calendar-event`, `calendar-new`, `calendar-team`, `assistant-chat`, `assistant-approvals`, `assistant-approval-detail`, `assistant-activity`, `files`, `files-detail`, `accounts`, `accounts-add`, `settings`, `settings-notifications`, `settings-plans`, `settings-delete`, `push-priming` | `iphone-390x844`, `android-412x915`, `fold-open-884x1104`, `fold-hinge-884x1104`, `fold-tabletop-884x1104`, `ipad-mini-744x1133`, `ipad-landscape-1366x1024` |
| | `assistant-sheet-ipad-landscape-1366x1024-{theme}.png`, `cover-360x400-{theme}.png` | |
| | `state-{loading,empty,error,featuresOff}-{calendar,assistant-chat,assistant-approvals,assistant-activity,files,accounts,settings-notifications}-390x844.png`, `state-offline-{calendar,files}-390x844.png` | light only |
| `e2e/*-behaviour.spec.ts` | no screenshots (assertions only) | |

Verified 2026-10-16 with a full local `npm run e2e` (430 passed): every
name above exists, at device scale 1 (e.g. `today-iphone-390x844-light.png`
is 390×844 px).

Note the two iPad mini names (`ipad-mini-portrait-744x1133` in screens,
`ipad-mini-744x1133` in hub) — same size.

---

## Check before you upload

- [x] **Outlook in frame** (fixed 2026-10-16). The fixtures connect no
      Outlook account or calendar: the second work account is a Google
      Workspace one ("파트너스"), so badges, "All accounts" and the MEETING
      reason name only connectable providers (`src/api/mock/fixtures.ts`,
      `fixtures-hub.ts`, `mail-fixtures.ts`). Look once more after a fixture
      change.
- [x] **Third-party brand names** (fixed 2026-10-16). Every third-party
      sender is fictional (한끼배달, 옷장마켓, 모아페이, 구름보관함, 새벽카드,
      누리항공, the Subscriptions list); the user's own Gmail / Naver / iCloud
      accounts keep their provider names, which are factual integrations.
- [ ] The English set shows English chrome over Korean fixture mail. Fine for
      the Korean storefront; for the English listing, consider English
      fixtures or captions that carry the message.
- [ ] Status bar: the mock fakes safe areas but draws no status bar. Leave the
      top as is, or composite a 9:41 status bar in the frame. Never show a
      fake notification or a fake system UI that implies a feature the build
      lacks.
- [ ] Price: the Plans screen is not in the set on purpose (the price comes
      from the store at run time).
- [ ] Re-run after any UI change; the shots must match the submitted build.

# Store listing — Klorn (App Store + Google Play)

Copy-paste source for App Store Connect and the Play Console, for the
**bundled app** (`apps/mobile/src`, React inside the binary — see
`apps/mobile/README.md`). Revised 2026-10-16.

Grounded in the repo:

- Bundle / package id `ai.klorn.app` (`capacitor.config.ts`, `project.pbxproj`,
  `android/app/build.gradle`). Binary display name `Klorn`.
- Version: `mobile-release.yml` sets it from the `mobile-v<x.y.z>` tag; the
  build number is the workflow run number.
- Positioning and account list follow the landing (`website/index.html`,
  `website/ko/index.html`, same on `main`): Gmail and Google Calendar
  available; Naver Mail and iCloud Mail **beta**. **Outlook is not listed**:
  the landing does not offer it, and `OUTLOOK_INBOX_ENABLED` is dark by
  default (`render.yaml` declares it `sync: false`; the app hides the Outlook
  row on the 404). Add it here only
  the day the landing does.
- Lanes are exactly PUSH / MEETING / QUEUE / INFO / SILENT
  (`docs/product-vocabulary.md`). Home is **Today**, the approval list is
  **Approvals** (KO tab label "승인"), the record is **Activity** ("활동").

Rules this copy follows: no "only / first / unique / best" claims, no numbers
that cannot be checked, no price (the store shows the price from the
subscription product itself; the landing's Pro price is $29.99/mo on `main`,
but App Store / Play prices are set per storefront in the consoles), and no
feature that is dark in production.

Character counts below were computed with Python `len()` (Unicode code
points, which is how both consoles count; a Hangul syllable is one character).
Re-count if you edit: `python3 -c "print(len(open('x.txt').read().rstrip('\n')))"`.

---

## Preconditions the copy depends on

| Claim in the copy | True only if | Where |
|---|---|---|
| "Sign in with Apple" | `APPLE_LOGIN_ENABLED=true` (+ the `APPLE_*` keys) on the API; the app shows the button only when `GET /api/auth/providers` lists Apple | `packages/api/src/auth/apple.ts`, `WelcomeScreen.tsx` |
| The Klorn Pro paragraph | `VITE_REVENUECAT_IOS_KEY` / `VITE_REVENUECAT_ANDROID_KEY` are set as GitHub secrets (or variables) — `mobile-release.yml` passes them to `npm run build` — and the subscription product is approved | `src/platform/iap.ts` |
| Naver Mail / iCloud Mail (beta) | the IMAP routes answer in production (the landing says they do; the app hides each row on a 404) | `routes/imap-connect.ts` |

If IAP does not ship in the first build, replace the Pro paragraph with
"Klorn is free to use." and drop the Terms line only if you also drop the
subscription (Apple wants the Terms of Use link whenever an auto-renewing
subscription is sold).

Deliberately **not** claimed (dark or unverified in production): Outlook,
Subscriptions / bulk unsubscribe (`BULK_UNSUBSCRIBE_ENABLED`), Klorn Drive and
Google Drive files (`DRIVE_ENABLED` / `GOOGLE_DRIVE_ENABLED`), team free time
(needs a team made on the web), voice input on iOS (the speech plugin is not
linked under SPM, so the mic is hidden), lock-screen notification actions (In 1 hour /
Done work on iOS now, but Send draft needs a `pendingActionId` the server does
not set yet, and Android shows no buttons on notification messages — README
"Gaps").

---

## App Store — English (en-US, primary)

### Name (≤ 30)

```
Klorn: Mail & Calendar
```

(22 chars)

### Subtitle (≤ 30)

```
All your mail, one calm place
```

(29 chars)

### Promotional text (≤ 170, editable without a new build)

```
Gmail and Google Calendar, plus Naver Mail and iCloud Mail in beta, in one list. Five lanes, each with a reason. Nothing is sent until you confirm it.
```

(150 chars)

### Description (≤ 4000)

```
Klorn brings your mail and calendars into one calm place. Connect Gmail and Google Calendar, plus Naver Mail and iCloud Mail in beta, and every message arrives in a single list, marked with the account it came from.

FIVE LANES, EACH WITH A REASON
Every message lands in one of five lanes, with a sentence that says why it is there:
• PUSH — interrupts you now. The few messages that can't wait.
• MEETING — scheduling mail, checked against your calendar.
• QUEUE — worth reading today. No notification, just a place in today's list.
• INFO — receipts and notices, filed. No reply expected.
• SILENT — kept out of your way. Never deleted.
Lanes only sort; they never act. Disagree with one? Move the message, and Klorn learns from the correction.

TODAY
Open the app to what needs you now, the count in each lane, your next event and anything waiting for your approval.

MAIL THAT MOVES WITH YOUR THUMB
• Swipe right to mark a message done. It leaves your list; your mailbox is not changed. Undo is one tap away.
• Swipe left to move it to another lane.
• Long-press to select several at once.
Every gesture also has a button, so screen-reader users get the same actions.

REPLIES YOU CHECK BEFORE THEY GO
Klorn can draft a reply for you to edit. Nothing is sent until you open "Review & send" and confirm the exact recipient, subject and text. After sending, you get a receipt.

CALENDAR AND ASSISTANT
See the week across your connected calendars. Ask the assistant about your own mail and schedule. Drafts and new events wait in Approvals until you say yes, and Activity shows what Klorn did today.

NOTIFICATIONS WHEN IT MATTERS
Klorn asks before turning notifications on. You choose what can ring: PUSH mail, MEETING mail, approvals, the morning briefing and tasks coming due. QUEUE, INFO and SILENT never ring. Tap a notification to open that message.

MADE FOR iPHONE AND iPAD
On iPad, the mail list and the message sit side by side in any orientation, in Split View and in Stage Manager. Text follows your Dynamic Type size, in light or dark appearance.

WORKS OFFLINE
Lost signal? What you last loaded stays readable for up to 24 hours, with a clear offline banner. Signing out clears it from the device.

YOUR ACCOUNT, YOUR CHOICE
• Sign in with Apple, Google or email.
• No ads and no third-party trackers.
• Klorn's code is open source under the AGPL-3.0.
• Delete your account and its data yourself in Settings, any time.

Klorn is free to use. Klorn Pro, an optional auto-renewing subscription bought in the app, adds reply drafts you approve and send, more than one connected mail account, creating events from Klorn, and a larger daily assistant allowance. Payment is charged to your Apple Account; manage or cancel it in your App Store account settings.

Terms of Use: https://klorn.ai/terms/
Privacy Policy: https://klorn.ai/privacy/
```

(2,850 chars)

### Keywords (≤ 100, comma-separated, no spaces)

```
email,inbox,triage,assistant,briefing,priority,reply,drafts,schedule,focus,productivity,lanes
```

(93 chars)

`inbox` here is a search term people type, not product copy (in Klorn's
vocabulary an inbox is a connected account). Words already in the name / subtitle (Klorn, mail, calendar, one, calm,
place) are left out — Apple indexes them anyway. Service names (Gmail, Naver,
iCloud) are left out of keywords on purpose: they are other companies'
trademarks, which App Review flags in the keyword field (2.3.7); they appear in
the description, where describing what the app connects to is fine.

### What's New (first version)

```
First release of the Klorn app for iPhone and iPad.
```

---

## App Store — 한국어 (ko)

### 이름 (≤ 30)

```
Klorn: 메일과 캘린더
```

(14 chars)

### 부제 (≤ 30)

```
모든 메일과 캘린더를, 한 곳에서
```

(18 chars)

### 프로모션 텍스트 (≤ 170)

```
Gmail과 Google 캘린더, 그리고 베타로 네이버 메일과 iCloud 메일까지 한 목록에. 메일마다 다섯 레인 중 하나와 그 이유를 보여 줍니다. 내가 확인하기 전에는 아무것도 보내지 않습니다.
```

(111 chars)

### 설명 (≤ 4000)

```
Klorn은 흩어진 메일과 캘린더를 한 곳에 차분하게 모읍니다. Gmail과 Google 캘린더, 그리고 베타로 네이버 메일과 iCloud 메일을 연결하면 모든 메일이 어느 계정에서 왔는지 표시된 채 한 목록으로 들어옵니다.

레인은 다섯, 이유는 한 줄로
모든 메일은 다섯 레인 중 하나로 들어가고, 왜 거기 있는지 한 문장으로 적혀 있습니다.
• PUSH — 지금 바로 알려야 할 메일. 미룰 수 없는 몇 통만.
• MEETING — 일정 조율 메일. 내 캘린더와 대조합니다.
• QUEUE — 오늘 읽어 두면 좋은 메일. 알림 없이 오늘 목록에 자리만.
• INFO — 영수증과 안내. 답장할 필요 없는 메일은 알아서 정리합니다.
• SILENT — 눈앞에서는 치우되, 지우지 않습니다.
레인은 나누기만 하고 대신 행동하지 않습니다. 분류가 마음에 안 들면 옮기세요. Klorn이 그 교정에서 배웁니다.

오늘
앱을 열면 지금 챙길 메일, 레인별 개수, 다음 일정, 승인을 기다리는 일이 한 화면에 있습니다.

손가락으로 정리하는 메일
• 오른쪽으로 밀면 처리 완료. 목록에서 사라지고, 메일함의 원본은 그대로입니다. 바로 실행 취소할 수 있습니다.
• 왼쪽으로 밀면 다른 레인으로 옮깁니다.
• 길게 누르면 여러 통을 한 번에 고릅니다.
모든 동작은 버튼으로도 할 수 있어 화면 읽기 기능에서도 똑같이 쓸 수 있습니다.

보내기 전에 꼭 확인하는 답장
Klorn이 답장 초안을 써 두면 직접 고칠 수 있습니다. '보내기 검토'에서 받는 사람, 제목, 본문을 그대로 확인하기 전에는 아무것도 보내지 않고, 보낸 뒤에는 기록이 남습니다.

캘린더와 도우미
연결한 캘린더의 한 주를 한 화면에서 봅니다. 도우미에게 내 메일과 일정에 대해 물어보세요. 답장 초안과 새 일정은 승인할 때까지 '승인'에서 기다리고, '활동'에서 Klorn이 오늘 한 일을 확인할 수 있습니다.

꼭 필요할 때만 울리는 알림
알림을 켜기 전에 먼저 묻습니다. PUSH 메일, MEETING 메일, 승인할 일, 아침 브리핑, 기한이 다가온 할 일 중 무엇을 받을지 직접 고르고, QUEUE·INFO·SILENT는 울리지 않습니다. 알림을 누르면 해당 메일이 열립니다.

iPhone과 iPad에 맞춰
iPad에서는 메일 목록과 본문이 나란히 보이고 가로·세로, Split View, Stage Manager를 모두 지원합니다. 글자 크기는 시스템 설정을 따르고, 라이트·다크 모드를 지원합니다.

오프라인에서도
신호가 끊겨도 마지막으로 불러온 내용을 최대 24시간 동안 오프라인 표시와 함께 볼 수 있습니다. 로그아웃하면 기기에서 지워집니다.

내 계정은 내가 정합니다
• Apple, Google 또는 이메일로 로그인합니다.
• 광고도, 제3자 추적 도구도 없습니다.
• Klorn의 코드는 AGPL-3.0 오픈소스로 공개되어 있습니다.
• 설정에서 언제든 계정과 데이터를 직접 삭제할 수 있습니다.

Klorn은 무료로 쓸 수 있습니다. 앱에서 구독하는 Klorn Pro(자동 갱신)를 쓰면 승인 후 보내는 답장 초안, 메일 계정 여러 개 연결, Klorn에서 일정 만들기, 더 넉넉한 하루 도우미 사용량이 더해집니다. 결제는 Apple 계정으로 청구되며, App Store 계정 설정에서 관리하거나 해지할 수 있습니다.

이용약관: https://klorn.ai/terms/
개인정보 처리방침: https://klorn.ai/privacy/
```

(1,692 chars)

### 키워드 (≤ 100)

```
이메일,메일함,받은편지함,분류,비서,브리핑,답장,일정,알림,생산성,업무,우선순위,회의,초안
```

(50 chars)

### 새로운 기능 (첫 버전)

```
iPhone과 iPad용 Klorn 앱의 첫 버전입니다.
```

---

## Google Play — English (en-US, default)

### App name (≤ 30)

```
Klorn: Mail & Calendar
```

(22 chars)

### Short description (≤ 80)

```
Your mail and calendars in one calm list, sorted into five lanes with reasons.
```

(78 chars)

### Full description (≤ 4000)

Same as the App Store description with two blocks swapped. Paste this:

```
Klorn brings your mail and calendars into one calm place. Connect Gmail and Google Calendar, plus Naver Mail and iCloud Mail in beta, and every message arrives in a single list, marked with the account it came from.

FIVE LANES, EACH WITH A REASON
Every message lands in one of five lanes, with a sentence that says why it is there:
• PUSH — interrupts you now. The few messages that can't wait.
• MEETING — scheduling mail, checked against your calendar.
• QUEUE — worth reading today. No notification, just a place in today's list.
• INFO — receipts and notices, filed. No reply expected.
• SILENT — kept out of your way. Never deleted.
Lanes only sort; they never act. Disagree with one? Move the message, and Klorn learns from the correction.

TODAY
Open the app to what needs you now, the count in each lane, your next event and anything waiting for your approval.

MAIL THAT MOVES WITH YOUR THUMB
• Swipe right to mark a message done. It leaves your list; your mailbox is not changed. Undo is one tap away.
• Swipe left to move it to another lane.
• Long-press to select several at once.
Every gesture also has a button, so screen-reader users get the same actions.

REPLIES YOU CHECK BEFORE THEY GO
Klorn can draft a reply for you to edit. Nothing is sent until you open "Review & send" and confirm the exact recipient, subject and text. After sending, you get a receipt.

CALENDAR AND ASSISTANT
See the week across your connected calendars. Ask the assistant about your own mail and schedule. Drafts and new events wait in Approvals until you say yes, and Activity shows what Klorn did today.

NOTIFICATIONS WHEN IT MATTERS
Klorn asks before turning notifications on. You choose what can ring: PUSH mail, MEETING mail, approvals, the morning briefing and tasks coming due. QUEUE, INFO and SILENT never ring. Tap a notification to open that message.

MADE FOR PHONES, FOLDABLES AND TABLETS
On a Galaxy Z Fold or a tablet, the mail list and the message sit side by side, one on each side of the fold. Half-fold it and read on top while you reply below. On a Z Flip cover screen, see the one PUSH message that needs you and mark it done or later. Rotation, multi-window and pop-up view keep your place. Light and dark theme.

WORKS OFFLINE
Lost signal? What you last loaded stays readable for up to 24 hours, with a clear offline banner. Signing out clears it from the device.

YOUR ACCOUNT, YOUR CHOICE
• Sign in with Google, Apple or email.
• No ads and no third-party trackers.
• Klorn's code is open source under the AGPL-3.0.
• Delete your account and its data yourself in Settings, any time.

Klorn is free to use. Klorn Pro, an optional auto-renewing subscription bought in the app through Google Play, adds reply drafts you approve and send, more than one connected mail account, creating events from Klorn, and a larger daily assistant allowance. Manage or cancel it in Google Play.

Terms of Service: https://klorn.ai/terms/
Privacy Policy: https://klorn.ai/privacy/
```

(2,981 chars)

---

## Google Play — 한국어 (ko-KR)

### 앱 이름 (≤ 30)

```
Klorn: 메일과 캘린더
```

(14 chars)

### 간단한 설명 (≤ 80)

```
흩어진 메일과 캘린더를 한 목록에. 다섯 레인으로 나누고, 왜 그런지 알려 줍니다.
```

(46 chars)

### 자세한 설명 (≤ 4000)

KO App Store 설명에서 "iPhone과 iPad에 맞춰" 단락과 마지막 결제 단락을
아래로 바꿔 붙여 넣습니다.

```
휴대폰, 폴더블, 태블릿에 맞춰
Galaxy Z Fold나 태블릿에서는 메일 목록과 본문이 접히는 선 양쪽에 나란히 보입니다. 반쯤 접으면 위에서 읽고 아래에서 답장합니다. Z Flip 커버 화면에서는 지금 챙길 PUSH 메일 하나를 보고 처리 완료나 나중에로 넘길 수 있습니다. 화면을 돌리거나 멀티 윈도우·팝업 화면으로 바꿔도 보던 자리를 유지하고, 라이트·다크 테마를 지원합니다.
```

```
Klorn은 무료로 쓸 수 있습니다. Google Play를 통해 앱에서 구독하는 Klorn Pro(자동 갱신)를 쓰면 승인 후 보내는 답장 초안, 메일 계정 여러 개 연결, Klorn에서 일정 만들기, 더 넉넉한 하루 도우미 사용량이 더해집니다. 관리와 해지는 Google Play에서 할 수 있습니다.

이용약관: https://klorn.ai/terms/
개인정보 처리방침: https://klorn.ai/privacy/
```

Also change "• Apple, Google 또는 이메일로 로그인합니다." to
"• Google, Apple 또는 이메일로 로그인합니다." The result is about 1,770 chars.

---

## URLs (both stores)

| Field | Value | Note |
|---|---|---|
| Support URL | `https://klorn.ai/` (KO: `https://klorn.ai/ko/`) | Landing footer has a Contact mailto. A page that says "Support" outright is safer for review — optional |
| Marketing URL (Apple) / Website (Play) | `https://klorn.ai/` (KO: `https://klorn.ai/ko/`) | |
| Privacy Policy | `https://klorn.ai/privacy/` | The URL the app itself links (`WelcomeScreen.tsx`, `settings/parts.tsx`). It is a redirect page on GitHub Pages to the live policy at `https://app.klorn.ai/privacy` (`packages/web/src/app/privacy/page.tsx`); if a console rejects the redirect, paste the target URL |
| Terms of Use (Apple: App Information → License Agreement, or the description link) | `https://klorn.ai/terms/` → `https://app.klorn.ai/terms` | Required once an auto-renewing subscription is sold (3.1.2) |
| Play: Delete account URL (Data safety) | `https://app.klorn.ai/privacy#retention-and-deletion` | The policy's "Retention and Deletion" section: self-service deletion in Settings, what is deleted and when, and an email contact |
| Support email (Play "Contact details") | the founder's contact address | Play shows it publicly |

## Category

- **App Store**: primary **Productivity**, secondary **Business**.
- **Google Play**: app category **Productivity**; tags such as "Email" and
  "Calendar" if the console offers them.

## Age rating / content rating

- **App Store** (App Information → Age Rating): answer **None / No** to every
  content question (violence, mature themes, gambling, etc.). "Unrestricted
  web access": **No** — the app has no browser; links in mail open in the
  system browser and mail HTML renders in a sandboxed frame without scripts
  (`src/screens/mail/mail-html.ts`). Apple's questionnaire was revised in
  2025 (13+/16+/18+ bands and questions about messaging and user-generated
  content); if it asks whether users can message others, answer **Yes** —
  the app sends email — and accept the band it computes. Expected result is
  the lowest band (4+) unless that messaging answer raises it; check the
  outcome in App Store Connect.
- **Google Play** (IARC questionnaire): category *Utility, Productivity,
  Communication or Other*. No violence / sexuality / gambling / drugs. "Can
  users interact or exchange content?" — **Yes** (email); "shares user
  location" — No; "digital purchases" — Yes if IAP ships. Expect *Everyone /
  IARC 3+* with the "Users Interact" (and "In-App Purchases") notices.
- **Play target audience**: **18 and over** (a work mail tool; keeps the app
  out of the Families policy).
- **Ads**: No ads (both stores). Play "Advertising ID": **No** — no SDK in
  `apps/mobile/package.json` reads it (check the merged manifest has no
  `com.google.android.gms.permission.AD_ID` before answering).

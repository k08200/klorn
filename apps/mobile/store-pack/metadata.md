# App Store Connect metadata — Klorn (iOS)

Copy-paste source for the App Store Connect listing. Grounded in the repo:

- Bundle ID: `ai.klorn.app` (`apps/mobile/ios/App/App.xcodeproj/project.pbxproj:308`, `capacitor.config.ts` `appId`)
- App name (binary): `Klorn` (`Info.plist` `CFBundleDisplayName`)
- Version: `1.0` / build `1` (`project.pbxproj` `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`)
- Product: Capacitor 8 shell loading the hosted web app `https://app.klorn.ai` (`capacitor.config.ts` `server.url`)

Character limits are Apple's. Counts noted where tight.

---

## English (Primary — en-US)

### App Name (max 30)

```
Klorn: AI Email Firewall
```

(24 chars)

### Subtitle (max 30)

```
An attention firewall for mail
```

(30 chars — exactly at limit)

### Promotional Text (max 170)

```
Klorn triages your inbox into four tiers — PUSH, QUEUE, SILENT, AUTO — so only mail worth interrupting you ever does. Wake up to one briefing, not forty unread emails.
```

(166 chars)

### Description (max 4000)

```
Your inbox isn't your to-do list. Klorn is an attention firewall: it reads your mail the moment it arrives and decides — before you ever see it — whether it deserves your attention right now, later, or never.

THE 4-TIER MODEL

Every incoming email lands in exactly one tier:

• PUSH — genuinely urgent. You get a native notification immediately.
• QUEUE — needs a decision from you, but not right now. It waits in a ranked decision queue.
• SILENT — worth keeping, not worth interrupting you. Filed quietly.
• AUTO — noise. Classified and kept out of your way.

No folders to maintain, no rules to write. The firewall learns your inbox and does the sorting for you.

ONE MORNING BRIEFING

Instead of waking up to a wall of unread mail, you get a single morning briefing: what came in overnight, what actually matters, and what Klorn already handled. Read it in a minute, start your day with a clear head.

A DECISION QUEUE, NOT AN INBOX

The mail that needs you is turned into decision cards: reply, approve, hold, or handle — one card, one decision, done. Evidence is attached, and nothing is sent on your behalf without your approval.

REAL-TIME GMAIL

Connect your Gmail and Klorn works on live mail — new messages are classified as they arrive, and urgent ones reach you as native push notifications even when the app is closed.

BUILT FOR TRUST

• You approve before anything leaves your hands — every real-world action produces a receipt.
• Sign in with Google (in your system browser) or with email and password.
• No ads, no third-party trackers, no data brokers. Your mail is processed to run the firewall for you — nothing else.
• Delete your account and all data yourself, any time, from Settings.

WHO IT'S FOR

Founders, operators, and anyone whose inbox has become a job. If you check email forty times a day to make sure nothing is on fire, Klorn is the smoke detector — it checks so you don't have to.

Noise in. One clear signal out.

—

Klorn requires a Gmail account for live mail triage. A free tier is available; upgrading unlocks Klorn acting on your behalf.
```

(~2,150 chars — well under 4,000, room for update notes later)

### Keywords (max 100, comma-separated, no spaces after commas)

```
email,inbox,gmail,ai,assistant,triage,firewall,focus,briefing,productivity,notifications,zero
```

(93 chars)

### URLs

| Field | Value | Note |
|---|---|---|
| Support URL | `https://klorn.ai/` | Static landing (`website/index.html`, GitHub Pages) |
| Marketing URL | `https://klorn.ai/` | Same landing; KO variant at `https://klorn.ai/ko/` |
| Privacy Policy URL | `https://app.klorn.ai/privacy` | Live route (`packages/web/src/app/privacy/`) |
| Terms of Use (EULA) | `https://app.klorn.ai/terms` | Live route (`packages/web/src/app/terms/`); required if subscriptions ship |

### Category

- **Primary: Productivity** — the app's job is inbox triage / attention management; peer apps (Spark, Superhuman-alikes) sit here.
- **Secondary: Business** — email chief-of-staff positioning targets founders/operators; safer than Utilities (which invites the 4.2 "thin utility" frame).

### Age Rating

No objectionable content → **4+** (answer "No" to all content questions). Unrestricted web access is NOT triggered: the shell locks navigation to `app.klorn.ai` (`capacitor.config.ts` `allowNavigation`), external links open in the system browser.

---

## 한국어 (ko) — App Store 현지화 블록

### 앱 이름 (30자)

```
Klorn: AI 이메일 방화벽
```

### 부제 (30자)

```
받은편지함을 위한 어텐션 방화벽
```

### 프로모션 텍스트 (170자)

```
Klorn이 메일을 PUSH·QUEUE·SILENT·AUTO 4단계로 자동 분류합니다. 정말 급한 메일만 알림으로 받고, 아침엔 40통의 안 읽은 메일 대신 브리핑 하나로 하루를 시작하세요.
```

### 설명

```
받은편지함은 할 일 목록이 아닙니다. Klorn은 어텐션 방화벽입니다. 메일이 도착하는 순간 읽고, 당신이 보기도 전에 판단합니다 — 지금 봐야 할 메일인지, 나중에 봐도 되는지, 아예 볼 필요가 없는지.

4단계 분류 모델

모든 수신 메일은 정확히 하나의 단계로 분류됩니다.

• PUSH — 정말 급한 메일. 즉시 네이티브 알림으로 알려드립니다.
• QUEUE — 결정이 필요하지만 지금은 아닌 메일. 우선순위가 매겨진 결정 대기열에서 기다립니다.
• SILENT — 보관할 가치는 있지만 방해할 가치는 없는 메일. 조용히 정리됩니다.
• AUTO — 소음. 분류만 하고 시야 밖에 둡니다.

폴더 정리도, 규칙 작성도 필요 없습니다. 방화벽이 당신의 받은편지함을 학습해 대신 분류합니다.

하나의 아침 브리핑

안 읽은 메일의 벽 대신, 아침 브리핑 하나를 받으세요. 밤사이 무엇이 왔고, 무엇이 실제로 중요하며, Klorn이 무엇을 이미 처리했는지 — 1분이면 읽고 맑은 머리로 하루를 시작할 수 있습니다.

받은편지함이 아닌 결정 대기열

당신이 필요한 메일은 결정 카드로 바뀝니다. 답장, 승인, 보류, 처리 — 카드 하나, 결정 하나면 끝. 근거가 함께 제시되고, 승인 없이는 어떤 것도 당신 이름으로 발송되지 않습니다.

실시간 Gmail

Gmail을 연결하면 Klorn이 실제 메일에서 작동합니다. 새 메일은 도착 즉시 분류되고, 급한 메일은 앱이 꺼져 있어도 네이티브 푸시 알림으로 도달합니다.

신뢰를 위한 설계

• 모든 실제 액션은 당신의 승인 후에만 실행되고, 영수증(receipt)이 남습니다.
• Google 로그인(시스템 브라우저) 또는 이메일/비밀번호로 가입할 수 있습니다.
• 광고 없음, 제3자 트래커 없음. 메일은 오직 방화벽 기능을 위해서만 처리됩니다.
• 설정에서 언제든 계정과 모든 데이터를 직접 삭제할 수 있습니다.

이런 분들을 위해

창업자, 운영자, 그리고 받은편지함이 하나의 업무가 되어버린 모든 사람. 불이 났는지 확인하려고 하루에 마흔 번 메일을 열어본다면, Klorn이 대신 확인하는 화재 감지기가 되어드립니다.

소음은 들어오고, 명확한 신호 하나만 나갑니다.

—

실시간 메일 분류에는 Gmail 계정이 필요합니다. 무료 티어로 시작하고, Klorn이 당신을 대신해 행동할 때 업그레이드하세요.
```

### 키워드 (100자)

```
이메일,메일,지메일,받은편지함,AI,비서,분류,방화벽,집중,브리핑,생산성,알림
```

### 지원/마케팅 URL

- 지원 URL: `https://klorn.ai/ko/`
- 마케팅 URL: `https://klorn.ai/ko/`
- 개인정보 처리방침: `https://app.klorn.ai/privacy`

---

## Notes for whoever pastes this in

- The **Keywords** field must not repeat words already in the App Name/Subtitle to maximize coverage — the list above avoids "attention"/"firewall" duplication where possible but keeps `firewall` because it's the core search term; drop it if you prefer strict non-duplication.
- **Promotional Text** is editable without a new binary — use it for launch announcements later.
- The description's claims (4 tiers, briefing, push, approval receipts, account deletion, free tier) are all live product behavior per `apps/mobile/STORE_SUBMISSION.md` pre-scan; do not add claims for features that are not reachable in the shell (e.g. on-device Samsung calendar — removed; iOS voice dictation — see `review-notes.md`).

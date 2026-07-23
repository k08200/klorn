# Screenshot plan — iOS App Store

The shell renders `app.klorn.ai`, so screenshots are just the web app captured
inside the iOS Simulator with a **logged-in demo account holding seeded mail**
(reuse the review demo account from `review-notes.md` — do NOT screenshot your
real inbox; real sender names/subjects in a store listing are a privacy leak).

---

## Required sizes (App Store Connect, 2026)

| Device class | Pixel size (portrait) | Required? | Simulator to use |
|---|---|---|---|
| iPhone 6.9" | 1320 × 2868 | **Required** (covers all iPhone slots — smaller sizes auto-scale if omitted) | iPhone 16 Pro Max (or newest Pro Max installed) |
| iPhone 6.5" | 1242 × 2688 | Optional but recommended (older-device listing looks sharper than a downscale) | iPhone 11 Pro Max / Xs Max |
| iPad 13" | 2064 × 2752 | **Required — the target ships iPad** (`TARGETED_DEVICE_FAMILY = "1,2"`, `project.pbxproj:312`) | iPad Pro 13-inch (M4) |

Up to 10 screenshots per size; we ship 6. Alternative: set
`TARGETED_DEVICE_FAMILY = 1` (iPhone-only) in Xcode to drop the iPad set —
decide before archiving, it changes the App Store device availability.

Two localizations: **en-US** and **ko** (ASC lets each localization carry its
own screenshots; capture twice with the device language switched, or reuse EN
shots for KO with KO captions if time-boxed).

---

## The 6 shots

Order matters — the first 2–3 are what shows in search results.

| # | Screen (route on app.klorn.ai) | What must be visible | Caption EN | Caption KO |
|---|---|---|---|---|
| 1 | Home command center (`/`) | Triaged inbox summary, tier counts, today's state | **Your inbox, already triaged.** | **이미 분류된 받은편지함.** |
| 2 | Mail firewall (`/inbox`) | Real-looking emails labeled PUSH / QUEUE / SILENT / AUTO | **Four tiers. Only PUSH interrupts you.** | **4단계 분류. PUSH만 당신을 방해합니다.** |
| 3 | Decision card (a QUEUE item open, `/inbox` card view) | One card with approve / edit / hold actions + evidence | **One card, one decision, done.** | **카드 하나, 결정 하나면 끝.** |
| 4 | Morning briefing (`/briefing`) | Generated briefing text with overnight summary | **Wake up to one briefing, not 40 emails.** | **메일 40통 대신 브리핑 하나로 아침을.** |
| 5 | Push notification (lock screen / notification banner) | A Klorn PUSH-tier alert visible on the lock screen | **Urgent mail finds you. The rest waits.** | **급한 메일은 당신을 찾아옵니다. 나머지는 기다립니다.** |
| 6 | Settings (`/settings`) | Notification controls + linked inbox + Delete account visible | **Your rules. Your data. Deletable anytime.** | **당신의 규칙, 당신의 데이터. 언제든 삭제 가능.** |

Shot 5 note: trigger a real push to the simulator with a payload file
(`xcrun simctl push` below) or capture on a physical device — it doubles as the
4.2 evidence frame for the review demo video.

Caption styling: captions are burned into the image (framed marketing shots)
or omitted entirely — ASC has no separate caption field. Simplest v1: raw UI
screenshots, no frames. If framing, keep the caption text above and use the
landing's tone (`website/index.html` — "Noise in. / One clear signal out.").

---

## Capture commands

```bash
# 1. List available simulators / find exact names
xcrun simctl list devices available | grep -i "pro max\|ipad pro"

# 2. Boot the 6.9" device
xcrun simctl boot "iPhone 16 Pro Max"
open -a Simulator

# 3. Install + launch the shell app on it (after an Xcode build exists)
#    — or simpler for screenshots: the shell shows app.klorn.ai, so you can
#    open Safari on the simulator and use the PWA view only if the shell build
#    isn't ready. Prefer the real app for status-bar/system chrome truthfulness.
xcrun simctl install booted path/to/App.app
xcrun simctl launch booted ai.klorn.app

# 4. Set a clean status bar (9:41, full battery/signal — Apple-style)
xcrun simctl status_bar booted override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3

# 5. Screenshot each screen (repeat per shot, navigating in the app between runs)
xcrun simctl io booted screenshot ~/Desktop/klorn-shots/69/01-command-center.png
xcrun simctl io booted screenshot ~/Desktop/klorn-shots/69/02-mail-tiers.png
# ... 03..06

# 6. Shot 5 — simulated push (needs a payload file):
cat > /tmp/klorn-push.json <<'EOF'
{ "aps": { "alert": { "title": "PUSH · Acme Corp",
  "body": "Contract signature needed before 5pm — reply required." },
  "sound": "default" } }
EOF
xcrun simctl push booted ai.klorn.app /tmp/klorn-push.json
# then lock: Device > Lock (Cmd+L) and screenshot the lock-screen banner

# 7. Korean localization pass — switch the sim language, recapture
xcrun simctl spawn booted defaults write "Apple Global Domain" AppleLanguages -array ko
xcrun simctl spawn booted defaults write "Apple Global Domain" AppleLocale ko_KR
# reboot sim, relaunch app, repeat step 5 into ~/Desktop/klorn-shots/69-ko/

# 8. Repeat the whole loop per required size
xcrun simctl boot "iPad Pro 13-inch (M4)"   # 2064×2752 set
```

Verify pixel sizes before upload (`sips -g pixelWidth -g pixelHeight *.png`) —
ASC rejects off-size images with an unhelpful error.

---

## Pre-capture data checklist

- [ ] Demo account logged in; demo Gmail linked and synced (same account as review notes)
- [ ] Seeded inbox shows all four tiers with realistic but fictional senders
- [ ] A briefing has been generated today (open `/briefing` once beforehand)
- [ ] No debug UI / flags visible; `KLORN_PROBE` NOT set (store shell only — `capacitor.config.ts`)
- [ ] Status bar override applied (step 4) on every capture
- [ ] No real personal email addresses or names anywhere in frame

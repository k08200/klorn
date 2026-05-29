# Klorn Backlog

Tracking POC.md operating rule #3 ("Dogfood pain 반사신경 끄기 — 코드 0줄,
BACKLOG.md에 적기만") plus any deliberate POC.md lock deviations the founder
explicitly accepts and the reasoning at the moment of the call.

---

## Live (POC sprint window: 2026-05-26 → 2026-06-09)

### Naver IMAP integration (POC.md lock deviation, 2026-05-29)

POC.md OUT scope explicitly said "POC 끝나고 V2", but the founder
deliberately broke the lock to bring at least one Naver-only beta tester
into the Day 14 demo pool.

The conversation (paraphrased): founder pushed back twice on the "wait
for V2" recommendation. Stated value: "유입이 더 생길 수 있으니까". Risk
acknowledged in writing — Day 14 demo deadline may slip; the rule's
authority is weakened the first time it's broken.

Decision: build inside the sprint, keep the surface narrow:
- IMAP-only (no Naver OAuth — skips the developer console review wait)
- Per-app password (encrypted with the existing `crypto-tokens.ts` AES-GCM)
- Polling every 5 min (no IMAP IDLE — Render free tier dyno can sleep)
- Same `judgeEmail` + `AttentionItem(source=EMAIL)` mirror that Gmail uses

Future check at Day 14 retro:
- Did Naver path actually deliver a usable beta tester?
- Did Day 14 deadline slip?
- Was this the right call, or was the "유입" claim unverified speculation?

The honest answer either way informs how to treat the next "이것만 더"
instinct during V2.

---

## Deferred to V2 (POC sprint must end first)

(empty — add here when "이것만 더 하면" thoughts come up during dogfood)

---

## Already deferred earlier in POC.md (not actioned in this sprint)

See POC.md section 4. OUT. Items there should NOT migrate here without
the same explicit deliberation Naver got above.

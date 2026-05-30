# Klorn POC Definition (LOCKED)

> **이 문서는 POC 14일 동안 변경 금지.**
> 변경하고 싶을 때마다 "이거 *없으면* POC 가설 검증 못 하나?"를 물어라.
> 답이 "검증 가능"이면 빼라. POC 끝나기 전엔 추가도 빼기도 안 한다.

**Sprint 시작**: 2026-05-26
**Sprint 종료**: 2026-06-09 (14일)
**Mode**: Solo, no co-founder yet
**Pre-POC PR count**: ~400 (이전은 v1 exploration, PR #424부터 POC era)

---

## 1. 가설 (1줄)

> Klorn이 들어오는 메일을 SILENT/QUEUE/PUSH/AUTO 4-tier로 **사용자 판단과 80%+ 일치하게** 분류하면, 사용자는 첫 세션에서 "이게 다른 inbox 앱과 다르다"고 느끼고 7일 연속 켠다.

---

## 2. 검증 3단계 + bar

| 단계 | 측정 | bar | Day |
|---|---|---|---|
| **Technical POC** | `poc-judge` 분류기 정확도 (본인 메일 50개 ground truth vs 모델) | ≥ 80% | Day 7 |
| **UX POC** | 첫 5분 안에 "이게 firewall이구나" 느끼는가 (ICP 5명 demo) | ≥ 3/5 | Day 14 |
| **Retention POC** | 베타 5명 7일 연속 사용 + 일평균 5+ 카드 처리 | ≥ 3/5 | Day 14 + 7 |

3개 다 통과해야 POC 성공. 1개라도 실패 → 멈추고 그 단계 원인 파악.

---

## 3. IN — POC scope (이것만 만든다)

1. **Gmail sync** — 이미 있음. 안 건드림.
2. **분류기** — `poc-judge.ts` 기반. 4-feature scorer (confidence + sender trust + reversibility + urgency) → 4-tier output. 기존 코드 위에서 정제.
3. **첫 화면 1개** — 3 column 또는 3 section (SILENT/QUEUE/PUSH visible). AUTO는 *별도 receipt 영역*에 처리 내역만.
4. **Override** — 메일 1-click으로 다른 tier로 이동. 학습 신호로 저장.
5. **Daily receipt** — "오늘 SILENT X건, QUEUE Y건, PUSH Z건, AUTO W건 처리" 한 줄.

**이게 전부.**

---

## 4. OUT — 14일 동안 코드 0줄

### 페이지 (web)
- `/chat`, `/chat/[id]`
- `/tasks`
- `/notes`, `/notes/[id]`
- `/reminders`
- `/contacts`, `/contacts/[id]`
- `/files`
- `/work-graph`
- `/agent`
- `/calendar`, `/calendar/[id]` (POC scope 외)
- `/commitments`, `/ledger` (POC scope 외 — 데이터는 보존)
- `/email/candidates`
- `/admin/waitlist`
- `/download`
- `/early-access`
- `/billing`

### Settings 서브페이지
- `/settings/email-feedback`
- `/settings/email-rules`
- `/settings/memory`
- `/settings/playbooks`
- `/settings/skills`
- `/settings/sms`
- `/settings/status`
- `/settings/usage`
- `/settings/voice`
- `/settings/workspaces`

→ `/settings`만 남기고 Google 연결 / 알림 / 승인 경계 / 데이터 삭제 4개 섹션만.

### API 라우트 (제거 대상)
- `chat.ts`
- `tasks.ts`, `notes.ts`, `reminders.ts`, `contacts.ts`
- `files.ts`, `email-attachments.ts`
- `work-graph.ts`
- `agents.ts`
- `email-candidates.ts`
- `playbooks.ts`, `skills.ts`, `patterns.ts`, `automations.ts`
- `workspace.ts`
- `devices.ts` (POC scope 외, push token만 별도 분리 검토)
- `sms.ts` (Twilio frozen)
- `billing.ts`
- `voice-profile.ts` (backend 보존 OK, route만 제거)

### API 라우트 (IN scope — 명시적 유지)
- `chat-pending-actions.ts` + Prisma `PendingAction` 모델 — **firewall AUTO tier가 실제로 실행되는 transition에 필수**. read path는 cached AttentionItem만 쓰고, action은 `/api/chat/pending-actions/:id/approve` 경유 explicit user transition으로만 실행됨 (read/reason/action 분리 원칙). dev.to 2026-05-28 reply에서 본 패턴을 그대로 유지함 — 회귀 방어는 `firewall-classifier-readpath.test.ts` 참고.

### Integration
- Slack, Notion, iMessage, macOS control, Weather, News, Writer
- Twilio (SMS), Anthropic Files
- `tool-executor.ts` → Gmail + Calendar만 남기고 나머지 제거

### 기능
- AUTO tier 자동 *실행* — 분류는 하되 실제 액션 실행은 보류. "AUTO classified" 표시만.
- Trust Score UI badge — backend 보존, UI 노출 보류
- Voice Profile → draft 생성 — backend 보존, draft 주입 보류
- Skill Recorder UI
- Pattern Learner cron
- Mobile / iOS push native
- 화려한 onboarding — text 5줄로 축소

### 모델 (Prisma)
- Workspace, WorkspaceMember
- Team, TeamMember
- Agent, TestRun, Evaluation
- ChatSession, Message (chat 관련)
- 외 사용처 없는 leftover

---

## 5. Kill Conditions

다음 중 **하나라도** true면 POC 즉시 멈춤:

1. **Day 7 Technical POC < 80%** — 4-feature scorer가 본인 판단도 못 따라감. 4-feature 자체가 wrong. → thesis 재검증.
2. **Day 12 본인 dogfood "다르지 않다"** — founder가 본인 product 느낌 못 받으면 사용자도 못 받음. → wedge re-think.
3. **Day 14 UX POC < 3/5** — 5명 중 3명이 30초 안에 "오" 안 함. → 코드 그만, 10명 problem interview 모드.

Kill되면 다음 단계는 *코드 아니라 problem re-validation* (cold interview 10명).

---

## 6. Sprint Timeline (14일)

| Day | 작업 | Done 기준 |
|---|---|---|
| 1 | POC.md lock, todo 등록, 분류기 의존성 확인 | 이 문서 commit |
| 2 | 삭제 PR 1-2개 (chat, PIM) | 페이지 수 -10 |
| 3 | 삭제 PR 3-4개 (files, work-graph, integration) | API 라우트 수 -15 |
| 4 | 삭제 PR 5-7개 (settings 축소, 모델 정리, migration) | LOC 반토막 근처 |
| 5 | 본인 메일 50개 labeling (Google Sheet) | ground truth JSON 완성 |
| 6 | `poc-judge` 실행 + disagreement 분석 + prompt 조정 | accuracy 측정 |
| 7 | **Technical POC bar 검증** | ≥ 80% 또는 KILL |
| 8 | UI Figma 30분 + 3-tier view 골격 | 화면 1개 작동 |
| 9 | Override + Daily receipt | end-to-end 사용 가능 |
| 10 | Polish + 본인 onboarding | 본인 1세션 끝 |
| 11-12 | **본인 dogfood 48h** (이 화면만) | 매시간 self-check |
| 13 | ICP 5명 cold DM + 콜 예약 | 5콜 booked |
| 14 | **5명 demo + UX POC bar 검증** | ≥ 3/5 또는 KILL |

---

## 7. 운영 룰 (POC 동안 어기지 마라)

1. **OUT 목록 추가 금지.** 추가하고 싶으면 POC 끝나고 V2.
2. **새 feature PR 금지.** 14일 동안 모든 PR은 *삭제* 또는 *POC IN 5개 중 하나*.
3. **Dogfood pain 반사신경 끄기.** "이것만 더 하면" 떠오르면 별도 `BACKLOG.md`에 적기만. 코드 0줄.
4. **PR 개수 신경 끄기.** GitHub PR 카운터 보지 마라. 이 sprint의 PR은 *POC PR #1, #2…*로만 셈.
5. **Daily commit, daily push.** 매일 작업 흔적 git에 남김. POC 끝나고 retrospective 가능.

---

## 8. Post-POC Decision Tree

```
Day 14 평가:
├─ 3/5 모두 PASS → Path A (Week 5~12: 5-tier full + Trust UI + Voice wire-up) + co-founder 영입 검토
├─ 2/5 PASS → 1주 더 reasoning model 조정, 그 후 재평가
├─ 1/5 PASS → STOP. Reposition 검토 (Plan B: K-First localization 또는 lifestyle 인정)
└─ 0/5 PASS → STOP. 10명 problem interview, 새 wedge 탐색
```

---

## 9. 측정 가능한 시작 상태 (Day 0 snapshot)

POC 시작 시점 (2026-05-26):

- Web 페이지 수: ~46
- API 라우트 수: ~40
- Prisma 모델 수: ~82
- 총 LOC (대략): ~90,000
- 누적 PR: ~424
- 베타 사용자: 1 (founder)
- DAU 외부: 0

Day 14 목표:
- Web 페이지 수: ≤ 8
- API 라우트 수: ≤ 12
- Prisma 모델 수: ≤ 30
- POC era PR: ~10-15
- 베타 사용자: 5 (ICP solo founder)
- "오 뭐야" 반응: ≥ 3/5

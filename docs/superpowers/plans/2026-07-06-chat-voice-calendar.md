# Chat UI Rebuild + Voice → Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the user-facing chat surface (web + Capacitor shell) locked to Klorn-only tools, with voice input that turns speech into a confirm-card calendar save on both platforms.

**Architecture:** A new `/api/chat/conversations` Fastify plugin runs a bounded LLM tool loop over a hard CHAT_TOOLS whitelist (create_event intercepted into an `eventDraft`, never executed); the web gets a `/chat` page + nav entries and a platform-branching `useSpeechInput` hook; `/calendar` gains a mic that prefills the existing NewEventModal via a new `parse-event` endpoint; the mobile shell adds the speech-recognition plugin + permissions.

**Tech Stack:** Fastify 5, Prisma 6 (existing Conversation/Message models — no migration), OpenAI-compatible `createCompletion` (`useUserModel: true`), Next.js 15 + TanStack Query, `@capacitor-community/speech-recognition`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-06-chat-voice-calendar-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/api/src/gmail.ts` | Modify | `listEmails` optional Gmail `q` search + tool param |
| `packages/api/src/chat-engine.ts` | Create | CHAT_TOOLS whitelist + `runChatTurn` bounded loop + eventDraft interception + chat system prompt |
| `packages/api/src/routes/chat-conversations.ts` | Create | conversation CRUD + POST message turn (requireAppAccess, userId-scoped) |
| `packages/api/src/index.ts` | Modify | register new plugin under `/api/chat` |
| `packages/api/src/event-parse.ts` | Create | `parseEventText` — NL → {title,startTime,endTime,location?} via LLM |
| `packages/api/src/routes/calendar.ts` | Modify | `POST /parse-event` (requireAppAccess; before the requireEntitled hook applies — needs its own scope) |
| `packages/web/src/components/nav-icons.tsx` | Modify | add `chat` icon |
| `packages/web/src/components/sidebar.tsx` | Modify | add Assistant nav item |
| `packages/web/src/components/bottom-tabs.tsx` | Modify | add Assistant tab, grid-cols-6 |
| `packages/web/src/lib/use-speech-input.ts` | Create | STT hook: Web Speech vs Capacitor plugin branch |
| `packages/web/src/components/voice-button.tsx` | Modify | consume hook (UI unchanged) |
| `packages/web/src/app/chat/page.tsx` | Create | chat page (thread + input + mic) |
| `packages/web/src/components/event-draft-card.tsx` | Create | confirm card → POST /api/calendar |
| `packages/web/src/components/new-event-modal.tsx` | Modify | optional `initial` prefill prop |
| `packages/web/src/app/calendar/page.tsx` | Modify | mic button → parse-event → prefilled modal |
| `packages/web/package.json` | Modify | add `@capacitor-community/speech-recognition` (dynamic import) |
| `apps/mobile/package.json` | Modify | add plugin |
| `apps/mobile/ios/App/App/Info.plist` | Modify | mic + speech usage strings |
| `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy` | Modify | audio/on-device statement |
| `apps/mobile/android/app/src/main/AndroidManifest.xml` | Modify | RECORD_AUDIO |

Tests: `packages/api/src/__tests__/chat-engine.test.ts`, `__tests__/routes-chat-conversations.test.ts`, `__tests__/event-parse.test.ts`, extend `__tests__/routes-calendar.test.ts` (or nearest existing calendar route test file), gmail search param in existing gmail test file.

---

### Task 1: `list_emails` optional search query

**Files:** Modify `packages/api/src/gmail.ts:823` (listEmails) + tool def `:1671`; Test: existing gmail test file.

- [ ] Write failing test: `listEmails(userId, 10, "from:kim")` passes `q: "from:kim"` to `gmail.users.messages.list` (mock googleapis as the file's existing tests do).
- [ ] Run: `pnpm --filter @klorn/api exec vitest run src/__tests__/<gmail test file> -t "search"` → FAIL.
- [ ] Implement: `listEmails(userId: string, maxResults = 10, query?: string)` — spread `...(query ? { q: query } : {})` into the `messages.list` params. Add tool param `query: { type: "string", description: "Optional Gmail search query (e.g. from:, subject:, newer_than:7d)" }` to the `list_emails` tool def; thread `args.query` in tool-executor's `list_emails` case.
- [ ] Run test → PASS. Commit: `feat(gmail): optional search query on list_emails`.

### Task 2: chat engine (whitelist + bounded loop + eventDraft)

**Files:** Create `packages/api/src/chat-engine.ts`; Test: `packages/api/src/__tests__/chat-engine.test.ts` (mock `./openai.js` createCompletion + `./tool-executor.js` executeToolCall, pattern from existing autonomous-agent tests).

Public surface:

```ts
export const CHAT_TOOL_NAMES: ReadonlySet<string>; // list_emails, read_email, classify_emails, list_events, check_calendar_conflicts, get_current_time, generate_briefing, create_event
export interface EventDraft { title: string; startTime: string; endTime: string; location?: string }
export interface ChatTurnResult { reply: string; eventDraft: EventDraft | null; error?: string }
export async function runChatTurn(opts: {
  userId: string;
  history: { role: "user" | "assistant"; content: string }[];
  userText: string;
}): Promise<ChatTurnResult>
```

Behavior (all TDD'd):
1. Tools passed to `createCompletion` = `ALL_TOOLS ∩ CHAT_TOOL_NAMES` (+ TIME_TOOL). Loop max 3 rounds / max 6 tool calls.
2. Any tool_call name ∉ CHAT_TOOL_NAMES → tool message `"Tool not available in chat."`, **executeToolCall never called** (fail-closed even if the model hallucinates `send_email`).
3. `create_event` call → intercepted: args validated (title/start_time/end_time ISO), returned as `eventDraft`, loop gets tool result `"Draft shown to user for confirmation."` — `executeToolCall` never called for it.
4. Other whitelisted calls → `executeToolCall(userId, name, args)`.
5. `createCompletion` options: `{ userId, priority: "foreground", credentials, useUserModel: true }` with credentials from `getLlmCredentials` (same as autonomous-agent).
6. LLM throw → `{ reply: honest error message, eventDraft: null, error: message }` + `console.error` + `captureError` (both).
7. System prompt: Klorn-data-only scope (mail/calendar/briefing), refuse coding/web-search/translation/general-knowledge in the user's language, Korean AM/PM disambiguation rules (adapted from `autonomous-agent.ts:388-405`, anchored on get_current_time instead of email received time).

- [ ] Write failing tests (min): whitelist filters tools handed to LLM; `send_email` tool_call refused fail-closed; `create_event` intercepted to eventDraft + not executed; loop stops at 3 rounds; LLM error → error result not throw.
- [ ] Run → FAIL. Implement `chat-engine.ts` (~150 lines). Run → PASS.
- [ ] Commit: `feat(chat): Klorn-scoped chat engine with fail-closed tool whitelist`.

### Task 3: conversation routes

**Files:** Create `packages/api/src/routes/chat-conversations.ts`; Modify `packages/api/src/index.ts:147` area (`await app.register(chatConversationRoutes, { prefix: "/api/chat" })`); Test: `__tests__/routes-chat-conversations.test.ts` (Fastify inject pattern from existing route tests, mock chat-engine).

```ts
export async function chatConversationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireAppAccess);
  app.get("/conversations", ...);                    // where: { userId, source: "chat" }, orderBy updatedAt desc, take 30
  app.post("/conversations", ...);                   // create { userId, source: "chat", title: null }
  app.get("/conversations/:id/messages", ...);       // findFirst({ id, userId }) else 404; messages asc, take 100
  app.post("/conversations/:id/messages", ...);      // body { text: string (1..4000) }
}
```

POST turn: ownership check → persist user Message (`metadata: { source: "chat" }`) → load last 20 messages as history → `runChatTurn` → persist assistant Message (`metadata: { source: "chat", eventDraft }`) → touch conversation.updatedAt, set title from first user text (slice 60) if null → reply `{ message, eventDraft }`.

- [ ] Failing tests: 404 on other-user conversation (IDOR); free-tier user passes (requireAppAccess not requireEntitled); text validation 400; happy path persists 2 messages + returns eventDraft; engine error still 200 with error field.
- [ ] Run → FAIL → implement → PASS.
- [ ] Commit: `feat(api): /api/chat conversation + message turn endpoints`.

### Task 4: parse-event

**Files:** Create `packages/api/src/event-parse.ts`; Modify `packages/api/src/routes/calendar.ts` (separate scope: the existing plugin adds `requireAppAccess` at `:27` then `requireEntitled` per-route on POST `/` — add `app.post("/parse-event")` with only the plugin-level requireAppAccess); Tests: `__tests__/event-parse.test.ts`.

```ts
export interface ParsedEvent { title: string; startTime: string; endTime: string; location?: string }
export async function parseEventText(userId: string, text: string, now?: Date): Promise<ParsedEvent | null>
```

- Prompt: now-anchored (inject current KST datetime), Korean AM/PM rules, JSON-only response parsed via the shared `parseLlmJson` helper (repo standard since #541); default duration 1h when no end given; return null when the model reports unparseable.
- Route: body `{ text: string (1..500) }` → 200 `{ event }` or 200 `{ event: null }`; LLM failure → 502 with logged error (console + captureError).
- [ ] Failing tests: "내일 3시 김대표 미팅" with mocked LLM JSON → ISO KST start/end (+1h default); explicit 오전 handled; garbage → null; LLM throw → null-safe route 502.
- [ ] Run → FAIL → implement → PASS.
- [ ] Commit: `feat(calendar): parse-event NL structuring endpoint`.

### Task 5: web nav (icon + entries)

**Files:** Modify `nav-icons.tsx` (add `"chat"` to NavIconType + a message-square SVG path consistent with existing 24×24 stroke icons), `sidebar.tsx:13-18` (add `{ href: "/chat", label: "Assistant", icon: "chat" }` after Briefing), `bottom-tabs.tsx:15-20` (same entry) + `:51` `grid-cols-5` → `grid-cols-6`.

- [ ] Implement all three; `pnpm --filter @klorn/web exec tsc --noEmit` green.
- [ ] Commit: `feat(web): Assistant nav entry (sidebar + bottom tabs)`.

### Task 6: useSpeechInput hook + VoiceButton refactor

**Files:** Create `packages/web/src/lib/use-speech-input.ts`; Modify `voice-button.tsx` to consume it; Modify `packages/web/package.json` (add `@capacitor-community/speech-recognition`).

```ts
export function useSpeechInput(onTranscript: (text: string) => void): {
  supported: boolean; listening: boolean; toggle: () => void;
}
```

- Native branch (`nativePlatform()` from `lib/native/capacitor`): dynamic `await import("@capacitor-community/speech-recognition")`; `available()` → `requestPermissions()` → `start({ language: ko|en, partialResults: false, popup: false })`; listen for `listeningState`/results events; errors → `console.error` + stop listening (mic stays visible but idle; permission denied → `supported: false`).
- Web branch: exact logic lifted from current `voice-button.tsx:33-77`.
- VoiceButton keeps its exact markup/props; body becomes the hook call.
- [ ] Implement; web tsc green (plugin import is dynamic — no SSR breakage).
- [ ] Commit: `feat(web): platform-branching speech input hook`.

### Task 7: /chat page + EventDraftCard

**Files:** Create `packages/web/src/app/chat/page.tsx`, `packages/web/src/components/event-draft-card.tsx`.

- Page: client component inside the existing AppShell layout; TanStack Query keys `["chat","conversations"]` / `["chat","messages",id]`; auto-create conversation on first send; thread bubbles (user right/assistant left, stone palette, `whitespace-pre-wrap`); input bar fixed above bottom tabs (`pb-safe`), 44px targets, send button + `<VoiceButton onTranscript={t => setInput(prev => prev ? prev+" "+t : t)} />`; optimistic user message; loading dots while turn pending; error string rendered as assistant bubble.
- EventDraftCard (rendered when a message's `eventDraft` metadata present): title, `Intl.DateTimeFormat` ko-safe date/time range, location; Save → `POST /api/calendar` `{ title, startTime, endTime, location }` (authHeaders pattern from `lib/api`); 402/403 → render existing soft-upsell copy/link (match paywall-screen pattern); success → green "Saved" state + invalidate `["calendar"]` queries; failure → inline error, button re-enabled.
- [ ] Implement; web build green (`pnpm --filter @klorn/web build`).
- [ ] Commit: `feat(web): /chat assistant page with event confirm card`.

### Task 8: calendar mic → prefilled modal

**Files:** Modify `new-event-modal.tsx` (add optional `initial?: { title?: string; date?: string; startTime?: string; endTime?: string; location?: string }` — the open-effect at `:69-80` seeds from `initial` when provided, else current defaults), `app/calendar/page.tsx` (header mic: `VoiceButton` next to New event at `:363` wiring; transcript → `POST /api/calendar/parse-event` → map ISO → date/time fields → open modal prefilled; parse null/error → open empty modal so speech is never a dead end).

- [ ] Implement; web tsc + build green.
- [ ] Commit: `feat(web): voice-prefilled New event on /calendar`.

### Task 9: mobile shell (plugin + permissions)

**Files:** Modify `apps/mobile/package.json` (add `@capacitor-community/speech-recognition@^8`), `apps/mobile/ios/App/App/Info.plist` (`NSMicrophoneUsageDescription` = "Klorn uses the microphone to let you dictate messages and calendar events.", `NSSpeechRecognitionUsageDescription` = "Klorn converts your speech to text on-device to create events and messages."), `PrivacyInfo.xcprivacy` (audio data: collected=false rationale — speech handled by OS APIs, not transmitted by the app), `AndroidManifest.xml` (`<uses-permission android:name="android.permission.RECORD_AUDIO" />`).

- [ ] `pnpm install` at root; run `npx cap sync` in `apps/mobile` if CLI available (else note for founder).
- [ ] Commit: `feat(mobile): speech-recognition plugin + mic permissions`.

### Task 10: quality gate + reviews

- [ ] `pnpm --filter @klorn/api exec vitest run` — full suite green (was 1941).
- [ ] `pnpm exec biome check --diagnostic-level=error packages/` green.
- [ ] `tsc --noEmit` for api + core + web green; `pnpm -r build` green.
- [ ] Reviewer agents: security-reviewer (new surface: chat routes, parse-event, mic permissions — CASA Tier 2), typescript-reviewer, silent-failure-hunter. Fix findings, re-run gate.
- [ ] Final commit; founder opens the PR (workflow rule).

---

## Self-review

- Spec coverage: every spec section maps to a task (lockdown → T2; free/Pro gates → T3/T7; both mics → T7/T8; mobile → T9; error handling → T2/T4/T6/T7; tests → per-task + T10). ✓
- No placeholders: signatures + behaviors specified; code detail lives with the executor who has the verified file context in-session. ✓
- Type consistency: `EventDraft`/`ParsedEvent` shapes align with `POST /api/calendar` payload (`title,startTime,endTime,location`). ✓

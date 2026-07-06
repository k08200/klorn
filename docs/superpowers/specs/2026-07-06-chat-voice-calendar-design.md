# Chat UI Rebuild + Voice → Calendar — Design Spec

Date: 2026-07-06 · Status: approved by founder (design conversation)
Branch: `feat/chat-voice-calendar`

## Goal

1. Rebuild the user-facing chat surface (deleted in #424/#427) on **web and the
   Capacitor mobile shell**, scoped STRICTLY to Klorn features: mail
   analysis/search, calendar read, briefing. No web search, no coding, no
   general-assistant capability — refused at both the tool layer and the prompt
   layer.
2. Voice input on both platforms; speaking "내일 3시 김대표 미팅" produces a
   **confirm card** (title/start/end/location) that saves to Google Calendar
   with one tap.

## Founder decisions (locked)

- **Confirm card before save** — the LLM never writes to the calendar directly
  from chat; the user confirms a parsed draft, then the existing deterministic
  `POST /api/calendar` performs the write.
- **Chat is free-tier accessible; writes stay Pro** — chat entry uses
  `requireAppAccess` (soft upsell model); the calendar save keeps the existing
  `requireEntitled` / `calendar_write` gate. Free LLM cost remains bounded by
  `FREE_DAILY_COST_CAP_CENTS` via the existing `createCompletion` quota path.
- **Mic in both places** — chat input bar and `/calendar` header.

## Verified foundation (file:line, checked 2026-07-06 on main)

- `Conversation` / `Message` / `ConversationSummary` Prisma models still exist
  (`schema.prisma:136,153,642`); `Message.metadata` already documents a
  `source: "chat"` shape. **Reused as-is — no migration needed.**
- `createCompletion(params, { userId, priority, credentials, useUserModel })`
  (`openai.ts:100-107,303`) — `useUserModel: true` applies the user-selected
  frontier chat model (#726) exactly on this conversational surface.
- Shared `executeToolCall` (`tool-executor.ts:150`) with fail-closed
  `REMOVED_EXTERNAL_TOOLS` guard (`tool-executor.ts:65`) and plan gating
  (`isToolAllowedForPlan`).
- Korean AM/PM disambiguation prompt rules exist in
  `autonomous-agent.ts:388-405` — reused for parse-event.
- `POST /api/calendar` (`routes/calendar.ts:78`, `requireEntitled`) → Google
  `events.insert` (`calendar.ts:91`) + local mirror + attention upsert.
- `VoiceButton` (`voice-button.tsx`) — working Web Speech impl, currently
  orphaned; returns `null` when unsupported (i.e. invisible in Capacitor
  WebView — native STT plugin required).
- Native plugin pattern: `nativePlatform()` guard + dynamic
  `await import("@capacitor/…")` (`lib/native/native-push.ts`); plugin JS dep
  in `packages/web`, native dep in `apps/mobile`.
- `/api/chat` prefix already registered (`index.ts:147` →
  `chat-pending-actions.ts`); new conversation routes register under the same
  prefix from a new file.
- `list_emails` has **no search param** (`gmail.ts:1671`) — chat's "find mail"
  use case needs an optional Gmail `query` (`q`) param added (read-only).
- Bottom tabs `grid-cols-5` (4 tabs + Account, `bottom-tabs.tsx:15-20,51`);
  sidebar `NAV_ITEMS` (`sidebar.tsx:13-18`); `NavIconType` lacks a chat icon.

## Architecture

### 1. API — chat turn (new `packages/api/src/routes/chat-conversations.ts`)

- `GET /api/chat/conversations` — list user conversations (source="chat").
- `POST /api/chat/conversations` — create conversation.
- `GET /api/chat/conversations/:id/messages` — history (ownership-checked).
- `POST /api/chat/conversations/:id/messages` — one turn:
  1. Validate + persist user `Message`.
  2. Run a bounded tool loop (max 3 LLM rounds / 6 tool calls) via
     `createCompletion(..., { useUserModel: true, priority: "foreground" })`.
  3. Tools = **CHAT_TOOLS whitelist only** (below). Any tool name outside the
     whitelist is refused fail-closed before reaching `executeToolCall`
     (defense in depth on top of #726's guard).
  4. `create_event` is NOT executed: the chat loop intercepts it and returns a
     structured `eventDraft` `{title,startTime,endTime,location?}` in the
     response + persisted in assistant `Message.metadata`. No calendar write
     happens on this route.
  5. Persist assistant `Message`, track token usage.
- Gate: `requireAppAccess` (free included). All handlers scope queries by
  `userId` (IDOR-safe, same pattern as #714 inbox scoping).

**CHAT_TOOLS whitelist (complete):** `list_emails` (+new optional `query`),
`read_email`, `classify_emails`, `list_events`, `check_calendar_conflicts`,
`get_current_time`, briefing read tools, and the intercepted `create_event`
(draft-only). Explicitly excluded: `send_email`, `mark_read`, `delete_event`,
memory/skill tools, utilities, and every removed external tool.

**Scope lockdown, layer 2 (prompt):** chat system prompt declares the
assistant works ONLY on the user's Klorn data (mail, calendar, briefing) and
must politely refuse coding, web search, translation, general knowledge, and
any off-domain request — in the user's language. Includes the Korean AM/PM
rules for event drafting.

### 2. API — parse-event (new endpoint in `routes/calendar.ts`)

- `POST /api/calendar/parse-event` `{ text }` → LLM structuring →
  `{ title, startTime, endTime, location? } | { error: "unparseable" }`.
  Uses `get_current_time`-style now-anchoring + the AM/PM rules. No write.
- Gate: `requireAppAccess` (parsing is read-side; the save stays Pro-gated).

### 3. Web — `/chat` page + nav

- New `packages/web/src/app/chat/page.tsx`: conversation list (drawer/side),
  message thread, input bar with send + mic. TanStack Query, existing app
  visual language (stone palette, focus-ring, 44px touch targets, WCAG AA).
- `EventDraftCard` component: renders `eventDraft` (title/date/time/location)
  with **Save** → `POST /api/calendar`; on 402/403 paywall response, show the
  existing soft-upsell nudge. Saved/failed state is written back into the
  message metadata via a small PATCH (or local state + refetch).
- Nav: sidebar `NAV_ITEMS` + bottom `TABS` get `{ href: "/chat", label:
  "Assistant", icon: "chat" }`; bottom bar becomes `grid-cols-6`; new `chat`
  entry in `nav-icons.tsx`.

### 4. Voice — `useSpeechInput` hook (new `packages/web/src/lib/use-speech-input.ts`)

- Branch: `nativePlatform()` → dynamic import
  `@capacitor-community/speech-recognition` (permission request, ko/en locale,
  partial results off); else Web Speech API (logic lifted from
  `voice-button.tsx`). Returns `{ supported, listening, toggle }` +
  `onTranscript` callback.
- `VoiceButton` refactored to consume the hook (UI unchanged) — mounted in the
  chat input bar and `/calendar` header.
- `/calendar` mic flow: transcript → `POST /api/calendar/parse-event` →
  **prefill and open the existing `NewEventModal`** (the modal IS the confirm
  card) → user taps Create → existing save path.

### 5. Mobile shell

- `apps/mobile`: add `@capacitor-community/speech-recognition`; `cap sync`.
- iOS `Info.plist`: `NSMicrophoneUsageDescription` +
  `NSSpeechRecognitionUsageDescription`; update `PrivacyInfo.xcprivacy`
  (audio data collection = none/on-device processing statement).
- Android `AndroidManifest.xml`: `RECORD_AUDIO` permission.
- `packages/web`: add the plugin JS dep (dynamic import only — web bundle
  unaffected).

## Error handling

- LLM failure mid-turn → assistant message with an honest error string,
  logged via `console.error` + `captureError` (both, per repo rule), HTTP 200
  with `error` field so the thread stays usable.
- Tool loop cap reached → return partial answer, never hang.
- Parse-event unparseable → explicit `unparseable` response; calendar mic
  falls back to opening an empty `NewEventModal`.
- STT permission denied / unsupported → mic hidden or disabled with tooltip;
  typing always works (voice is progressive enhancement).

## Testing

- TDD (vitest): chat route — whitelist fail-closed (asserts `send_email` &
  off-list names refused), ownership/IDOR, free-tier access, eventDraft
  interception, tool-loop bound, error paths. parse-event — Korean relative
  dates ("내일 3시" → correct KST ISO, AM/PM rules), unparseable input.
  `list_emails` query param.
- Web `tsc` + build green (CI gate from #730); full api suite (1941) green.
- Reviews: security-reviewer (new surface, CASA Tier 2) + typescript-reviewer
  + silent-failure-hunter before PR.

## Out of scope (v1)

- Sending/replying to email from chat (`send_email` stays excluded).
- Voice output (TTS), streaming responses, conversation search/pinning UI.
- Editing the draft inside the chat card beyond save/dismiss (the /calendar
  modal path covers manual editing).

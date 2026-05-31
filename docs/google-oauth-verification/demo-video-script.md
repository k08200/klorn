# Demo Video Script — OAuth verification

**Goal:** prove to the reviewer that (1) the full OAuth grant flow works, and
(2) **each requested scope** is used by a real, visible feature. Most demo
rejections are: inaccessible link, consent screen not in English, scopes shown
≠ scopes requested, or a scope's usage not demonstrated.

## Pre-record checklist
- [ ] Set the Google consent screen language to **English** (toggle bottom-left).
- [ ] App name + logo on screen match the consent screen and homepage exactly.
- [ ] Use a clean test account with a few representative emails + a calendar event.
- [ ] Record at readable resolution; add **voice or on-screen captions** naming
      each requirement as you show it (Google says this speeds review).
- [ ] Upload **unlisted to YouTube** (or a reviewer-accessible link).
- [ ] If recording the login flow, cover **both** OAuth paths (login bundle and,
      if split per Issue B, the connect flow) or pick the one that's live.

## Script (≈2–3 min)

**1. Intro (10s)**
> "This is Klorn at app.klorn.ai, a decision assistant that reads Gmail and
> Calendar to help users triage work. I'll show the OAuth consent flow and how
> each scope is used."
- Show the homepage briefly (name + logo visible).

**2. OAuth grant flow — show the full consent screen (30s)**
- Click connect / sign in with Google.
- **Stop on the consent screen and let it sit.** Read the scopes aloud:
  > "Klorn requests Gmail read, Gmail modify and send, and Calendar events."
- Make sure the on-screen scopes are **exactly** the requested set — no more.
- Click **Allow** and land back in the app authenticated/connected.

**3. Demonstrate `gmail.readonly` (30s)**
- Open the inbox / briefing.
> "Klorn read these emails to classify priority and detect which need a reply,
> and generated this morning briefing." — point at summaries / reply-needed tags.

**4. Demonstrate `gmail.modify` (30s)**
- Tap star / mark-read / archive on a message; show the state change.
> "These label and archive changes use gmail.modify, triggered by the user."
- Open a draft, click Approve → show it send.
> "A reply is only sent after the user approves the draft." (covers send/modify)

**5. Demonstrate `calendar.events` (20s)**
- Show upcoming meetings in the briefing / a commitment linked to an event.
> "Klorn reads calendar events to surface meetings and link deadlines. Any
> event edit requires user approval."

**6. Close (10s)**
> "That's every requested scope used by a real feature. Data handling follows
> the Limited Use policy described in our privacy policy at app.klorn.ai/privacy."

## After recording
- [ ] Re-watch: is every requested scope visibly exercised? Any extra scope on
      the consent screen that you don't demo? (Remove unused scopes.)
- [ ] Paste the video link into the verification submission.

# OAuth verification demo video — shot-by-shot script

Target: **~3 minutes**, one take, no editing needed. Upload **Unlisted** to
YouTube and paste the link into the OAuth verification form.

## Prep (before recording)

- [ ] Use the dogfood Google account (`k0820086@gmail.com`) with a realistic
      inbox: a few unread mails, at least one that deserves a reply, one
      meeting/invite mail.
- [ ] Record the **desktop browser** (Chrome) — easier to show Gmail/Calendar
      side effects than the phone. Keep the **URL bar visible at all times**
      (reviewers match the domain `app.klorn.ai`).
- [ ] Open three tabs: ① `app.klorn.ai` (logged **out**), ② Gmail, ③ Google
      Calendar.
- [ ] Narrate in simple English, or record silently and add English captions —
      both are accepted. Lines below are ready to read.
- [ ] The "Google hasn't verified this app" warning is EXPECTED before
      verification — click *Advanced → Continue* on camera; do not cut it out.

---

## Scene 0 — App identity (0:00–0:15)

**Screen:** `app.klorn.ai` login page (logged out).

> "This is Klorn, an AI email firewall. It classifies incoming Gmail into four
> attention tiers and only notifies the user about mail that actually matters.
> I'll demonstrate every OAuth scope we request."

## Scene 1 — OAuth consent screen (0:15–0:45) ★ mandatory

**Screen:** click **Continue with Google** → account picker → consent screen.
**Action:** scroll **slowly** through the full permission list so every scope
is readable on camera. If the unverified-app warning appears, click through it
on camera.

> "Klorn requests Gmail read, modify, and send, plus Calendar events and
> read-only calendar access. I'll show each permission in use."

## Scene 2 — `gmail.readonly` (0:45–1:20)

**Screen:** the mail/firewall view right after sign-in: the inbox classified
into tiers. Open one email; point at the AI summary and the reply-needed
signal.

> "Klorn reads message content to classify each email — interrupt now, review
> later, silence, or auto-handle — and to generate this summary. Metadata
> alone cannot power this classification; that is why we need gmail.readonly."

## Scene 3 — `gmail.modify` (1:20–1:45)

**Screen:** in Klorn, archive (or mark read) one message → switch to the
**Gmail tab** → show the same message is now archived/read there.

> "When the user triages a message in Klorn, we apply that decision in Gmail —
> marking it read or archiving it. That is gmail.modify. Klorn never
> permanently deletes mail."

## Scene 4 — `gmail.send` (1:45–2:15)

**Screen:** open a mail that needs a reply → **Draft reply** → edit briefly →
**Approve & send** → switch to the **Gmail Sent** folder → show the sent
message.

> "Klorn drafts a reply. The user reviews and approves it, and only then does
> Klorn send it from the user's own account — that is gmail.send."

## Scene 5 — `calendar.events` (+ `calendar.readonly`) (2:15–2:40)

**Screen:** Klorn's calendar/briefing surface showing today's meetings → create
an event from an email (or show a conflict warning when scheduling) → switch to
the **Google Calendar tab** → show the created event.

> "Klorn reads the user's calendar to prepare meeting briefings and detect
> conflicts, and creates the events the user confirms — calendar.events and
> read-only calendar access."

## Scene 6 — Revoke & deletion (2:40–3:00)

**Screen:** Settings → the connected Google account → **Disconnect**. Then show
`klorn.ai/privacy` briefly (scroll to the Limited Use section).

> "The user can disconnect Google at any time — Klorn deletes its tokens — and
> can also revoke access at myaccount.google.com. Our privacy policy documents
> Limited Use compliance, retention, and deletion."

---

## Don'ts

- Don't cut/splice the consent screen — reviewers want the uninterrupted grant.
- Don't blur the URL bar or the scope list.
- Don't show unrelated accounts' mail (use the dogfood inbox).
- Don't exceed ~5 minutes; 3 is ideal.

# Scope Justification — submission text

Paste each block into the OAuth consent screen scope justification field. Each
maps the scope to a **specific user-facing feature** and explains **why a
narrower scope is insufficient** (Google enforces minimum-scope and will ask you
to downscope if the gap isn't defended).

> Keep this text, the privacy policy, and the demo video **consistent**. If you
> change a feature, update all three.

---

## `gmail.readonly` — RESTRICTED

> Klorn is a decision assistant for busy professionals. We use `gmail.readonly`
> to read message headers and bodies so we can (1) classify each email's
> priority and detect which messages need a reply, (2) extract commitments and
> deadlines mentioned in email, and (3) generate a morning briefing summarizing
> what needs the user's attention. The user sees these results directly in the
> Klorn inbox, briefing, and task views.
>
> A narrower scope is insufficient: `gmail.metadata` returns only headers and
> labels, not message bodies, so it cannot support reply-needed detection,
> commitment extraction, or summarization — all of which require reading body
> content. We therefore request the minimum scope that exposes message bodies
> for reading only.

## `gmail.modify` — RESTRICTED

> We use `gmail.modify` for two user-initiated actions: (1) toggling message
> state — mark as read/unread, star/unstar, archive — when the user taps those
> controls in Klorn, and (2) sending a reply, but only after the user
> explicitly reviews and approves a draft. Klorn never modifies or sends mail
> autonomously; every write is triggered by an on-screen user action.
>
> A narrower scope is insufficient: `gmail.readonly` cannot change labels or
> send, and `gmail.send` covers sending but not the label/read/archive state
> changes the user performs. `gmail.modify` is the single scope that covers the
> exact set of user-approved write actions Klorn offers, without granting full
> mailbox permission (`https://mail.google.com/`), which we deliberately avoid.

## `calendar.events` — SENSITIVE
> *(After applying Issue A fix — see README. If full `calendar` is still in code
> at submission time, this justification will be rejected as over-broad.)*

> We use `calendar.events` to read the user's upcoming events so Klorn can
> surface meetings in the morning briefing, link email-derived commitments to
> their due dates, and prepare meeting context. Event edits (create/update) are
> only performed after explicit user approval of a proposed action.
>
> A narrower scope is insufficient: `calendar.events.readonly` would block the
> user-approved create/edit actions. We request `calendar.events` rather than
> the broader `calendar` scope because we never need to manage calendars
> themselves, sharing, or ACLs — only the events within them.

## `gmail.send` — SENSITIVE

> Used to deliver a reply only after the user approves a specific draft in
> Klorn. No autonomous or bulk sending.

## `openid`, `userinfo.email`, `userinfo.profile` — Non-sensitive

> Sign-in and account identification only.

---

### Limited Use statement (reuse where a data-handling explanation is asked)

> Klorn's use and transfer of information received from Google APIs adheres to
> the Google API Services User Data Policy, including the Limited Use
> requirements. Google user data is used solely to provide and improve
> user-facing features, is never sold, never used for advertising, and never
> read by humans except with the user's affirmative consent, for security, to
> comply with law, or in aggregated/de-identified form for internal operations.

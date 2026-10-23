# Klorn editions

Klorn is open source under AGPLv3. The same firewall, classifier,
hash-binding, and floor enforcement that run in production run on a
self-host. Nothing in the core is feature-gated.

The line we draw is **operational, not behavioural**. Cloud pays for
running it; the bytes you trust are the same either way.

| Capability | Open Source (AGPLv3) | Klorn Cloud |
|---|:---:|:---:|
| Attention firewall classifier (SILENT / QUEUE / PUSH / AUTO) | ✅ | ✅ |
| Content-hash binding ([PR #468](https://github.com/k08200/klorn/pull/468)) | ✅ | ✅ |
| Deterministic action floor ([PR #480](https://github.com/k08200/klorn/pull/480), [#481](https://github.com/k08200/klorn/pull/481)) | ✅ | ✅ |
| Calibration CLI (Day 14+7 retention measurement) | ✅ | ✅ |
| Self-host on your Postgres + your infra | ✅ | — |
| Bring-your-own LLM key (OpenRouter, Gemini, ...) | ✅ | ✅ |
| Managed hosting + uptime SLA | — | ✅ |
| Google-verified Gmail OAuth scope (no consent warning) | — | ✅ |
| Team / multi-account workspaces | — | ✅ (roadmap) |
| Priority support, incident response | — | ✅ |

## What "operational, not behavioural" means

If you self-host, you get the same classifier, the same input-hash
binding, the same receipt enforcement on `send_email`. The two
codebases don't diverge.

What you do NOT get on self-host:
- Google CASA-verified Gmail scope (you'll see the unverified-app warning
  during OAuth until you submit your own clone for verification)
- Managed Postgres, uptime, observability
- Team-mode collaboration surfaces (not yet shipped on Cloud either —
  this is the roadmap line, not a behind-paywall feature today)

## Cloud access (today)

Sign in with Google at [klorn.ai](https://klorn.ai). The OAuth screen is
in **production**, so there is no test-user list, no approval step, and
nobody to email first.

The cap is the real constraint: Klorn uses Gmail's restricted
`gmail.modify` scope, and until CASA Tier 2 verification lands the app
is limited to **100 lifetime accounts**, first-come. Verification
removes the cap; it does not change how you sign in.

Support: `k0820086@gmail.com`.

Self-host bypasses this gate entirely. You bring your own OAuth client
ID/secret, register them in your own Cloud Console, and the verification
question is between you and Google.

## Pure AGPLv3 — no additional terms

Klorn is AGPL-3.0 and nothing else. No commercial-use restriction, no
employee-count clause, no "contact us for an enterprise licence" gate.
The `LICENSE` file is the unmodified GNU AGPL v3, and GitHub resolves it
as `AGPL-3.0` rather than `NOASSERTION`.

That is worth stating because it is not the norm in this category. The
nearest open-source AI email tool, [Inbox Zero], ships AGPL v3 with
`ADDITIONAL TERMS` appended: a `COMMERCIAL MONETIZATION RESTRICTION`,
and an `ENTERPRISE USE LIMITATION` requiring organisations with five or
more people to buy a separate licence. Read both licences and compare —
that is the whole argument.

[Inbox Zero]: https://github.com/elie222/inbox-zero/blob/main/LICENSE

### Why AGPL and not MIT

The moat is the doctrine + the implementation discipline, not the
license. AGPL is here so a hosted fork can't strip the source and
re-sell the firewall as a closed SaaS without contributing back.

If you self-host for yourself, AGPL doesn't change anything you do.
If you run a modified Klorn as a service to other users, you owe
those users the source under AGPL §13. That's the line.

Commercial license available for organizations that need to host a
modified Klorn behind a non-AGPL contract — typically: managed Gmail
verification, vendor-supported deployments, or proprietary team
features. Contact: k0820086@gmail.com.

## What's NOT on the boundary

These are not in this table because they're not differentiators:

- **Web UI** — same on both. The Next.js app is in the repo.
- **API surface** — same on both. Same Fastify routes.
- **Schema** — same Prisma schema. Same migrations.
- **Doctrine** — same. Cloud cannot violate the floor without violating
  the open source you also run.

The cloud version is the open source plus three things: someone else
runs it, the OAuth scope is verified, and there's a support contract.
That's the entire commercial proposition.

## Roadmap visibility

This file moves with the product. If a capability promoted from "Cloud
roadmap" to "shipped on Cloud + open source", the row updates and the
PR that did it gets linked. If something gets pulled back, we say so.

If Klorn ever introduces a closed-source binary, a closed-source plugin
system, or a "core is open but the useful version is paid" pattern,
that's a doctrine violation and the contributors should call it out.

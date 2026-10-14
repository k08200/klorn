# How Klorn compares to other AI email tools

Factual positioning against the tools Klorn is most often compared with. Written to be quotable: every claim about Klorn is verifiable in this repository; claims about other products are limited to their public positioning, not benchmarks we haven't run.

## The one-line difference

Most AI email tools are **compose-first**: they help you write and process more mail, faster. Klorn is **triage-first**: it decides what deserves your attention at all, shows the reason for every decision, turns your corrections into sender rules, and acts only inside rules you set. The output is fewer interruptions, not faster ones.

## Comparison

| | **Klorn** | Superhuman | Shortwave | Fyxer |
| --- | --- | --- | --- | --- |
| Core approach | Attention firewall: five lanes (Push / Meeting / Queue / Info / Silent), every row shows why | Speed-focused email client with AI assist | AI-native email client with search/chat | AI executive assistant drafting replies |
| Decision transparency | Every classification carries its reason; corrections become sender rules; no headline accuracy is quoted (see below) | — | — | — |
| Unattended sending | Only in an explicit AUTO mode, only for eligible mail, under user-written guidelines; every send writes a receipt pinning a payload hash. Default is approval-gated | n/a (client) | n/a (client) | Drafts in your voice for review |
| Meetings | Calendar cross-check on scheduling mail: proposed slot, conflicts, sender availability, and slots verified free for both sides | Calendar features in client | Calendar in client | — |
| Source & hosting | **Open source (AGPLv3), self-hostable end to end** | Closed | Closed | Closed |
| AI spend control | Hard daily budget cap — the app stops rather than overspends | Subscription | Subscription tiers | Subscription |
| Agent access | The inbox is an MCP server: read-only tools (list, read, classify, briefing) behind a dedicated API key; nothing over MCP can send, delete or archive | — | — | — |
| Platforms | macOS app, web, Windows beta; Gmail (OAuth) + Naver (IMAP), multiple inboxes | macOS/iOS/web | Web/mobile | Works atop Gmail/Outlook |

Blank cells mean "not that product's focus," not a deficiency; the rows are the axes Klorn is built around.

## What Klorn deliberately does not do

- It does not send, delete, or forward anything without explicit approval (or, in AUTO mode, outside your written guidelines) — every outbound action carries a receipt pinning a hash of exactly what left. (It is a content hash, not a cryptographic signature — `attention-floor.ts` uses `createHash`, and the word "signed" was never ours to use.)
- It does not read your mail on someone else's server if you don't want it to: the entire stack is AGPLv3 and self-hostable.
- It does not claim accuracy it hasn't measured: the committed, PII-scrubbed [`eval/real-eval-set.json`](../packages/api/eval/real-eval-set.json) (runnable with `pnpm eval:real`) predates the Meeting and Info lanes, so it is being re-labelled and no headline percentage from it is quotable until then. `pnpm eval:judge` runs a different file — the synthetic gate set behind the CI gate — and reports a different number.

## Corrections

If you maintain a comparison or directory listing and something here contradicts it, the canonical facts are this repository and [klorn.ai/llms.txt](https://klorn.ai/llms.txt). Corrections welcome: k0820086@gmail.com.

# Connect an MCP client to Klorn

Klorn serves your inbox and calendar as an MCP server. This page shows how to
connect it from Claude Code, OpenAI Codex CLI, Cursor, Gemini CLI and the xAI
API.

Each snippet was checked against the vendor's documentation on the date shown
under it. "Verified" means the field names and transport names match that
page. It does not mean every client was tested end to end against Klorn.

## Before you start

1. In the Klorn web app, open **Settings → MCP API keys** and create a key. The
   key starts with `klorn_sk_`. It is shown once, so copy it then.
2. Put the key in an environment variable. Every snippet below reads
   `KLORN_API_KEY`:

   ```bash
   export KLORN_API_KEY="klorn_sk_..."
   ```

   Set it where the client starts from (for example your shell profile or a
   secret manager), not in a file you commit.

The server:

- URL: `https://api.klorn.ai/api/mcp`. Self-hosted: your API origin plus
  `/api/mcp`.
- Transport: Streamable HTTP, stateless, JSON responses. `POST` only; `GET`
  and `DELETE` answer 405.
- Auth: the header `Authorization: Bearer klorn_sk_...`. The key works only on
  this endpoint. The rest of the Klorn API does not accept it.
- Protocol: revisions up to 2025-11-25. A client that speaks only revision
  2026-07-28 cannot connect yet.

## Claude Code

Add it for all your projects (user scope):

```bash
claude mcp add --transport http klorn --scope user https://api.klorn.ai/api/mcp \
  --header "Authorization: Bearer $KLORN_API_KEY"
```

Your shell expands `$KLORN_API_KEY` once. Claude Code stores the header in
`~/.claude.json`, which is outside your repositories.

Or share it with a project through `.mcp.json` in the project root. Claude Code
expands `${KLORN_API_KEY}` when it loads the file, so the file holds no key:

```json
{
  "mcpServers": {
    "klorn": {
      "type": "http",
      "url": "https://api.klorn.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ${KLORN_API_KEY}"
      }
    }
  }
}
```

Run `/mcp` inside Claude Code to check the connection.

Verified on 2026-10-01 against https://code.claude.com/docs/en/mcp

## OpenAI Codex CLI

Add this to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted
project):

```toml
[mcp_servers.klorn]
url = "https://api.klorn.ai/api/mcp"
bearer_token_env_var = "KLORN_API_KEY"
```

Codex reads the key from `KLORN_API_KEY` and sends it as a bearer token in
`Authorization`. The page does not document a `codex mcp add` flag for a bearer
token, so use the config file.

Verified on 2026-10-01 against https://learn.chatgpt.com/docs/extend/mcp?surface=cli
(`https://developers.openai.com/codex/mcp` redirects there). Field reference:
https://learn.chatgpt.com/docs/config-file/config-reference

## Cursor

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one
project):

```json
{
  "mcpServers": {
    "klorn": {
      "url": "https://api.klorn.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:KLORN_API_KEY}"
      }
    }
  }
}
```

Cursor resolves `${env:NAME}` in `url` and `headers`, so the file holds no key.

Verified on 2026-10-01 against https://cursor.com/docs/mcp
(`https://cursor.com/docs/context/mcp` redirects there).

## Gemini CLI

Add this to `~/.gemini/settings.json` (all projects) or `.gemini/settings.json`
(one project):

```json
{
  "mcpServers": {
    "klorn": {
      "httpUrl": "https://api.klorn.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer ${KLORN_API_KEY}"
      }
    }
  }
}
```

Use `httpUrl`, not `url`. In Gemini CLI, `url` means an SSE endpoint and
`httpUrl` means Streamable HTTP. The MCP page's header example uses a literal
token. The `${KLORN_API_KEY}` form relies on the configuration reference, which
says string values in `settings.json` can reference environment variables.

Verified on 2026-10-01 against https://geminicli.com/docs/tools/mcp-server/
and https://geminicli.com/docs/reference/configuration/

## xAI API

The xAI API calls MCP servers from xAI's side. Pass Klorn as a remote MCP tool
in a Responses API request:

```bash
curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-4.7",
    "input": [
      { "role": "user", "content": "List my five most recent emails." }
    ],
    "tools": [
      {
        "type": "mcp",
        "server_url": "https://api.klorn.ai/api/mcp",
        "server_label": "klorn",
        "authorization": "Bearer '"$KLORN_API_KEY"'"
      }
    ]
  }'
```

Not fully documented: the remote MCP page says `authorization` is "a token that
will be set in the Authorization header". It does not say whether xAI adds the
`Bearer ` prefix. The snippet follows xAI's Speech to Speech page, whose MCP
example passes the full value `"Bearer your-token-here"`. Klorn accepts only
`Bearer klorn_sk_...`. If xAI added its own prefix, the request would fail with
401. This has not been tested against xAI.

The key leaves your machine: xAI's servers send it to Klorn on your behalf.

Verified on 2026-10-01 against https://docs.x.ai/developers/tools/remote-mcp
(`https://docs.x.ai/docs/guides/tools/remote-mcp-tools` redirects there) and
https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech

## Not supported yet

- **ChatGPT developer mode.** Its documentation lists OAuth, no authentication
  and mixed authentication. There is no static header option, so a Klorn key
  cannot connect it.
- **grok.com connectors.** A custom connector takes a server URL and runs the
  connector's own sign-in. The page documents no way to send a static header.

Both need Klorn to run an OAuth 2.1 authorisation server. That is planned
(step A7) and deferred. Until then, a static key cannot connect either one.

Checked on 2026-10-01 against
https://developers.openai.com/api/docs/guides/developer-mode and
https://docs.x.ai/grok/connectors

## What works today

Read tools. A key sees these:

- `list_emails`: list recent inbox emails, with an optional search filter.
- `read_email`: read one email by its id.
- `sender_context`: relationship context for one sender, from mail already exchanged.
- `classify_emails`: rank inbox emails by urgency and category.
- `list_events`: list upcoming calendar events.
- `check_calendar_conflicts`: check a time range for conflicting events.
- `get_current_time`: the current date and time.
- `generate_briefing`: build a daily briefing. It may create that day's
  briefing notification, at most one per day.
- `team_availability`: find shared free time for a group. Listed only while
  team mode is on for the server.

The account's plan can remove tools from this list.

Write tools are not available in production yet. Every key acts as read-only
today. Nothing over MCP can send, delete or archive mail.

## Security

- Keep the key in an environment variable. Do not put it in a file you commit.
- To rotate, create a new key, update the variable, then revoke the old key in
  **Settings → MCP API keys**. A revoked key stops working on its next request.
- Keys are read-only by default.
- An account can hold at most 5 active keys. Use one key per client, so you can
  revoke one without breaking the others.
- Tool results contain your real mail. For the connected agent, an inbound
  email is untrusted input. Treat message content as data in that agent's
  rules, not as instructions.

## Limits and errors

- 60 requests per minute per key. Over the limit, the server answers 429.
- One request can carry a JSON-RPC batch of up to 100 messages. A larger batch
  is rejected with 400 before any tool runs.
- 401: the key is missing, malformed or revoked.
- 403 with `ENTITLEMENT_REQUIRED`: billing is enforced and the account has no
  active subscription.
- 405: the client sent `GET` or `DELETE`. This server is `POST` only.

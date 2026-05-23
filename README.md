# @soledgic/mcp

Public MCP (Model Context Protocol) server for Soledgic's wallet-first payment
infrastructure API.

This package exposes a safe subset of the public Soledgic integration surface:

- API status checks
- user wallet upserts
- hosted wallet sessions
- wallet activity reads
- checkout creation
- refund requests
- sandbox checkout and webhook testing

It does not expose Soledgic Control, operator dashboards, privileged server routes,
internal repair workflows, tax/compliance operations, or accounting-period tools.

## Installation

Requires Node.js 20 or newer.

```bash
npm install -g @soledgic/mcp
```

For local development from this repo:

```bash
cd packages/mcp
npm install
npm run build
SOLEDGIC_API_KEY=slk_test_your_key npm start
```

## Environment

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SOLEDGIC_API_KEY` | Yes | - | Public Soledgic API key, `slk_test_*` or `slk_live_*` |
| `SOLEDGIC_BASE_URL` | No | `https://api.soledgic.com/v1` | Public API base URL |
| `SOLEDGIC_ALLOW_WRITES` | No | `false` | Enables mutating tools |
| `SOLEDGIC_ALLOWED_TOOLS` | No | all | Comma-separated tool allowlist |
| `SOLEDGIC_ACTOR` | No | `public-mcp` | Actor label written to local audit logs |

Never put live API keys directly in MCP client configuration files. Load them
through your shell, secret manager, or local machine keychain.

## Network Access

This MCP server makes HTTPS requests only when an MCP client invokes a Soledgic
tool. API requests go to the configured Soledgic API base URL.

Default:

```text
https://api.soledgic.com/v1
```

The `get_integration_guide` and `get_sdk_example` tools may return documentation
links under:

```text
https://soledgic.com/docs
```

The package does not perform background telemetry, post-install network calls,
or calls to third-party analytics endpoints. Example merchant callback URLs use
`https://example.com` placeholders only.

## Safety Model

- Read-only by default.
- Writes require `SOLEDGIC_ALLOW_WRITES=true`.
- Live writes are blocked in public V1. Use test API keys for MCP write tools.
- Mutating tools require `confirm: true`.
- Money-moving tools require stable idempotency/reference fields.
- Per-tool rate limits reduce accidental loops.
- Tool call logs are written to stderr with sensitive values redacted.

## Tools

### Read-only

| Tool | Description |
| --- | --- |
| `get_api_status` | Read Soledgic API health/status |
| `get_integration_guide` | Get docs links and short integration guidance |
| `get_sdk_example` | Get concise TypeScript examples for common flows |
| `list_wallet_activity` | List wallet ledger activity |
| `list_sandbox_events` | List recent sandbox webhook events |

### Mutating

| Tool | Description |
| --- | --- |
| `upsert_user_wallet` | Create or upsert a consumer-credit wallet |
| `create_wallet_session` | Create a hosted wallet page session |
| `create_checkout` | Create a hosted or direct checkout |
| `complete_sandbox_checkout` | Complete a sandbox checkout without processor calls |
| `fail_sandbox_checkout` | Mark a sandbox checkout as failed |
| `send_sandbox_webhook_test` | Queue a predefined sandbox webhook event |
| `request_refund` | Request a refund through Soledgic |

## Codex or Claude Configuration

Use the built binary when installed:

```json
{
  "mcpServers": {
    "soledgic": {
      "command": "soledgic-mcp",
      "env": {
        "SOLEDGIC_API_KEY": "load-this-from-your-secret-manager"
      }
    }
  }
}
```

For local development from this repo:

```json
{
  "mcpServers": {
    "soledgic": {
      "command": "node",
      "args": ["/Users/osifo/Desktop/soledgic/packages/mcp/dist/index.js"],
      "env": {
        "SOLEDGIC_API_KEY": "load-this-from-your-secret-manager"
      }
    }
  }
}
```

# momo-mcp

An MCP server for [MTN Mobile Money](https://momodeveloper.mtn.com) — the
largest mobile money network in Africa, with around 72 million active users
across 16 countries. It lets an AI assistant request payments, check account
status and track transactions.

**It is locked to MTN's sandbox unless a production country is explicitly
selected and separately acknowledged.**

Node 20+. One runtime dependency (the MCP SDK) plus zod.

## The safety model

MoMo has an unusual property worth exploiting: **two** independent environment
levers that must agree.

| | sandbox | production |
|---|---|---|
| host | `sandbox.momodeveloper.mtn.com` | `proxy.momoapi.mtn.com` |
| `X-Target-Environment` | `sandbox` | a country, e.g. `mtnghana` |

Either alone is a single point of failure. Sending the sandbox target to the
production host, or a country target to the sandbox host, is always a mistake
— and it is the kind that gets noticed afterwards.

So this server:

**1. Derives both from one setting.** You set `MOMO_TARGET_ENVIRONMENT`; the
host follows. They cannot drift apart through configuration.

**2. Re-checks coherence on every request**, not just at startup. If host and
target ever disagree, the request is refused rather than sent.

**3. Requires two opt-ins for production.** A country target *and*
`MOMO_ALLOW_PRODUCTION`. Set only the first and the server **refuses to start**
rather than silently running against the sandbox — believing you are live when
you are not is worse than not starting.

**4. Refuses an unknown target** instead of defaulting to sandbox. A typo like
`mtnnowhere` is an error, not a quiet fallback.

**5. Refuses a currency the API would ignore.** The sandbox settles only in
EUR. Setting `MOMO_CURRENCY=GHS` against it would be silently discarded by
MTN, so it is rejected here with an explanation instead.

**6. Per-call confirmation, only where it means something.** Production
payments need `confirm="CONFIRM LIVE PAYMENT"` exactly. The sandbox does not:
friction on imaginary money only teaches people to click through.

**7. An amount ceiling**, `MOMO_MAX_AMOUNT`, default 1000 in major units.

**8. Validation before the wire.** Phone numbers must be digits-only
international format, reference ids must be real UUIDs, payer-visible text is
length-bounded and single-line. MoMo rejects all of these with opaque errors;
this server rejects them with clear ones.

## Setup

Getting started needs no company and no commercial agreement:

1. Register at [momodeveloper.mtn.com](https://momodeveloper.mtn.com) and
   subscribe to **Collections**. Copy the subscription key.
2. `npm install && cp .env.example .env`, and paste that key in.
3. Start the server and call **`momo_provision_sandbox_user`** once. It creates
   a sandbox API user and key and hands both back.
4. Save them as `MOMO_API_USER` and `MOMO_API_KEY`, restart, then `npm run check`.

Step 3 is normally three hand-run curl calls with a UUID you generate yourself.
The tool does it in one.

## Tools

| Tool | Reads/writes | Notes |
|---|---|---|
| `momo_environment` | read | Target, host, limits. No network call. |
| `momo_provision_sandbox_user` | write | Sandbox only. Creates an API user and key. |
| `momo_verify_credentials` | read | Confirms the credentials mint a token. |
| `momo_account_balance` | read | Balance of the configured account. |
| `momo_check_account_active` | read | Is this number a usable MoMo account? Free. |
| `momo_request_to_pay` | **write** | Asks a subscriber to approve. Confirmation required in production. |
| `momo_payment_status` | read | PENDING, SUCCESSFUL or FAILED. |

A request to pay returns **PENDING**, not paid — the subscriber approves on
their handset. Poll `momo_payment_status` with the returned `referenceId`.

## Connecting a client

```json
{
  "mcpServers": {
    "momo": {
      "command": "npx",
      "args": ["-y", "momo-mcp"],
      "env": {
        "MOMO_SUBSCRIPTION_KEY": "...",
        "MOMO_API_USER": "...",
        "MOMO_API_KEY": "...",
        "MOMO_TARGET_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

## Tests

```
npm test
```

27 tests. Fifteen cover the guards as pure functions, including that every
production country maps to the production host and that tampered host/target
combinations are refused. Twelve spawn the real binary and speak MCP over
stdio, checking that the sandbox default holds, that a production target
refuses to start unacknowledged, that sandbox provisioning is refused in
production, and that malformed amounts, phone numbers and reference ids are
rejected before any network call.

## Status

Early. Every endpoint path was probed directly against MTN's hosts and returns
the expected unauthenticated responses, so the surface is right. But the server
has **not** been run against a real subscription key — request and response
bodies are built from MTN's documentation, not from observed traffic. Expect to
adjust field names on first contact.

Not covered yet: disbursements and remittances beyond token minting, pre-approvals,
invoices, and webhook/callback verification.

## Licence

MIT

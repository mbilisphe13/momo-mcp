#!/usr/bin/env node
/**
 * MTN Mobile Money MCP server.
 *
 * Exposes MTN MoMo (Collections, Disbursements, Remittances) as MCP tools,
 * locked to the sandbox unless a production country environment is explicitly
 * selected and acknowledged. See README.md for the safety model.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig, ConfigError, mask, CONFIRM_PHRASE } from "./config.mjs";
import { MomoClient, MomoError } from "./momo.mjs";
import {
  GuardError, checkAmount, checkLiveConfirmation, checkMsisdn,
  checkUuid, checkText, newReferenceId,
} from "./guards.mjs";

// stdout is the MCP transport; diagnostics go to stderr.
const log = (...a) => console.error("[momo-mcp]", ...a);

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    log(`Configuration error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const client = new MomoClient(config);
log(
  `starting against ${config.environment.host} [${config.environment.target}]` +
    (config.environment.real ? "  *** PRODUCTION - REAL MONEY ***" : ""),
);

const server = new McpServer({ name: "momo", version: "0.1.0" });

const ok = (d) => ({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }] });
const fail = (m) => ({ isError: true, content: [{ type: "text", text: m }] });

const handle = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof GuardError) return fail(`Refused: ${e.message}`);
    if (e instanceof MomoError) {
      return fail(`MoMo API error: ${e.message}\n${JSON.stringify(e.body ?? {}, null, 2)}`);
    }
    return fail(`Unexpected error: ${e.message}`);
  }
};

server.registerTool(
  "momo_environment",
  {
    title: "Show MoMo environment",
    description:
      "Report which MTN MoMo environment this server targets, whether it moves real " +
      "money, and the configured limits. Call this first, and always before any payment.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handle(async () => ok({
    targetEnvironment: config.environment.target,
    host: config.environment.host,
    movesRealMoney: config.environment.real,
    product: config.product,
    currency: config.currency,
    maxAmount: config.maxAmount,
    subscriptionKey: mask(config.subscriptionKey),
    apiUser: config.apiUser ? mask(config.apiUser) : "not set",
    apiKeyConfigured: Boolean(config.apiKey),
    confirmationRequiredForPayments: config.environment.real,
  })),
);

server.registerTool(
  "momo_provision_sandbox_user",
  {
    title: "Provision a sandbox API user",
    description:
      "SANDBOX ONLY. Create an API user and API key in the MoMo sandbox and return " +
      "them, so you can finish setup without hand-running three curl commands. The " +
      "values must then be saved to MOMO_API_USER and MOMO_API_KEY. Refused outright " +
      "in production, where MTN issues these credentials.",
    inputSchema: {
      providerCallbackHost: z.string().optional()
        .describe("Hostname MTN will call back, e.g. example.com. Not used in sandbox."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  handle(async (a) => {
    if (config.environment.real) {
      throw new GuardError(
        "Sandbox provisioning is not available in production. MTN issues production " +
          "API credentials through your operating-company agreement.",
      );
    }
    const apiUserId = newReferenceId();
    await client.createApiUser(apiUserId, a.providerCallbackHost ?? "example.com");
    const apiKey = await client.createApiKey(apiUserId);
    return ok({
      created: true,
      environment: "sandbox",
      MOMO_API_USER: apiUserId,
      MOMO_API_KEY: apiKey,
      next: "Save both into your .env, then restart this server.",
    });
  }),
);

server.registerTool(
  "momo_verify_credentials",
  {
    title: "Verify MoMo credentials",
    description:
      "Check that the subscription key, API user and API key can mint an access " +
      "token. Moves no money.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async () => {
    await client.verifyCredentials();
    return ok({ valid: true, environment: config.environment.target, product: config.product });
  }),
);

server.registerTool(
  "momo_account_balance",
  {
    title: "Get MoMo account balance",
    description: "Read the balance of the configured MoMo account. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async () => ok(await client.accountBalance())),
);

server.registerTool(
  "momo_check_account_active",
  {
    title: "Check a MoMo account is active",
    description:
      "Check whether a phone number is a usable MoMo account before trying to charge " +
      "it. Read-only and free. Worth calling before any request to pay.",
    inputSchema: {
      phoneNumber: z.string()
        .describe("International format, digits only, no +. e.g. 233240000000"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (a) => {
    const msisdn = checkMsisdn(a.phoneNumber);
    const r = await client.accountHolderActive(msisdn);
    return ok({ phoneNumber: msisdn, active: r?.result ?? r });
  }),
);

server.registerTool(
  "momo_request_to_pay",
  {
    title: "Request a MoMo payment",
    description:
      "Ask a subscriber to approve a payment on their phone. Returns a referenceId; " +
      "the payment is PENDING until they approve, so poll momo_payment_status. In a " +
      "production environment this collects REAL money and requires explicit " +
      "confirmation from the human you are working for - never supply the " +
      "confirmation phrase on your own initiative.",
    inputSchema: {
      amount: z.number().positive().describe("Amount in major units, e.g. 25.50"),
      phoneNumber: z.string().describe("Payer's number, digits only, no +"),
      payerMessage: z.string().optional().describe("Shown to the payer, max 160 chars"),
      payeeNote: z.string().optional().describe("Kept on your side, max 160 chars"),
      externalId: z.string().optional().describe("Your own order reference"),
      confirm: z.string().optional()
        .describe(`Required in production only. Must be exactly "${CONFIRM_PHRASE}".`),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  handle(async (a) => {
    checkLiveConfirmation(config.environment, a.confirm);
    const amount = checkAmount(a.amount, config.maxAmount, config.currency);
    const referenceId = newReferenceId();

    await client.requestToPay({
      referenceId,
      amount,
      currency: config.currency,
      payerMsisdn: checkMsisdn(a.phoneNumber),
      externalId: checkText(a.externalId, "externalId", 64),
      payerMessage: checkText(a.payerMessage, "payerMessage"),
      payeeNote: checkText(a.payeeNote, "payeeNote"),
    });

    return ok({
      referenceId,
      status: "PENDING",
      environment: config.environment.target,
      movesRealMoney: config.environment.real,
      amount: `${a.amount} ${config.currency}`,
      note: "The payer must approve on their handset. Poll momo_payment_status.",
    });
  }),
);

server.registerTool(
  "momo_payment_status",
  {
    title: "Check a MoMo payment",
    description:
      "Look up a payment by the referenceId returned from momo_request_to_pay. " +
      "Read-only. Status is PENDING, SUCCESSFUL or FAILED.",
    inputSchema: {
      referenceId: z.string().describe("The UUID returned by momo_request_to_pay"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handle(async (a) => {
    const r = await client.paymentStatus(checkUuid(a.referenceId));
    return ok({
      referenceId: a.referenceId,
      status: r?.status,
      amount: r?.amount != null ? `${r.amount} ${r.currency}` : null,
      payer: r?.payer?.partyId,
      financialTransactionId: r?.financialTransactionId,
      reason: r?.reason,
    });
  }),
);

await server.connect(new StdioServerTransport());
log("ready");

/**
 * End-to-end: spawn the real server over stdio and speak MCP to it.
 * No MoMo credentials are needed; the guards reject before any network call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PRODUCTION_ACK, SANDBOX_HOST, PRODUCTION_HOST } from "./config.mjs";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");
const CREDS = { MOMO_SUBSCRIPTION_KEY: "sub_1234567890abcdef" };

async function connect(env = {}) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...CREDS, ...env, PATH: process.env.PATH ?? "" },
      stderr: "ignore",
    }),
  );
  return client;
}

const LIVE = {
  MOMO_TARGET_ENVIRONMENT: "mtnghana",
  MOMO_CURRENCY: "GHS",
  MOMO_ALLOW_PRODUCTION: PRODUCTION_ACK,
};

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("server starts and advertises its tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "momo_account_balance",
    "momo_check_account_active",
    "momo_environment",
    "momo_payment_status",
    "momo_provision_sandbox_user",
    "momo_request_to_pay",
    "momo_verify_credentials",
  ]);
  await client.close();
});

test("only request_to_pay is marked destructive", async () => {
  const client = await connect();
  const byName = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));

  for (const n of ["momo_environment", "momo_account_balance",
                   "momo_check_account_active", "momo_payment_status"]) {
    assert.equal(byName[n].annotations.readOnlyHint, true, `${n} should be read-only`);
  }
  assert.equal(byName.momo_request_to_pay.annotations.destructiveHint, true);
  // Provisioning writes, but creates a throwaway sandbox identity: not destructive.
  assert.equal(byName.momo_provision_sandbox_user.annotations.readOnlyHint, false);
  assert.equal(byName.momo_provision_sandbox_user.annotations.destructiveHint, false);
  await client.close();
});

test("defaults to the sandbox and says so", async () => {
  const client = await connect();
  const env = JSON.parse(textOf(await client.callTool({ name: "momo_environment", arguments: {} })));
  assert.equal(env.targetEnvironment, "sandbox");
  assert.equal(env.movesRealMoney, false);
  assert.equal(env.host, SANDBOX_HOST);
  assert.equal(env.currency, "EUR");
  assert.equal(env.confirmationRequiredForPayments, false);
  await client.close();
});

test("the subscription key never appears in output", async () => {
  const client = await connect();
  const body = textOf(await client.callTool({ name: "momo_environment", arguments: {} }));
  assert.ok(!body.includes("1234567890abcdef"), "subscription key must not be echoed");
  await client.close();
});

test("a production target reports the production host", async () => {
  const client = await connect(LIVE);
  const env = JSON.parse(textOf(await client.callTool({ name: "momo_environment", arguments: {} })));
  assert.equal(env.targetEnvironment, "mtnghana");
  assert.equal(env.host, PRODUCTION_HOST);
  assert.equal(env.movesRealMoney, true);
  assert.equal(env.confirmationRequiredForPayments, true);
  await client.close();
});

test("a production target without acknowledgement kills the server", async () => {
  await assert.rejects(
    () => connect({ MOMO_TARGET_ENVIRONMENT: "mtnghana", MOMO_CURRENCY: "GHS" }),
    "must refuse to start, not fall back to sandbox",
  );
});

test("sandbox provisioning is refused in production", async () => {
  const client = await connect(LIVE);
  const res = await client.callTool({ name: "momo_provision_sandbox_user", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not available in production/);
  await client.close();
});

test("production payments are refused without the confirmation phrase", async () => {
  const client = await connect(LIVE);
  const res = await client.callTool({
    name: "momo_request_to_pay",
    arguments: { amount: 10, phoneNumber: "233240000000" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /PRODUCTION/);
  assert.match(textOf(res), /ask the human first/);
  await client.close();
});

test("an over-ceiling amount is refused before any network call", async () => {
  const client = await connect({ MOMO_MAX_AMOUNT: "100" });
  const res = await client.callTool({
    name: "momo_request_to_pay",
    arguments: { amount: 5000, phoneNumber: "233240000000" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /exceeds the ceiling of 100/);
  await client.close();
});

test("a malformed phone number is refused before any network call", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "momo_request_to_pay",
    arguments: { amount: 10, phoneNumber: "+233 24 000 0000" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /digits only/);
  await client.close();
});

test("a malformed reference id is refused before any network call", async () => {
  const client = await connect();
  const res = await client.callTool({
    name: "momo_payment_status",
    arguments: { referenceId: "not-a-uuid" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /must be a UUID/);
  await client.close();
});

test("missing API user and key give a message that says what to do", async () => {
  const client = await connect();
  const res = await client.callTool({ name: "momo_verify_credentials", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /momo_provision_sandbox_user/);
  await client.close();
});

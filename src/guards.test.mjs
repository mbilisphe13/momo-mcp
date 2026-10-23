import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAmount, checkLiveConfirmation, checkMsisdn, checkUuid, checkText,
  checkEnvironmentCoherence, newReferenceId, GuardError,
} from "./guards.mjs";
import {
  loadConfig, resolveEnvironment, ConfigError, PRODUCTION_ACK, CONFIRM_PHRASE,
  SANDBOX_HOST, PRODUCTION_HOST, PRODUCTION_TARGETS, mask,
} from "./config.mjs";

const base = { MOMO_SUBSCRIPTION_KEY: "sub_1234567890abcdef" };

test("defaults to the sandbox", () => {
  const c = loadConfig(base);
  assert.equal(c.environment.target, "sandbox");
  assert.equal(c.environment.real, false);
  assert.equal(c.environment.host, SANDBOX_HOST);
  assert.equal(c.currency, "EUR");
});

test("every production target maps to the production host", () => {
  for (const t of PRODUCTION_TARGETS) {
    const e = resolveEnvironment(t);
    assert.equal(e.host, PRODUCTION_HOST, `${t} must use the production host`);
    assert.equal(e.real, true);
  }
  assert.equal(resolveEnvironment("sandbox").host, SANDBOX_HOST);
});

test("an unknown target is refused, never treated as sandbox", () => {
  for (const bad of ["prod", "production", "mtnnowhere", "MTNGHANA ", "live"]) {
    if (bad.trim().toLowerCase() === "mtnghana") continue;
    assert.throws(() => resolveEnvironment(bad), ConfigError, `"${bad}" should be refused`);
  }
});

test("a production target without the acknowledgement refuses to start", () => {
  assert.throws(
    () => loadConfig({ ...base, MOMO_TARGET_ENVIRONMENT: "mtnghana", MOMO_CURRENCY: "GHS" }),
    (e) => e instanceof ConfigError && /MOMO_ALLOW_PRODUCTION/.test(e.message),
  );
  const c = loadConfig({
    ...base, MOMO_TARGET_ENVIRONMENT: "mtnghana", MOMO_CURRENCY: "GHS",
    MOMO_ALLOW_PRODUCTION: PRODUCTION_ACK,
  });
  assert.equal(c.environment.real, true);
});

test("host and target must cohere on every request", () => {
  assert.doesNotThrow(() => checkEnvironmentCoherence(resolveEnvironment("sandbox")));
  assert.doesNotThrow(() => checkEnvironmentCoherence(resolveEnvironment("mtnuganda")));

  // Tampered combinations: the sandbox target pointed at production, and a
  // country target pointed at the sandbox. Both must be refused.
  assert.throws(
    () => checkEnvironmentCoherence({ target: "sandbox", host: PRODUCTION_HOST, real: false }),
    GuardError,
  );
  assert.throws(
    () => checkEnvironmentCoherence({ target: "mtnghana", host: SANDBOX_HOST, real: true }),
    GuardError,
  );
  // A target that claims production while sitting on the sandbox host.
  assert.throws(
    () => checkEnvironmentCoherence({ target: "sandbox", host: SANDBOX_HOST, real: true }),
    GuardError,
  );
});

test("the sandbox refuses a currency it would silently ignore", () => {
  assert.throws(() => loadConfig({ ...base, MOMO_CURRENCY: "GHS" }), /only settles in EUR/);
  assert.doesNotThrow(() => loadConfig({ ...base, MOMO_CURRENCY: "EUR" }));
});

test("production requires a currency", () => {
  assert.throws(
    () => loadConfig({
      ...base, MOMO_TARGET_ENVIRONMENT: "mtnzambia", MOMO_ALLOW_PRODUCTION: PRODUCTION_ACK,
    }),
    /MOMO_CURRENCY is required/,
  );
});

test("a missing subscription key is rejected", () => {
  assert.throws(() => loadConfig({}), /MOMO_SUBSCRIPTION_KEY/);
});

test("amount ceiling holds and amounts go out as strings", () => {
  assert.equal(checkAmount(25.5, 1000, "EUR"), "25.5");
  assert.throws(() => checkAmount(1000.01, 1000, "EUR"), /exceeds the ceiling/);
  for (const bad of [0, -1, "10", NaN, Infinity, null]) {
    assert.throws(() => checkAmount(bad, 1000, "EUR"), GuardError);
  }
  assert.throws(() => checkAmount(1.005, 1000, "EUR"), /two decimal places/);
});

test("sandbox needs no confirmation, production needs the exact phrase", () => {
  const sandbox = resolveEnvironment("sandbox");
  const live = resolveEnvironment("mtnghana");
  assert.doesNotThrow(() => checkLiveConfirmation(sandbox, undefined));
  assert.throws(() => checkLiveConfirmation(live, undefined), GuardError);
  assert.throws(() => checkLiveConfirmation(live, "yes"), GuardError);
  assert.throws(() => checkLiveConfirmation(live, CONFIRM_PHRASE.toLowerCase()), GuardError);
  assert.doesNotThrow(() => checkLiveConfirmation(live, CONFIRM_PHRASE));
});

test("phone numbers must be digits only, no plus", () => {
  assert.equal(checkMsisdn("233240000000"), "233240000000");
  assert.equal(checkMsisdn("  27831234567 "), "27831234567");
  for (const bad of ["+233240000000", "233 240 000 000", "0240000000x", "123", ""]) {
    assert.throws(() => checkMsisdn(bad), GuardError);
  }
});

test("reference ids must be real UUIDs", () => {
  const id = newReferenceId();
  assert.equal(checkUuid(id), id);
  for (const bad of ["abc", "", "00000000-0000-0000-0000", undefined]) {
    assert.throws(() => checkUuid(bad), GuardError);
  }
});

test("generated reference ids are unique", () => {
  const ids = new Set(Array.from({ length: 200 }, newReferenceId));
  assert.equal(ids.size, 200);
});

test("payer-visible text is bounded and single-line", () => {
  assert.equal(checkText("Order 42", "payerMessage"), "Order 42");
  assert.equal(checkText(undefined, "payerMessage"), undefined);
  assert.throws(() => checkText("x".repeat(161), "payerMessage"), /at most 160/);
  assert.throws(() => checkText("a\nb", "payerMessage"), /line breaks/);
});

test("mask never reveals a whole secret", () => {
  assert.equal(mask(""), "unset");
  assert.equal(mask("short"), "*****");
  assert.match(mask("sub_1234567890abcdef"), /^sub_\.\.\.cdef$/);
});

/**
 * Policy guards. Pure functions, no network, testable without credentials.
 */
import { CONFIRM_PHRASE, SANDBOX_HOST, PRODUCTION_HOST } from "./config.mjs";

export class GuardError extends Error {}

/**
 * The coherence check that gives this server its safety property.
 *
 * MoMo takes the environment from the host AND from X-Target-Environment.
 * If those two ever disagree the request is either going to the wrong place
 * or carrying the wrong label, and both are the kind of mistake that is only
 * noticed afterwards. Checked on every request, not just at startup.
 */
export function checkEnvironmentCoherence(environment) {
  const { target, host, real } = environment;
  const sandboxTarget = target === "sandbox";
  const sandboxHost = host === SANDBOX_HOST;

  if (sandboxTarget !== sandboxHost) {
    throw new GuardError(
      `Environment mismatch: target "${target}" with host "${host}". ` +
        `The sandbox target must use ${SANDBOX_HOST} and a country target must ` +
        `use ${PRODUCTION_HOST}. Refusing the request.`,
    );
  }
  if (real === sandboxHost) {
    throw new GuardError(
      `Environment mismatch: real=${real} but host is "${host}". Refusing the request.`,
    );
  }
  return true;
}

/**
 * MoMo takes amounts as a string in MAJOR units, so there is no subunit
 * conversion here, only validation and the ceiling.
 */
export function checkAmount(amount, maxAmount, currency) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new GuardError(`Amount must be a number in ${currency}, for example 25.50.`);
  }
  if (amount <= 0) throw new GuardError("Amount must be greater than zero.");
  if (Math.round(amount * 100) !== amount * 100) {
    throw new GuardError("Amount cannot be finer than two decimal places.");
  }
  if (amount > maxAmount) {
    throw new GuardError(
      `Amount ${amount} ${currency} exceeds the ceiling of ${maxAmount}. ` +
        `Raise MOMO_MAX_AMOUNT deliberately if this is intended.`,
    );
  }
  return String(amount);
}

/** Sandbox money is imaginary; production requires the exact phrase. */
export function checkLiveConfirmation(environment, confirm) {
  if (!environment.real) return;
  if (confirm !== CONFIRM_PHRASE) {
    throw new GuardError(
      `This server is pointed at ${environment.target}, a PRODUCTION environment, ` +
        `and this call moves real money. Pass confirm="${CONFIRM_PHRASE}" to proceed. ` +
        `Do not supply it on your own initiative - ask the human first.`,
    );
  }
}

/**
 * MSISDN: digits only, no plus, no spaces, international format. MoMo rejects
 * anything else with an opaque error, so catch it here with a clear one.
 */
export function checkMsisdn(msisdn) {
  const s = String(msisdn ?? "").trim();
  if (!/^\d{8,15}$/.test(s)) {
    throw new GuardError(
      `Phone number must be digits only in international format without "+", ` +
        `e.g. 233240000000. Got "${msisdn}".`,
    );
  }
  return s;
}

/**
 * X-Reference-Id is a UUID the CALLER generates, and it doubles as the
 * transaction id and the idempotency key. Reusing one silently refers to the
 * earlier transaction, so a malformed value must never be coerced.
 */
export function checkUuid(id, field = "referenceId") {
  const s = String(id ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new GuardError(`${field} must be a UUID, e.g. ${crypto.randomUUID()}.`);
  }
  return s;
}

export const newReferenceId = () => crypto.randomUUID();

/** Payer messages and notes are shown to the payer; keep them sane. */
export function checkText(value, field, max = 160) {
  if (value == null) return undefined;
  const s = String(value);
  if (s.length > max) throw new GuardError(`${field} must be at most ${max} characters.`);
  if (/[\r\n]/.test(s)) throw new GuardError(`${field} must not contain line breaks.`);
  return s;
}

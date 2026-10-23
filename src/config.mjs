/**
 * Configuration and the environment lock.
 *
 * MTN MoMo is unusual in having TWO environment levers that must agree:
 *
 *   1. the host          sandbox.momodeveloper.mtn.com vs proxy.momoapi.mtn.com
 *   2. X-Target-Environment   "sandbox" vs a country code like "mtnghana"
 *
 * Either one alone is a single point of failure. Sending the sandbox target
 * to the production host, or a country target to the sandbox host, is always
 * a mistake, so this server derives both from one setting and refuses any
 * combination that does not cohere.
 */

export const SANDBOX_HOST = "https://sandbox.momodeveloper.mtn.com";
export const PRODUCTION_HOST = "https://proxy.momoapi.mtn.com";

/**
 * Production target environments, one per MTN operating company. This list is
 * what makes the host/target pairing checkable; an unknown value is refused
 * rather than passed through to the API.
 */
export const PRODUCTION_TARGETS = [
  "mtnbenin", "mtncameroon", "mtncongo", "mtnghana", "mtnguineaconakry",
  "mtnivorycoast", "mtnliberia", "mtnrwanda", "mtnsouthafrica", "mtnswaziland",
  "mtnuganda", "mtnzambia",
];

/** Exact string required to unlock production. Deliberately awkward. */
export const PRODUCTION_ACK = "i-understand-this-moves-real-money";

/** Phrase required per call before a live payment request is sent. */
export const CONFIRM_PHRASE = "CONFIRM LIVE PAYMENT";

/** Default ceiling on a single request, in major units. */
export const DEFAULT_MAX_AMOUNT = 1000;

/** Products a subscription key can be issued against. */
export const PRODUCTS = ["collection", "disbursement", "remittance"];

export class ConfigError extends Error {}

/**
 * Resolve the host and target environment together, so they cannot disagree.
 * `target` is "sandbox" or one of PRODUCTION_TARGETS.
 */
export function resolveEnvironment(target) {
  const t = String(target ?? "sandbox").toLowerCase().trim();

  if (t === "sandbox") {
    return { target: "sandbox", host: SANDBOX_HOST, real: false, currency: "EUR" };
  }
  if (PRODUCTION_TARGETS.includes(t)) {
    return { target: t, host: PRODUCTION_HOST, real: true, currency: null };
  }
  throw new ConfigError(
    `MOMO_TARGET_ENVIRONMENT must be "sandbox" or one of: ` +
      `${PRODUCTION_TARGETS.join(", ")}. Got "${t}". ` +
      `Refusing to run against an environment whose host cannot be determined.`,
  );
}

export function loadConfig(env = process.env) {
  const environment = resolveEnvironment(env.MOMO_TARGET_ENVIRONMENT);

  // Production is opt-in twice: a country target AND a separate acknowledgement.
  if (environment.real && env.MOMO_ALLOW_PRODUCTION !== PRODUCTION_ACK) {
    throw new ConfigError(
      `MOMO_TARGET_ENVIRONMENT="${environment.target}" is a PRODUCTION environment ` +
        `and also requires MOMO_ALLOW_PRODUCTION="${PRODUCTION_ACK}". ` +
        `Refusing to start: production was asked for but not acknowledged.`,
    );
  }

  const product = (env.MOMO_PRODUCT ?? "collection").toLowerCase().trim();
  if (!PRODUCTS.includes(product)) {
    throw new ConfigError(`MOMO_PRODUCT must be one of ${PRODUCTS.join(", ")}.`);
  }

  if (!env.MOMO_SUBSCRIPTION_KEY) {
    throw new ConfigError(
      "MOMO_SUBSCRIPTION_KEY is not set. Get it from momodeveloper.mtn.com " +
        "after subscribing to the product you need.",
    );
  }

  // The sandbox only settles in EUR; production uses the local currency.
  const currency = (env.MOMO_CURRENCY ?? environment.currency ?? "").toUpperCase();
  if (environment.real && !currency) {
    throw new ConfigError("MOMO_CURRENCY is required in production, e.g. GHS, UGX, ZMW.");
  }
  if (!environment.real && currency !== "EUR") {
    throw new ConfigError(
      `The MoMo sandbox only settles in EUR; MOMO_CURRENCY="${currency}" would be ` +
        `silently ignored by the API, so it is refused here instead.`,
    );
  }

  const maxAmount = Number(env.MOMO_MAX_AMOUNT ?? DEFAULT_MAX_AMOUNT);
  if (!Number.isFinite(maxAmount) || maxAmount <= 0) {
    throw new ConfigError("MOMO_MAX_AMOUNT must be a positive number.");
  }

  return {
    environment,
    product,
    currency,
    maxAmount,
    subscriptionKey: env.MOMO_SUBSCRIPTION_KEY.trim(),
    // Only needed once a sandbox user has been provisioned, or in production.
    apiUser: env.MOMO_API_USER?.trim() || null,
    apiKey: env.MOMO_API_KEY?.trim() || null,
  };
}

/** Never print a secret in full. */
export const mask = (s) =>
  !s ? "unset" : s.length <= 8 ? "*".repeat(s.length) : `${s.slice(0, 4)}...${s.slice(-4)}`;

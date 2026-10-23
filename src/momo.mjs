/**
 * MTN MoMo API client.
 *
 * Auth is two-layered: an Ocp-Apim-Subscription-Key identifies your product
 * subscription, and a short-lived bearer token is minted from an API user and
 * API key over HTTP Basic. In the sandbox you provision that user and key
 * yourself through /v1_0/apiuser; in production MTN issues them.
 */
import { checkEnvironmentCoherence } from "./guards.mjs";

export class MomoError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class MomoClient {
  #config;
  #token = null;
  #tokenExpiresAt = 0;

  constructor(config) {
    this.#config = config;
  }

  get environment() {
    return this.#config.environment;
  }

  #url(path) {
    // Re-checked per request, not just at startup: the host and the target
    // environment header must agree on every single call.
    checkEnvironmentCoherence(this.#config.environment);
    return this.#config.environment.host + path;
  }

  async #parse(res) {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text ? { raw: text.slice(0, 300) } : null;
    }
  }

  /** Create a sandbox API user. Sandbox only; the id is chosen by the caller. */
  async createApiUser(referenceId, providerCallbackHost = "example.com") {
    const res = await fetch(this.#url("/v1_0/apiuser"), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.#config.subscriptionKey,
        "X-Reference-Id": referenceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ providerCallbackHost }),
    });
    if (!res.ok) {
      throw new MomoError(`Could not create API user (${res.status}).`, {
        status: res.status, body: await this.#parse(res),
      });
    }
    return referenceId;
  }

  /** Mint the API key for a sandbox API user. Returns the key. */
  async createApiKey(apiUserId) {
    const res = await fetch(this.#url(`/v1_0/apiuser/${apiUserId}/apikey`), {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.#config.subscriptionKey,
        "Content-Length": "0",
      },
    });
    const body = await this.#parse(res);
    if (!res.ok || !body?.apiKey) {
      throw new MomoError(`Could not create API key (${res.status}).`, {
        status: res.status, body,
      });
    }
    return body.apiKey;
  }

  async getApiUser(apiUserId) {
    const res = await fetch(this.#url(`/v1_0/apiuser/${apiUserId}`), {
      headers: { "Ocp-Apim-Subscription-Key": this.#config.subscriptionKey },
    });
    const body = await this.#parse(res);
    if (!res.ok) {
      throw new MomoError(`Could not read API user (${res.status}).`, { status: res.status, body });
    }
    return body;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpiresAt) return this.#token;

    const { apiUser, apiKey, product, subscriptionKey } = this.#config;
    if (!apiUser || !apiKey) {
      throw new MomoError(
        "MOMO_API_USER and MOMO_API_KEY are not set. In the sandbox, call " +
          "momo_provision_sandbox_user once and put the values it returns into your .env.",
      );
    }

    const basic = Buffer.from(`${apiUser}:${apiKey}`).toString("base64");
    const res = await fetch(this.#url(`/${product}/token/`), {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Ocp-Apim-Subscription-Key": subscriptionKey,
        "Content-Length": "0",
      },
    });
    const body = await this.#parse(res);
    if (!res.ok || !body?.access_token) {
      throw new MomoError(
        `Token request failed (${res.status}). Check the API user, API key and that ` +
          `the subscription key is for the "${product}" product.`,
        { status: res.status, body },
      );
    }

    this.#token = body.access_token;
    const ttl = Number(body.expires_in ?? 3600);
    this.#tokenExpiresAt = Date.now() + Math.max(ttl - 60, 30) * 1000;
    return this.#token;
  }

  async #request(method, path, { body, referenceId } = {}) {
    const token = await this.#accessToken();
    const res = await fetch(this.#url(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": this.#config.subscriptionKey,
        "X-Target-Environment": this.#config.environment.target,
        ...(referenceId ? { "X-Reference-Id": referenceId } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const parsed = await this.#parse(res);
    if (!res.ok) {
      throw new MomoError(
        parsed?.message ?? `${method} ${path} failed (${res.status}).`,
        { status: res.status, body: parsed },
      );
    }
    return parsed;
  }

  /** Ask a subscriber to approve a payment. 202 means accepted, not paid. */
  async requestToPay({ referenceId, amount, currency, payerMsisdn, externalId, payerMessage, payeeNote }) {
    await this.#request("POST", `/${this.#config.product}/v1_0/requesttopay`, {
      referenceId,
      body: {
        amount,
        currency,
        externalId: externalId ?? referenceId,
        payer: { partyIdType: "MSISDN", partyId: payerMsisdn },
        ...(payerMessage ? { payerMessage } : {}),
        ...(payeeNote ? { payeeNote } : {}),
      },
    });
    return { referenceId, status: "PENDING" };
  }

  paymentStatus(referenceId) {
    return this.#request("GET", `/${this.#config.product}/v1_0/requesttopay/${referenceId}`);
  }

  accountBalance() {
    return this.#request("GET", `/${this.#config.product}/v1_0/account/balance`);
  }

  /** Is this number a usable MoMo account? Read-only, cheap, no money. */
  accountHolderActive(msisdn) {
    return this.#request(
      "GET",
      `/${this.#config.product}/v1_0/accountholder/msisdn/${msisdn}/active`,
    );
  }

  async verifyCredentials() {
    await this.#accessToken();
    return true;
  }
}

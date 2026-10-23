#!/usr/bin/env node
/** `npm run check` - validate configuration and credentials. Moves no money. */
import { loadConfig, ConfigError, mask } from "./config.mjs";
import { MomoClient } from "./momo.mjs";

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`\n  FAIL  ${e.message}\n`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}

if (config) {
  const { environment: env } = config;
  const line = (l, v) => console.log(`  ${l.padEnd(16)} ${v}`);

  console.log("\nMTN MoMo MCP preflight\n");
  line("environment", env.target + (env.real ? "   *** PRODUCTION - REAL MONEY ***" : ""));
  line("host", env.host);
  line("product", config.product);
  line("currency", config.currency);
  line("max amount", `${config.maxAmount} ${config.currency}`);
  line("subscription", mask(config.subscriptionKey));
  line("api user", config.apiUser ? mask(config.apiUser) : "not set");
  line("api key", config.apiKey ? "set" : "not set");
  line("confirmation", env.real ? "required per payment" : "not required in sandbox");

  if (!config.apiUser || !config.apiKey) {
    console.log(
      "\n  No API user yet. In the sandbox, start the server and call\n" +
        "  momo_provision_sandbox_user once, then save the two values it returns.\n",
    );
    process.exitCode = 1;
  } else {
    // Resolve fully before printing, and never process.exit() after a fetch:
    // tearing down mid-flight trips a libuv assertion on Windows.
    let failure = null;
    try {
      await new MomoClient(config).verifyCredentials();
    } catch (e) {
      failure = e.message;
    }

    if (failure) {
      line("credentials", "FAILED");
      console.log(`\n  ${failure}\n`);
      process.exitCode = 1;
    } else {
      line("credentials", "ok");
      console.log();
    }
  }
}

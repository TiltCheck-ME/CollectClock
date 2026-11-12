# collectclock-api (Cloudflare Worker)

Source of the live `collectclock-api` worker (https://collectclock-api.j-chapman7.workers.dev).
It was deployed code-only and lived outside the repo until now.

- `index.js` – the whole worker (ES module, `export default { fetch, scheduled }`).
- `metadata.json` – bindings the live worker already has (KV `CC`). Secrets (`BOT_TOKEN`,
  `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, webhooks) are set in Cloudflare, never here.

Deploy is code-only: upload `index.js` to the script's `/content` endpoint so bindings,
secrets and vars stay as they are. Do not deploy from a draft PR.

Tests: `node --test worker/collectclock-api/test/`

# Flag changes in Discord, with n8n

Every time a flag is created, changed or archived, the API sends a signed webhook. This folder runs **n8n** in Docker to receive it and post one line to a Discord channel, plus a **daily summary** of rollouts in progress at 09:00. **ngrok** gives your machine a fixed public address, so the API on Cloudflare can reach n8n.

```
flag change ──► API (Cloudflare) ──signed POST──► ngrok ──► n8n ──► Discord
                                                  09:00 ──► n8n ──GET /v1/flags──► API
```

What you'll see in Discord:

```
🔁 "new-pricing": everyone else: on 10%, off 90% → everyone else: on 25%, off 75% (via MCP)
📊 Rollouts in progress (2026-11-12)
• `new-pricing`: rule pro-plan: on 100% · everyone else: on 25%, off 75%
```

## What you need

- **Docker Desktop**, running.
- **ngrok** (free): sign up at ngrok.com, then copy your **authtoken** and your free **static domain** (dashboard → Domains), e.g. `your-name.ngrok-free.app`.
- **A Discord channel webhook**: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
- **A project's admin key.** For the dashboard's sandbox, open the dashboard, press F12 → Console, and run:
  ```js
  JSON.parse(localStorage.getItem('ff:dashboard:sandbox')).keys.admin;
  ```

## Set up (once)

**1. Point the project's webhook at your ngrok domain.** The answer contains a `secret` shown only this once.

PowerShell:

```powershell
$admin = "ff_admin_..."
Invoke-RestMethod -Method Put https://feature-flags-api.shehrozsf.workers.dev/v1/webhook `
  -Headers @{ Authorization = "Bearer $admin" } -ContentType application/json `
  -Body '{"url":"https://YOUR-DOMAIN.ngrok-free.app/webhook/ff-flag-change"}'
```

cmd:

```bat
curl -X PUT https://feature-flags-api.shehrozsf.workers.dev/v1/webhook -H "Authorization: Bearer ff_admin_..." -H "content-type: application/json" -d "{\"url\":\"https://YOUR-DOMAIN.ngrok-free.app/webhook/ff-flag-change\"}"
```

**2. Fill in `.env`.** Copy `.env.example` to `.env` in this folder and set `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` (no `https://`), `DISCORD_WEBHOOK_URL`, `FF_ADMIN_KEY` and `FF_WEBHOOK_SECRET` (the `secret` from step 1). Git ignores `.env`.

**3. Start n8n and ngrok, then load and publish the workflows.** From this folder:

```bash
docker compose up -d
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose exec n8n n8n publish:workflow --id=ffFlagChange0001
docker compose exec n8n n8n publish:workflow --id=ffDailySummary01
docker compose restart n8n
```

**4. Check it works.** Send a test ping: a 🏓 line should appear in Discord, and the answer should say `"delivered": true`.

```powershell
Invoke-RestMethod -Method Post https://feature-flags-api.shehrozsf.workers.dev/v1/webhook/test -Headers @{ Authorization = "Bearer $admin" }
```

```bat
curl -X POST https://feature-flags-api.shehrozsf.workers.dev/v1/webhook/test -H "Authorization: Bearer ff_admin_..."
```

Then change a flag in the dashboard (or through Claude, see the main README's MCP section): the change appears in Discord within a few seconds.

## Every day

- `docker compose up -d` / `docker compose down` start and stop it. The address never changes, so the webhook stays registered.
- **The summary now, instead of at 09:00:**
  ```bash
  docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=ffDailySummary01
  ```
  (The extra port keeps this one-off run from clashing with the running n8n.) The time zone is `TIMEZONE` in `.env`, UTC by default.
- **n8n's editor** is at http://localhost:5678 (it asks you to create a local account the first time). Executions shows every event that arrived and what each node did with it.

## How it stays safe

- **Every event is signed** with the project's secret (`x-ff-signature: t=…,v1=<HMAC-SHA256>`). The "Verify and format" node recomputes it and refuses anything unsigned, forged, or more than 5 minutes off with a **401**, so the open ngrok URL can't be used to post into your Discord.
- **Secrets live only in `.env`**, never in the workflow JSON (a test checks this).
- The JavaScript inside the workflows is `code/*.js`, tested in `code.test.mjs` with events built and signed by the API's own code. `workflows.mjs` copies it into `workflows/*.json`; a test fails if the copies drift.

## When something's wrong

| Symptom                               | Likely cause                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Test ping: `"error": "network error"` | ngrok or n8n isn't running (`docker compose ps`), or `NGROK_DOMAIN` doesn't match the webhook URL                                       |
| Test ping: `"status": 404`            | the workflow isn't published: step 3's `publish:workflow` + restart                                                                     |
| Test ping: `"status": 401`            | `FF_WEBHOOK_SECRET` isn't the current secret. Every `PUT /v1/webhook` makes a new one: copy it into `.env`, then `docker compose up -d` |
| Test ping: `"status": 500`            | Discord refused the post: check `DISCORD_WEBHOOK_URL` (n8n's Executions shows the error)                                                |
| No daily summary                      | `FF_ADMIN_KEY` wrong or the sandbox expired; run the summary now (above) and read the error                                             |

Changes to `.env` need `docker compose up -d` (recreates the container), not just a restart. After editing `code/*.js`: `node workflows.mjs`, import again, publish again.

Events that arrive while n8n is stopped are retried 3 times over about 1.5 seconds and then dropped (ADR 0039): delivery is best effort.

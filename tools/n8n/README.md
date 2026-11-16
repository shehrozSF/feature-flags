# Setup guide: Claude Code and Discord for your sandbox

This guide connects a feature-flag sandbox to two things:

1. **Claude Code (MCP):** ask in plain English ("roll new-pricing out to 25%") and Claude changes flags through the API, after showing you a preview.
2. **Discord (webhooks + n8n):** every flag change is posted to a Discord channel, plus a summary of rollouts in progress every morning.

```
flag change ──► API (Cloudflare) ──signed POST──► ngrok ──► n8n (Docker, your PC) ──► Discord
Claude Code ──► API /mcp          09:00 ──► n8n ──GET /v1/flags──► API
```

What you'll see in Discord:

```
🔁 "new-pricing": everyone else: on 10%, off 90% → everyone else: on 25%, off 75% (via MCP)
📊 Rollouts in progress (2026-11-16)
• `new-pricing`: rule pro-plan: on 100% · everyone else: on 25%, off 75%
```

Commands are for **PowerShell** on Windows. Run each part in one PowerShell window, so variables like `$admin` carry between steps; if you open a new window, set them again. Keep every key, secret and URL below to yourself.

- [Part 1: What you need](#part-1-what-you-need)
- [Part 2: Get your sandbox's admin key](#part-2-get-your-sandboxs-admin-key)
- [Part 3: Connect Claude Code](#part-3-connect-claude-code)
- [Part 4: Connect Discord](#part-4-connect-discord)
- [Part 5: Check everything](#part-5-check-everything)
- [Every day](#every-day)
- [Switch to a new sandbox](#switch-to-a-new-sandbox)
- [How it stays safe](#how-it-stays-safe)
- [When something's wrong](#when-somethings-wrong)

---

## Part 1: What you need

Once, about 10 minutes, all free:

| What                            | Where                                                                                                                                                   | Used for                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Claude Code**                 | already installed if you're reading this in it                                                                                                          | MCP                                |
| **Docker Desktop**, running     | docker.com                                                                                                                                              | n8n and ngrok                      |
| **ngrok account**               | https://dashboard.ngrok.com/signup (no card)                                                                                                            | a fixed public address for your PC |
| **ngrok authtoken**             | ngrok dashboard → _Getting Started → Your Authtoken_                                                                                                    | `.env`                             |
| **ngrok static domain**         | ngrok dashboard → _Universal Gateway → Domains_ (or _Domains_); free accounts get one, e.g. `something.ngrok-free.app`; if none is listed, _New Domain_ | `.env` and the webhook URL         |
| **Discord channel webhook URL** | in a server where you're an admin: channel ⚙️ _Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL_                                 | `.env`                             |
| **This repo, up to date**       | `cd D:\Projects\ShehrozSF\feature-flags` then `git switch main` and `git pull`                                                                          | the files in this folder           |

You don't install ngrok or n8n yourself: Docker runs both.

---

## Part 2: Get your sandbox's admin key

1. Open the dashboard: https://shehrozsf.github.io/feature-flags/dashboard/ (start a sandbox if it shows the welcome screen).
2. Press **F12 → Console** and run:
   ```js
   JSON.parse(localStorage.getItem('ff:dashboard:sandbox')).keys.admin;
   ```
3. Copy the `ff_admin_…` value, and in PowerShell:
   ```powershell
   $admin = "ff_admin_PASTE_HERE"
   ```

This key controls the sandbox: anyone with it can read and change its flags.

---

## Part 3: Connect Claude Code

In a terminal (not inside Claude Code):

```powershell
claude mcp add --transport http flags https://feature-flags-api.shehrozsf.workers.dev/mcp --header "Authorization: Bearer $admin"
```

Then **start a new Claude Code session** (servers load when a session starts) and type `/mcp`: `flags` should be connected, with 4 tools.

Try it:

- _"Which flags do I have, and which are mid-rollout?"_: reads only.
- _"Roll new-pricing out to 25% of everyone else."_: Claude shows **before → after** and asks you to approve `apply_flag_change`, which names the flag. Nothing changes until you approve.
- _"Turn off promo-banner."_

Notes:

- `claude mcp add` registers the server for the folder you run it in. To use it in any folder, add `--scope user`.
- For a connection that can only look, add `?mode=read` to the URL: `…/mcp?mode=read`.

---

## Part 4: Connect Discord

### 4.1 Point the sandbox's webhook at your ngrok domain

```powershell
$domain = "something.ngrok-free.app"     # your static domain, no https://

$hook = Invoke-RestMethod -Method Put https://feature-flags-api.shehrozsf.workers.dev/v1/webhook `
  -Headers @{ Authorization = "Bearer $admin" } -ContentType application/json `
  -Body (@{ url = "https://$domain/webhook/ff-flag-change" } | ConvertTo-Json)

$hook.secret | Set-Clipboard
"Webhook secret copied to the clipboard"
```

The secret is shown only this once; it's now on your clipboard for the next step. If you lose it, run this again: it makes a new one.

### 4.2 Fill in `.env`

From the repo root:

```powershell
cd tools\n8n
Copy-Item .env.example .env
notepad .env
```

| Line                   | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `NGROK_AUTHTOKEN=`     | your ngrok authtoken                                        |
| `NGROK_DOMAIN=`        | your static domain, no `https://`                           |
| `DISCORD_WEBHOOK_URL=` | your Discord channel webhook URL                            |
| `FF_ADMIN_KEY=`        | the admin key from Part 2                                   |
| `FF_WEBHOOK_SECRET=`   | paste (Ctrl+V) from 4.1                                     |
| `TIMEZONE=` (optional) | e.g. `Asia/Karachi`, for the 09:00 summary; UTC if left out |

Save and close. Git ignores `.env`, so it's never committed.

### 4.3 Start n8n and ngrok, then load the workflows

Still in `tools\n8n`:

```bash
docker compose up -d --wait
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose exec n8n n8n publish:workflow --id=ffFlagChange0001
docker compose exec n8n n8n publish:workflow --id=ffDailySummary01
docker compose restart n8n
docker compose ps
```

What you should see:

- `up -d --wait` returns once n8n is ready. The first time, it downloads the images (a few minutes).
- The import ends with **Successfully imported 2 workflows.** The first start prints a long list of n8n "migration" lines: normal.
- Each publish prints **Publishing workflow with ID: …**. If one says **not found**, run the import again, then both publishes.
- `docker compose ps` shows **n8n** and **ngrok** as `Up`.

### 4.4 Create n8n's owner account

Open http://localhost:5678 and create the owner account (any email, a strong password). The editor is only reachable from your PC, never through ngrok, but claim it anyway.

---

## Part 5: Check everything

From any folder, with `$admin` set:

1. **Test ping:**
   ```powershell
   Invoke-RestMethod -Method Post https://feature-flags-api.shehrozsf.workers.dev/v1/webhook/test -Headers @{ Authorization = "Bearer $admin" }
   ```
   ✅ `delivered: True, attempts: 1, status: 200`, and Discord shows **🏓 Test event from the feature flag API: this webhook works**.
2. **A change from the dashboard:** flip a flag. ✅ a **🔁** line in Discord within a few seconds.
3. **A change from Claude Code:** ask it to change a flag and approve. ✅ the line ends with **(via MCP)**.
4. **The daily summary, now** (in `tools\n8n`):
   ```powershell
   docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=ffDailySummary01
   ```
   ✅ **📊 Rollouts in progress** in Discord. A "Python 3 is missing" line in the output is harmless: the workflows use JavaScript only.

---

## Every day

| To                           | Run (in `tools\n8n`)                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Stop                         | `docker compose down`                                                                       |
| Start again                  | `docker compose up -d --wait`                                                               |
| See what's running           | `docker compose ps`                                                                         |
| Get the summary now          | `docker compose exec -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=ffDailySummary01` |
| See every event n8n received | http://localhost:5678 → _Executions_                                                        |

- The ngrok address never changes, so nothing needs registering again after a restart.
- While n8n is stopped, changes aren't delivered: each event is tried 3 times over about 1.5 seconds, then dropped.
- After changing `.env`: `docker compose up -d --wait` (recreates the container; a plain restart keeps the old values).

---

## Switch to a new sandbox

A sandbox is deleted **30 days after its last use in the dashboard**, and you might also just start a fresh one. Its keys and webhook go with it, so Claude Code and n8n need the new sandbox's details. ngrok, Discord and the n8n workflows stay as they are.

1. **New admin key:** in the dashboard, start a new sandbox if needed, then repeat [Part 2](#part-2-get-your-sandboxs-admin-key) (`$admin = "…"`).
2. **Claude Code:** replace the server:
   ```powershell
   claude mcp remove flags
   claude mcp add --transport http flags https://feature-flags-api.shehrozsf.workers.dev/mcp --header "Authorization: Bearer $admin"
   ```
   Start a new Claude Code session. (Add `--scope user` to both commands if you used it before.)
3. **Webhook:** repeat [4.1](#41-point-the-sandboxs-webhook-at-your-ngrok-domain) with the new `$admin` (same `$domain`). The new secret is on your clipboard.
4. **`.env`:** in `tools\n8n`, `notepad .env` and replace **two** lines: `FF_ADMIN_KEY=` (new key) and `FF_WEBHOOK_SECRET=` (paste). Leave the rest.
5. **Apply it:**
   ```powershell
   docker compose up -d --wait
   ```
   No import or publish needed: the workflows are kept in n8n's volume.
6. **Check:** the test ping from [Part 5](#part-5-check-everything) with the new `$admin`.

**The old sandbox:** nothing to do if it expired. If it's still alive and you don't want its changes in Discord any more, remove its webhook with its old key:

```powershell
Invoke-RestMethod -Method Delete https://feature-flags-api.shehrozsf.workers.dev/v1/webhook -Headers @{ Authorization = "Bearer ff_admin_OLD_KEY" }
```

(Its events would be refused anyway: n8n only accepts the new secret.)

---

## How it stays safe

- **Writes from Claude need your approval.** `propose_flag_change` only previews and returns a signed token; `apply_flag_change` makes exactly that change, once, within 5 minutes, and only if nobody edited the flag meanwhile.
- **Every event is signed** with the sandbox's webhook secret (`x-ff-signature: t=…,v1=<HMAC-SHA256>`). n8n's "Verify and format" node refuses anything unsigned, forged, or more than 5 minutes off with a **401**, so the public ngrok address can't be used to post into your Discord.
- **Only the webhook is public.** `ngrok-policy.yml` makes ngrok refuse everything except `POST /webhook/ff-flag-change`, so n8n's editor, login page and API never reach the internet. Port 5678 is bound to `127.0.0.1`, so the editor isn't reachable from your network either.
- **Each event is posted once.** After Discord accepts an event, "Remember event" stores its id; a retry or replay with the same id is answered 200 without posting again. The id is stored only after Discord accepted it, so a failed post is retried, not lost.
- **Nobody gets pinged.** Posts are sent with `allowed_mentions: { parse: [] }`, so a variant key such as `@everyone` stays plain text.
- **Secrets live only in `.env`**, never in the workflow JSON (a test checks this).
- The JavaScript inside the workflows is `code/*.js`, tested in `code.test.mjs` with events built and signed by the API's own code. `workflows.mjs` copies it into `workflows/*.json`; a test fails if the copies drift. After editing `code/*.js`: `node workflows.mjs`, then import and publish again.

---

## When something's wrong

Share only outputs that hold no secrets: `docker compose ps`, the test ping's result, or `docker compose logs ngrok` (skim it first). Never share `.env`.

| Symptom                                              | Likely cause                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp` in Claude Code doesn't list `flags`           | start a new session; or it was added in another folder: re-add with `--scope user`                                                             |
| Claude Code: "API error 401"                         | the admin key is wrong or the sandbox expired: [switch to a new sandbox](#switch-to-a-new-sandbox)                                             |
| `publish:workflow` says **not found**                | the import didn't finish (it ran during n8n's first start): import again, then publish both                                                    |
| `docker compose ps` shows ngrok restarting           | `docker compose logs ngrok`: a wrong `NGROK_AUTHTOKEN` or `NGROK_DOMAIN`, or the traffic policy was refused                                    |
| Test ping: `"error": "network error"`                | ngrok or n8n isn't running, or `NGROK_DOMAIN` doesn't match the webhook URL from 4.1                                                           |
| Test ping: `"status": 404`                           | the workflows aren't published: 4.3's publishes + `docker compose restart n8n`                                                                 |
| Test ping: `"status": 401`                           | `FF_WEBHOOK_SECRET` isn't the current secret. Every `PUT /v1/webhook` makes a new one: copy it into `.env`, then `docker compose up -d --wait` |
| Test ping: `"status": 500`                           | Discord refused the post: check `DISCORD_WEBHOOK_URL` (n8n's _Executions_ shows the error)                                                     |
| Test ping: `404` problem from the API ("no webhook") | 4.1 wasn't done for this sandbox                                                                                                               |
| No daily summary                                     | `FF_ADMIN_KEY` is wrong or the sandbox expired; run the summary now and read the error                                                         |

# Valorant store MCP

Ask Claude "what's in my Valorant store?" from any device. It works as a normal Claude connector: add one URL, click Connect, sign in with GitHub.

```
Your PC  --push (personal key)-->  Cloudflare Worker + KV  <--MCP + GitHub sign-in--  Claude (phone, web, desktop)
```

Everyone signs in with their own GitHub account and only sees their own store. Riot logins never leave the PC. The Worker keeps only a GitHub id and username, plus skin names and prices.

## 1. Deploy the Worker (once, whoever hosts it)

**Create a GitHub OAuth app** (GitHub > Settings > Developer settings > OAuth Apps > New):
- Homepage URL: your Worker URL, for example `https://valorant-store-mcp.<subdomain>.workers.dev`
- Authorization callback URL: `<your Worker URL>/callback`
- Copy the client ID and generate a client secret.

**Add repository secrets** (repo Settings > Secrets and variables > Actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Created from the "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `GH_OAUTH_CLIENT_ID` | GitHub OAuth app client ID |
| `GH_OAUTH_CLIENT_SECRET` | GitHub OAuth app client secret |

Optional: add a repository **variable** `ALLOWED_GITHUB_USERS` (for example `Eli-Zac,friend123`) to restrict who can sign in. Leave it unset to allow any GitHub user.

Then run Actions > Deploy Worker > Run workflow. It finds or creates the KV namespace and deploys. Pushes to `worker/` redeploy automatically.

If you use a custom domain, add it to the Worker in the Cloudflare dashboard and use that URL for the GitHub OAuth app and the connector. The Worker works out its own URL, so no code change is needed.

## 2. Connect Claude (each person)

Add a custom connector with the URL `https://<your Worker URL>/mcp`. Click Connect, approve, and sign in with GitHub. It then works on every device signed in to that Claude account.

## 3. Connect your Riot account (each person)

Open `https://<your Worker URL>/account` and sign in with GitHub. Pick either option.

**Option A: Riot login (no PC needed)**
1. Click the link to log in on Riot's own page. This site never sees your password.
2. You land on a page that looks empty or broken. Copy the full address from the address bar and paste it into the box.
3. Your store is read once and shown to Claude.

*Stay logged in (optional):* also paste your Riot login cookies (`ssid` is required) so the store refreshes itself when Claude asks and the daily store has rotated. Cookies are saved encrypted and typically last 1 to 3 weeks before you reconnect. Anyone with those cookies can act as your Riot account, so only enable it if you trust whoever runs the server. It needs the `RIOT_ENCRYPTION_KEY` secret (below). Disconnect on the same page deletes everything.

**Option B: PC script**

Needs Windows, Python 3, and the Riot Client open and logged in.

1. On the account page, click Create PC key. It shows a personal `config.json` once.
2. Copy the `pc` folder to the PC and save that as `config.json` inside it.
3. Test: `python push_store.py --print` shows the store, then `python push_store.py` pushes it.
4. Run `.\setup_task.ps1` once. It pushes at logon and every 2 hours.

If the Riot Client is closed the push fails quietly and Claude says the snapshot is stale. Use `--shard ap|na|eu|kr` if auto-detection picks the wrong region.

**Optional secret for "stay logged in":** add a repository secret `RIOT_ENCRYPTION_KEY` (a long random string, 32+ characters, keep it stable) before deploying. Without it the option is hidden.

## Notes

- The store rotates daily at 00:00 UTC. Claude shows time left from the last snapshot.
- Uses Riot's unofficial store and login endpoints, so a Valorant or Riot change can break it. Riot login mode has not been tested against the real Riot servers.
- Only the GitHub id and username are read. No GitHub scopes are requested and GitHub tokens are not kept.

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

## 3. Set up the PC (each person)

Needs Windows, Python 3, and the Riot Client open and logged in.

1. Open `https://<your Worker URL>/account` and sign in with GitHub. It shows a personal `config.json` once. Signing in again replaces the key.
2. Copy the `pc` folder to the PC and save that as `config.json` inside it.
3. Test: `python push_store.py --print` shows the store, then `python push_store.py` pushes it.
4. Run `.\setup_task.ps1` once. It pushes at logon and every 2 hours.

If the Riot Client is closed the push fails quietly and Claude says the snapshot is stale. Use `--shard ap|na|eu|kr` if auto-detection picks the wrong region.

## Notes

- The store rotates daily at 00:00 UTC. Claude shows time left from the last snapshot.
- Uses Riot's unofficial store endpoint, so a Valorant update can break it.
- Only the GitHub id and username are read. No GitHub scopes are requested and GitHub tokens are not kept.

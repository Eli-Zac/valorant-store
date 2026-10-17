# Valorant store MCP (multi-user)

Ask Claude "what's in my Valorant store?" from any device.

```
Each person's PC  --push-->  Cloudflare Worker + KV  <--MCP--  Claude (phone, web, desktop)
```

Each person has their own key, so everyone sees only their own store. Riot logins never leave the PC. The Worker only holds skin names and prices.

## 1. Deploy the Worker (once, you)

Deployment runs from GitHub Actions, so there is nothing to edit.

1. Fork this repo (or use your own copy).
2. In the repo, go to Settings > Secrets and variables > Actions and add:
   - `CLOUDFLARE_API_TOKEN`: create one from the "Edit Cloudflare Workers" template
   - `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID
   - `ADMIN_TOKEN`: a long random value you keep private
3. Go to Actions > Deploy Worker > Run workflow. It finds or creates the KV namespace, sets the admin token and deploys.

The Worker URL is printed in the deploy log, like `https://valorant-store-mcp.<subdomain>.workers.dev`. Later pushes to `worker/` redeploy automatically.

## 2. Add a person (you)

PowerShell:

```
$h = @{ Authorization = "Bearer YOUR_ADMIN_TOKEN" }
Invoke-RestMethod -Method Post "https://valorant-store-mcp.<subdomain>.workers.dev/admin/users" `
  -Headers $h -ContentType application/json -Body '{"name":"Eli"}'
```

The reply has `key` and `mcp_url`. The key is shown once. Treat both as secrets.

Other admin calls (same headers):
- List people: `GET /admin/users`
- Remove someone (key stops working, snapshot deleted): `DELETE /admin/users/<id>`

## 3. Connect Claude (each person)

Add `mcp_url` as a custom connector in Claude's connector settings. It then works on every device signed in to that account. Ask: "what's in my Valorant store?"

## 4. Set up the PC (each person)

Needs Windows, Python 3, and the Riot Client open and logged in.

1. Copy the `pc` folder to the PC.
2. Copy `config.example.json` to `config.json` and fill in `worker_url` and their `key`.
3. Test: `python push_store.py --print` (shows the store), then `python push_store.py` (pushes it).
4. Run `.\setup_task.ps1` once. It pushes at logon and every 2 hours.

If the Riot Client is closed the push fails quietly and Claude says the snapshot is stale. Use `--shard ap|na|eu|kr` if auto-detection picks the wrong region.

## Notes

- The store rotates daily at 00:00 UTC. Claude shows time left from the last snapshot.
- Uses Riot's unofficial store endpoint, so a Valorant update can break it.

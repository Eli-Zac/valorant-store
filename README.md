# Valorant Store

Check your Valorant store on the web: today’s daily skins with art and VP prices, the Night Market, and a live countdown to the next reset. It is also a Claude connector (MCP), so you can ask Claude "what’s in my Valorant store?" from any device.

```
Your Riot login  -->  Cloudflare Worker + KV  <--  Web app (Discord sign-in)
                                                    <--  Claude (MCP connector)
```

Everyone signs in with their own Discord account and only sees their own store. The Worker keeps only a Discord id and username, plus skin names, icons and prices.

## 1. Deploy the Worker (once, whoever hosts it)

**Create a Discord application** (https://discord.com/developers/applications > New Application), then open OAuth2:
- Under Redirects add `<your Worker URL>/callback`, for example `https://valorant-store.<subdomain>.workers.dev/callback` (or your custom domain).
- Copy the client ID and reset the client secret to reveal it. No bot or extra scopes are needed.

**Add repository secrets** (repo Settings > Secrets and variables > Actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Created from the "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | Discord application client secret |
| `DISCORD_PUBLIC_KEY` | Discord application public key (General Information page), used to verify `/store` requests |

Optional: add a repository **variable** `ALLOWED_DISCORD_USERS` (Discord usernames or ids, for example `eli_zac,123456789012345678`) to restrict who can sign in. Leave it unset to allow any Discord user.

Then run Actions > Deploy Worker > Run workflow. It finds or creates the KV namespace and deploys. Pushes to `worker/` redeploy automatically.

If you use a custom domain, add it to the Worker in the Cloudflare dashboard and use that URL for the Discord redirect and the connector. The Worker works out its own URL, so no code change is needed.

## 2. Connect your Riot account (each person)

Open your Worker URL, click **Sign in with Discord**, then go to the **Connect** tab. You can link up to five Riot accounts to one Discord login; the **Store** tab has a switcher, and Claude sees all of them (or one, if you name it).

1. Click **Open Riot login** to log in on Riot's own page. This site never sees your password.
2. You land on a page that looks empty or broken. Copy the full address from the address bar and paste it into the box.
3. Your store is read once and shown on the **Store** tab (and to Claude).

To add another account, sign out of Riot on that page first (or use a private window) and repeat.

*Stay logged in (optional):* also paste your Riot login cookies (`ssid` is required) so the store refreshes itself when you open the page (or Claude asks) and the daily store has rotated. The Store tab also gets a Refresh button. Cookies are saved encrypted and typically last 1 to 3 weeks before you reconnect. Anyone with those cookies can act as your Riot account, so only enable it if you trust whoever runs the server. It needs the `RIOT_ENCRYPTION_KEY` secret (below). Removing an account on the same page deletes its saved connection and store.

**Optional secret for "stay logged in":** add a repository secret `RIOT_ENCRYPTION_KEY` (a long random string, 32+ characters, keep it stable) before deploying. Without it the option is hidden.

## Discord `/store` command (once, whoever hosts it)

The deploy registers a single `/store` command with an optional `account` parameter (autocomplete lists the Riot accounts you linked). It is a user-installable app, so anyone can add it to their own profile and use it in any server, DM or group chat. Replies are only visible to the person who ran it.

In the Discord developer portal, for your application:
1. **General Information** > copy the **Public Key** into the `DISCORD_PUBLIC_KEY` secret, and set **Interactions Endpoint URL** to `<your Worker URL>/interactions` (Discord checks it responds, so deploy first).
2. **Installation** > enable **User Install**, add the `applications.commands` scope to its install link, and make sure the install link is on.

Each person then opens the **Claude** tab on the site and clicks **Add to Discord** (or uses your install link), links their Riot accounts on the **Connect** tab, and runs `/store`. Commands can take up to an hour to show up the first time.

## 3. Check your store

The **Store** tab is the main screen: daily skins, Night Market when it is live, daily VP total and a live reset timer.

## 4. Ask Claude (MCP, optional)

The **Claude** tab shows your connector URL. Add a custom connector in Claude with `https://<your Worker URL>/mcp`, click Connect, approve, and sign in with Discord. It then works on every device signed in to that Claude account.

## Notes

- The store rotates daily at 00:00 UTC. The site and Claude show time left from the last snapshot.
- Uses Riot's unofficial store and login endpoints, so a Valorant or Riot change can break it. Riot login mode has not been tested against the real Riot servers.
- Only the Discord id and username are read. Only the `identify` scope is requested and Discord tokens are not kept.

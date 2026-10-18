# Privacy Policy

Last updated 18 October 2026.

This is the same policy shown at `/privacy` on the live site.

## Who we are

Valorant Store is a small, independent web app and Claude connector (MCP) that shows you your own Valorant item store. It is run by Eli-Zac (the operator). It is not affiliated with or endorsed by Riot Games, Discord or Anthropic. The source code is public at <https://github.com/Eli-Zac/valorant-store>.

## What we collect and why

- **Discord sign-in.** When you sign in we ask Discord for the `identify` scope only. We keep your Discord user ID, username and display name so we can tell users apart and show your name. We do not ask for your email address, servers, friends or messages, and we discard the Discord access token straight after reading your profile.
- **Riot account details.** When you link a Riot account we keep its Riot account ID (PUUID), its region, its Riot ID (name and tag) if Riot provides it, and when you linked it.
- **Your store.** We save the latest snapshot of your store so we can show it again: skin names, images and VP prices, the Night Market if there is one, and when they rotate. This is the whole point of the service.
- **Your Riot login.** You log in on Riot's own page, so we never see your password. The address you paste back contains short-lived Riot tokens. We use them once to read your store and then discard them. They are not saved.
- **"Stay logged in" (optional, off by default).** If you turn it on, we also save your Riot login cookies, encrypted, and use them only to refresh your store when it has rotated. The encryption key is a secret held by the operator, so the operator could technically decrypt them. Only turn this on if you trust the operator. You can remove it at any time by removing the account.
- **Sign-in session.** We set one strictly necessary cookie to keep you signed in and keep a matching server-side session record (your Discord ID and name, plus a token that protects forms). It expires after one hour.
- **Claude connector.** If you add the connector, we keep a record of the app you approved and its access. When you ask Claude for your store, we send it your store details as text. What Claude does with that text is covered by Anthropic's own policies.

We do not collect payment details, we do not sell or share your data for advertising, and we do not run analytics or advertising trackers.

## Where your data goes

- **Cloudflare** hosts the service and stores your data in its Workers KV database. Cloudflare also processes technical request data such as your IP address.
- **Discord** handles sign-in. **Riot Games** receives the requests we make to read your store.
- **Google Fonts** and **valorant-api.com** are loaded by your browser for fonts and skin images, so they can see your IP address and browser details when you visit.

## How long we keep it

- Removing a Riot account on the Connect tab deletes its saved connection and store snapshot straight away.
- Sign-in sessions expire after one hour.
- Your Discord ID and name, and any remaining connector records, are kept until you ask us to delete them. To have everything removed, [open an issue on GitHub](https://github.com/Eli-Zac/valorant-store/issues), or revoke the connector from your Claude settings.

## Security

Everything is sent over HTTPS. Saved Riot cookies, if you choose to save them, are encrypted. The operator can access the service's database, so please only use it if you are comfortable with that. No system is perfectly secure, and Riot's login and store endpoints that we rely on are unofficial.

## Your choices

You can ask what we hold about you, ask us to correct or delete it, or stop using the service at any time. To do any of that, [open an issue on GitHub](https://github.com/Eli-Zac/valorant-store/issues).

## Children

This service is not for anyone under 13, or under the minimum age Discord allows in your country.

## Changes

If we change this policy we will update the date at the top. Material changes will be announced on the GitHub page.

## Contact

Questions or requests: [open an issue on GitHub](https://github.com/Eli-Zac/valorant-store/issues).

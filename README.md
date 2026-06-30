# Mafia Platform

A real-time, browser-based Mafia (mafia vs. civilian) party game with built-in video chat, room codes, role assignment, day/night phases, and voting.

## What's included

- `server.js` — Express + Socket.io game server (rooms, roles, phase timer, voting, win conditions)
- `public/index.html` — the full client: join screen, lobby, role reveal, voting UI, and Jitsi video call
- `package.json` — dependencies

## How the game works

1. Players open the page, enter a **handle** and a **room ID**, and join.
2. The first person into a room becomes the **host**. The host needs at least 3 players to start.
3. On start, ~25% of players (minimum 1) are secretly assigned **Mafia**; the rest are **Civilians**. Each player privately sees their own role.
4. **Night phase (30s):** only Mafia can vote on who to eliminate.
5. **Day phase (45s):** everyone alive can vote on who to eliminate.
6. Whoever gets the most votes in a phase is eliminated (no elimination on a tie or no votes).
7. The game ends when all Mafia are eliminated (**Civilians win**) or Mafia count is ≥ Civilian count (**Mafia wins**).
8. Win/loss stats are tracked per username for the lifetime of the server process.

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a browser. To test with multiple "players," open it in a few browser tabs/windows (or have friends on the same network hit your machine's local IP).

## Video chat (Jitsi as a Service)

The video feature uses **JaaS (Jitsi as a Service)**, 8x8's hosted, production-ready version of Jitsi — unlike the free public `meet.jit.si` server, JaaS calls don't auto-disconnect after 5 minutes and are meant for embedding in real apps.

This requires server-side JWT signing, since each participant needs a signed token proving they're authorized to join a given room. The token is generated fresh by `server.js` whenever a player taps "Connect Video Feed," using credentials from your JaaS account.

### Required environment variables

Set these on whatever host runs `server.js` (never commit them to git, never hardcode them in source):

| Variable | Where to find it |
|---|---|
| `JAAS_APP_ID` | JaaS console → API Keys page → "Your AppID is:" |
| `JAAS_KID` | JaaS console → API Keys page → the "ID" column for your key (format: `vpaas-magic-cookie-<appid>/<suffix>`) |
| `JAAS_PRIVATE_KEY` | Contents of the private key file generated via `ssh-keygen` (the file *without* `.pub` — never the uploaded public key) |

Generating the key pair, if you haven't already:
```bash
ssh-keygen -t rsa -b 4096 -m PEM -f jaas_private.key
```
Upload `jaas_private.key.pub` (public key only) to the JaaS console's "Add API Key" dialog. Keep `jaas_private.key` (no `.pub`) private — that's your `JAAS_PRIVATE_KEY` value.

**Pasting a PEM key into an env var:** most hosting dashboards (Render, Railway, etc.) accept multi-line env var values directly — paste the full key including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines as-is. If your host only accepts single-line values, replace actual newlines with the literal two characters `\n`; the server automatically converts them back.

Locally, you can use a `.env` file with a loader like `dotenv`, or export them in your shell before running:
```bash
export JAAS_APP_ID="vpaas-magic-cookie-..."
export JAAS_KID="vpaas-magic-cookie-.../9a2257"
export JAAS_PRIVATE_KEY="$(cat jaas_private.key)"
npm start
```

If these aren't set, the "Connect Video Feed" button will fail gracefully with an error message in the news feed rather than crashing the app.

### How it works

1. Player taps "Connect Video Feed."
2. Client calls `POST /api/video-token` with their username, room, and host status.
3. Server generates a short-lived (1 hour) signed JWT scoped to that specific room, using your private key.
4. Client passes that JWT to the JaaS `JitsiMeetExternalAPI`, connecting to `8x8.vc` instead of the public demo server.
5. Each game room gets its own isolated video call, namespaced under your App ID.

The fullscreen/landscape lock and picture-in-picture docking behavior on mobile work exactly as before.

## Deploying so others can join

This needs a real Node host (not static hosting) since it runs a WebSocket server. Easy options:
- [Render](https://render.com) — free tier, connect a GitHub repo, it auto-detects `npm start`
- [Railway](https://railway.app)
- [Fly.io](https://fly.io)
- Any VPS — just run `npm install && npm start` (set `PORT` env var if needed)

Once deployed, share the URL + a room code with friends and you can all play from your phones.

## Known limitations (worth knowing about)

- **In-memory state only.** All rooms and profiles live in server RAM — restarting the server wipes everyone's stats and active games. Fine for casual play; you'd want a real database (e.g. Redis/Postgres) for anything persistent.
- **No reconnect handling.** If a player's connection drops mid-game, they're treated as having left — they can't currently rejoin the same game session.
- **No spectator/rejoin distinction** — a disconnect during an active game doesn't get them back into the same role.
- **No input sanitization** beyond basic empty-string checks — fine for friends playing casually, but don't expose this publicly without adding validation/rate-limiting if you're worried about abuse.
- **JaaS billing/limits apply.** JaaS has a free tier (participant-minutes based) and paid tiers beyond that — check your usage against your plan in the JaaS console if you expect heavy use.
- **Video tokens are 1 hour long.** If a game session runs longer than that, a player's video may need to reconnect (leaving and rejoining the call) once the token expires. This can be extended in `generateJaasToken` in `server.js` if needed.

## Possible next steps

- Add Detective/Doctor roles for more classic Mafia variety
- Persist stats to a real database
- Add reconnect/rejoin support
- Add a text chat panel alongside video

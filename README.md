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

## Recording (local, per-player, free)

Each player has a **"Record My Camera & Mic"** button, and recording now **starts automatically** the moment they join the video call (no tap required) — they can still tap "Stop & Save" anytime to end it early and download what's captured so far. The video call also goes **fullscreen in portrait orientation** automatically on join, rather than landscape.

- **It records that player's own camera and microphone only** — not the other participants' video, not a composited "everyone in one recording" view. Each player who wants footage needs to tap record themselves and keep their own file.
- **Why not a full call recording?** The obvious approach — recording the whole screen/tab showing everyone — uses a browser API called `getDisplayMedia`. That API is not implemented on Android Chrome or Firefox for Android (it exists in the code but always rejects), so it silently fails on the exact phones most players will likely use. Recording each player's own camera via `getUserMedia` is the option that actually works on mobile.
- **JaaS's own server-side recording** would solve the "one recording with everyone in it" problem properly, but costs $0.01/minute, billed to your JaaS account — there's no way around that cost if you want true full-call recording.
- **Camera conflicts.** Most phones only let one app/tab use the camera at a time. Since recording now starts automatically at the same moment the call connects, this is the most likely failure point — the player may see a "camera busy" error banner right as they join if Jitsi hasn't finished claiming the camera yet. If that happens, they can tap the record button again once the call has fully loaded.
- Recordings save as `.webm` files directly to the player's own device — nothing is uploaded to your server or to JaaS.

If you later want one unified recording with everyone in it and have budget for it, switching to JaaS's native recording is the more direct path — it requires setting `recording: true` in the JWT feature flags in `server.js` (currently `false`) and registering a webhook to retrieve the file within the 24-hour window JaaS stores it for.

## Host controls

The host now has three additional controls beyond starting the game:

- **Kick a player** — a 🚪 button next to each other player's name (visible only to the host) removes them from the room immediately, in both lobby and active-game states.
- **Make host** — a 👑 button transfers host status to another connected player voluntarily, rather than only happening automatically when the host disconnects.
- **Restart the game** — once a game ends, the host sees a "Restart Game" button that resets everyone back to the lobby (roles cleared, everyone alive again) without anyone needing to leave and rejoin the room.

## Reconnection (lightweight, in-memory only)

If a player's connection drops — phone locks, app gets backgrounded, brief network blip — their seat is held for **45 seconds** instead of being removed immediately. During that window:

- Other players see a "RECONNECTING..." tag next to that player's name.
- If they reconnect within the window (same username, same room), they're seamlessly restored: same role, same alive/dead status, same host status if they were host.
- If they don't reconnect in time, they're removed and the game continues without them (with host migration if needed, same as before).

**Important limitation:** this is purely in-memory, scoped to one running server process. It does *not* survive a full server restart — if Render restarts or redeploys your app (which can happen on the free tier after inactivity, or whenever you push new code), all active games and the reconnect state are wiped, same as before. This fix specifically helps with short-lived connection drops during an otherwise-stable server session, not full outages or redeploys. True persistence across restarts would need a real database (e.g. Redis or Postgres) — a bigger step covered in "Possible next steps."

## Deploying so others can join

This needs a real Node host (not static hosting) since it runs a WebSocket server. Easy options:
- [Render](https://render.com) — free tier, connect a GitHub repo, it auto-detects `npm start`
- [Railway](https://railway.app)
- [Fly.io](https://fly.io)
- Any VPS — just run `npm install && npm start` (set `PORT` env var if needed)

Once deployed, share the URL + a room code with friends and you can all play from your phones.

## Known limitations (worth knowing about)

- **In-memory state only.** All rooms, profiles, and reconnect grace windows live in server RAM — a full server restart (Render redeploy, free-tier spin-down, crash) wipes everyone's stats and active games. Fine for casual play; you'd want a real database (e.g. Redis/Postgres) for anything persistent.
- **Reconnect only covers short drops.** The 45-second grace window (see "Reconnection" above) helps with flaky connections or a backgrounded app, but does not survive the server itself restarting.
- **No input sanitization** beyond basic empty-string checks — fine for friends playing casually, but don't expose this publicly without adding validation/rate-limiting if you're worried about abuse.
- **JaaS billing/limits apply.** JaaS has a free tier (participant-minutes based) and paid tiers beyond that — check your usage against your plan in the JaaS console if you expect heavy use.
- **Local recording is per-player, camera/mic only — not a full call recording.** See above for why.
- **Video tokens are 1 hour long.** If a game session runs longer than that, a player's video may need to reconnect (leaving and rejoining the call) once the token expires. This can be extended in `generateJaasToken` in `server.js` if needed.

## Possible next steps

- Add Detective/Doctor roles for more classic Mafia variety
- Persist stats and room state to a real database, so reconnection survives server restarts too
- Add a text chat panel alongside video

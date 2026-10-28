# mcpbridge relay

The hosted half of mcpbridge. Clients anywhere — claude.ai, Claude Desktop, Cursor, Claude
Code — talk MCP to this over HTTPS; it forwards each delegation to the account owner's own
machine over the WebSocket that machine opened with `mcpbridge connect`, and the CLI there
does the work.

**The relay never holds an AI credential.** It sees prompts and answers in transit and
nothing else. There is no Claude, Codex or Gemini sign-in on the server; those stay on the
user's laptop, which is why this can be run for many users without holding anyone's
sessions.

```
 claude.ai · Desktop · Cursor · Claude Code
                 │  HTTPS, client token
                 ▼
        bridge.yourdomain.com  (this)
                 │  WebSocket the laptop opened, agent token
                 ▼
        the user's laptop: mcpbridge connect
                 ├─ claude.exe   (signed in)
                 ├─ codex.exe    (signed in)
                 └─ agy.exe      (signed in)
```

## Run it locally

```bash
npm ci && npm run build        # in the repository root: the relay depends on the CLI package
cd relay && npm ci
SESSION_SECRET=dev PUBLIC_URL=http://localhost:8080 npm run dev
```

Open http://localhost:8080, create an account, generate both tokens, then on the same
machine:

```bash
npx -y mcpbridge connect --relay http://localhost:8080 --token mba_...
```

The dashboard flips to Online and lists the agents it found. The config snippets it shows
are complete; paste them into a client.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `SESSION_SECRET` | yes, in production | signs session cookies; any long random string (`openssl rand -base64 32`) |
| `PUBLIC_URL` | yes, when hosted | the https origin users reach; cookies, CSRF and the Google callback depend on it |
| `DATABASE_PATH` | no | SQLite file, default `./data/relay.sqlite` (`/data/relay.sqlite` in the image) |
| `PORT`, `HOST` | no | default `8080`, `0.0.0.0` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | turns on *Continue with Google* |

For Google: in Google Cloud Console create an OAuth client of type *Web application* with
`https://<PUBLIC_URL host>/auth/google/callback` as an authorised redirect URI, and set the
two variables. Accounts are matched by Google subject, then linked by email — only when
Google reports the address verified.

## Deploy

The repository root has a `Dockerfile` that builds the whole thing and a `fly.toml`. The
image runs as an unprivileged user, keeps its database at `/data`, and answers `/healthz`.

**Fly.io**

```bash
fly launch --no-deploy            # pick an app name and region; keep the generated fly.toml's mounts
fly volumes create data --size 1
fly secrets set SESSION_SECRET=$(openssl rand -base64 32)
# set PUBLIC_URL in fly.toml to https://<app>.fly.dev, or your own domain after `fly certs add`
fly deploy
```

`auto_stop_machines` is off in `fly.toml` on purpose: agents hold a WebSocket open, and a
machine that stops when idle would drop every one of them.

**Railway**

New project → Deploy from GitHub repo. Railway picks up the `Dockerfile`. Add a volume
mounted at `/data`, set `SESSION_SECRET` and `PUBLIC_URL` (Railway gives you the domain),
and deploy. Attach your own domain under Settings → Networking.

**A VPS (Hetzner, DigitalOcean, …)**

```bash
docker build -t mcpbridge-relay .
docker run -d --name relay --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v relay-data:/data \
  -e SESSION_SECRET=$(openssl rand -base64 32) \
  -e PUBLIC_URL=https://bridge.yourdomain.com \
  mcpbridge-relay
```

Put TLS in front with Caddy, which also keeps WebSockets intact:

```
bridge.yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
```

## What a client gets

`POST /mcp` with `Authorization: Bearer mbc_…` is a standard streamable-HTTP MCP server
with four tools: `list_agents`, `ask_agent`, `start_task`, `get_task`. When the account's
machine is not connected every tool says so and says what to run; nothing is queued for
later, because the point is that the machine with the sign-ins is doing the work right now.

Clients that send a header — Claude Code, Claude Desktop via `mcp-remote`, Cursor — work
today. claude.ai in the browser and on the phone register connectors through OAuth rather
than a pasted token; that is the next thing this relay will add, and the account and
token model here is already shaped for it.

## Security model, briefly

- Two tokens per account, stored as hashes only: an **agent** token lets a machine serve
  the account, a **client** token lets a client delegate as it. Different trusts, revoked
  separately. Regenerating the agent token disconnects the machine using the old one.
- One machine per account at a time; a newer connection displaces the older and tells it
  not to retry.
- A call for one account can only reach that account's machine.
- Passwords are scrypt; sessions are HMAC-signed cookies; login is rate-limited per address
  and gives the same answer for a wrong password and an unknown account; cookie-authenticated
  POSTs from a foreign Origin are refused.
- 2-step verification is TOTP (any authenticator app) with ten single-use recovery codes.
  A code cannot be replayed inside its window, and turning 2FA off needs a current code.

## Tests

```bash
cd relay && npm test
```

The suite runs the real `mcpbridge connect` code from the CLI package against the real
relay with a real MCP client, so a delegation is exercised client → relay → agent → CLI
and back, alongside the account, token, 2FA and Google flows.

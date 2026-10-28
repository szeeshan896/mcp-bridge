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
                 │  HTTPS, OAuth sign-in or client token
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

New project → Deploy from GitHub repo. The repository's `railway.json` tells Railway to
build the `Dockerfile`, check `/healthz`, and keep one replica (agents hold a WebSocket to
it, so two would split them). Then, in the service:

1. *Variables*: `SESSION_SECRET` (any long random string) and `PUBLIC_URL`
   (`https://your-domain`, or the `*.up.railway.app` domain Railway generates).
2. *Volume*: attach one mounted at `/data`.
3. *Settings → Networking*: generate a domain, or add your own and create the CNAME
   Railway shows at your DNS provider. With Cloudflare, keep that record **DNS only**
   (grey cloud) so Railway terminates TLS; the proxied mode also works with Cloudflare's
   SSL mode set to *Full (strict)*, but adds nothing here.

Hobby plan services run in the US regions; the Pro plan adds Singapore and others. A
delegation takes seconds to minutes, so the extra round-trip time barely registers.

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

`POST /mcp` is a standard streamable-HTTP MCP server with four tools: `list_agents`,
`ask_agent`, `start_task`, `get_task`. When the account's machine is not connected every
tool says so and says what to run; nothing is queued for later, because the point is that
the machine with the sign-ins is doing the work right now.

A client proves which account it speaks for in one of two ways:

- **OAuth sign-in** — what claude.ai (web, desktop app, phone) and Claude Code do. The
  client discovers this relay as an authorization server, the person signs in here and
  clicks *Allow*, and the client gets tokens of its own. Nothing to paste.
- **A client token** — `Authorization: Bearer mbc_…` from the dashboard, for clients that
  take a fixed header: Claude Desktop via `mcp-remote`, Cursor, scripts.

### Connecting claude.ai

In claude.ai go to **Customize → Connectors → Add custom connector**, enter
`https://<your relay>/mcp` as the server URL and leave the OAuth client fields empty, then
click **Connect**. The browser lands on this relay's sign-in page (or straight on the
consent page when already signed in), and *Allow* sends it back to claude.ai with the
connector live. Switch it on per chat from the **+ → Connectors** menu; the same connector
is available in the desktop app and on the phone once signed in to the same claude.ai
account. The dashboard's *Connected apps* table lists every such sign-in and can
disconnect any of them, which invalidates its tokens at once.

Claude Code: `claude mcp add -s user --transport http mcpbridge https://<your relay>/mcp`,
then `/mcp` inside Claude Code to sign in. It catches the redirect on a loopback port,
which the relay allows for a registered loopback address on any port, as Claude Code's
published client metadata requires.

### What the relay implements for that

OAuth 2.1 as the MCP authorization spec profiles it, with nothing beyond what the two
Claude clients need:

| Endpoint | Role |
|---|---|
| `/.well-known/oauth-protected-resource` (also `…/mcp`) | RFC 9728 — names `…/mcp` as the resource and this relay as its authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — the endpoints below, S256 PKCE, public clients allowed, metadata-document clients supported |
| `POST /oauth/register` | RFC 7591 dynamic registration: https redirect URIs, or http on the loopback; a secret only if the client asks for one; rate-limited per address |
| `GET`/`POST /oauth/authorize` | the consent page, behind the normal sign-in (password, Google, 2-step); approve or cancel |
| `POST /oauth/token` | `authorization_code` with PKCE, and `refresh_token` with rotation; form-encoded, errors per RFC 6749 |
| `POST /oauth/revoke` | RFC 7009 |

A client_id that is an https URL is treated as a Client ID Metadata Document: the relay
fetches it (10 s, 64 KB, cached an hour), requires the document to name that same
`client_id`, and takes its redirect URIs from there. That is how Claude's *Use Claude's
published identity* option works without any registration.

Unauthenticated calls to `/mcp` get a `401` whose `WWW-Authenticate` header carries
`resource_metadata`, which is how a client finds all of the above; a presented token that
is expired or revoked adds `error="invalid_token"`, which is what tells claude.ai to
refresh rather than re-prompt.

## Security model, briefly

- Two tokens per account, stored as hashes only: an **agent** token lets a machine serve
  the account, a **client** token lets a client delegate as it. Different trusts, revoked
  separately. Regenerating the agent token disconnects the machine using the old one.
- OAuth tokens are opaque random strings stored as hashes too, one pair per approval.
  Access tokens last an hour, refresh tokens thirty days and rotate on every use, so a
  stolen refresh token stops working the moment the real client refreshes. An
  authorization code is single-use, expires in ten minutes, and is bound to its PKCE
  challenge, its client and its redirect URI; a failed exchange burns it. A request is
  never redirected to an address the client did not register — an error page is the
  answer until the client and its redirect URI check out. Approving needs a signed-in
  session and a same-origin POST, so a foreign page cannot click *Allow* for you.
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
and back, alongside the account, token, 2FA and Google flows. The OAuth tests drive the
MCP SDK's own client through discovery, registration, consent, the code exchange, a
delegation, a refresh and a revocation — the same code path claude.ai's client walks.

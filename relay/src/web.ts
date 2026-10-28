import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  accountSummary, clearSessionCookie, currentUser, pendingUser, setPendingCookie, setSessionCookie, type ApiContext,
} from './api.js';
import { hashToken, newId, signSession, verifySession } from './auth.js';
import { authorizationUrl, callbackUrl, exchangeCode, newState, pkcePair, type GoogleConfig as GoogleCreds } from './google.js';
import { cookieHeader, parseCookies, redirect, sendHtml } from './http.js';
import { normalizeUsername } from './identity.js';

export interface GoogleConfig extends GoogleCreds {
  exchange?: typeof exchangeCode;
}

const OAUTH_COOKIE = 'mcpbridge_oauth';
const OAUTH_TTL_MS = 10 * 60 * 1000;

/** Browser-facing pages and the Google redirect dance. Everything else is the JSON API. */
export async function handleWeb(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
  google: GoogleConfig | undefined,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://relay');
  const user = currentUser(req, ctx);

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /':
      if (user) return redirect(res, '/dashboard');
      return sendHtml(res, 200, landingPage(Boolean(google)));

    case 'GET /login/2fa':
      if (!pendingUser(req, ctx)) return redirect(res, '/');
      return sendHtml(res, 200, twoFactorPage());

    case 'GET /dashboard': {
      if (!user) return redirect(res, '/');
      const base = ctx.publicUrl ?? `http://${req.headers.host ?? 'localhost'}`;
      return sendHtml(res, 200, dashboardPage(accountSummary(user, ctx), base, Boolean(google)));
    }

    case 'POST /logout':
      clearSessionCookie(res, ctx);
      return redirect(res, '/');

    case 'GET /auth/google': {
      if (!google) return sendHtml(res, 404, page('Not available', '<p>Sign in with Google is not configured on this relay.</p>'));
      if (!ctx.publicUrl) return sendHtml(res, 500, page('Not configured', '<p>PUBLIC_URL must be set for Google sign-in.</p>'));
      const state = newState();
      const { verifier, challenge } = pkcePair();
      res.setHeader('Set-Cookie', cookieHeader(
        OAUTH_COOKIE, signSession(`${state}~${verifier}`, ctx.sessionSecret, Date.now(), OAUTH_TTL_MS),
        { secure: ctx.secureCookies, maxAgeSeconds: OAUTH_TTL_MS / 1000 },
      ));
      return redirect(res, authorizationUrl(google, callbackUrl(ctx.publicUrl), state, challenge));
    }

    case 'GET /auth/google/callback': {
      if (!google || !ctx.publicUrl) return redirect(res, '/');
      const stored = verifySession(parseCookies(req)[OAUTH_COOKIE], ctx.sessionSecret);
      const [state, verifier] = (stored ?? '').split('~');
      const code = url.searchParams.get('code');
      if (!state || !verifier || !code || url.searchParams.get('state') !== state) {
        return sendHtml(res, 400, page('Sign-in failed', '<p>The sign-in attempt did not match. <a href="/">Try again</a>.</p>'));
      }
      const exchange = google.exchange ?? exchangeCode;
      let identity;
      try {
        identity = await exchange(google, callbackUrl(ctx.publicUrl), code, verifier);
      } catch (error) {
        ctx.log(`google sign-in failed: ${(error as Error).message}`);
        return sendHtml(res, 502, page('Sign-in failed', '<p>Google did not complete the sign-in. <a href="/">Try again</a>.</p>'));
      }
      // linking by email is only safe when Google vouches for the address; otherwise anyone
      // with an unverified Google account at that address could take over the account here
      if (!identity.emailVerified) {
        return sendHtml(res, 403, page('Sign-in refused', '<p>Google has not verified that email address, so it cannot be used to sign in here.</p>'));
      }
      const clearOauth = cookieHeader(OAUTH_COOKIE, '', { secure: ctx.secureCookies, maxAgeSeconds: 0 });

      let account = ctx.db.findUserByGoogleSub(identity.sub);
      if (!account) {
        const username = normalizeUsername(identity.email);
        if (!username) return sendHtml(res, 400, page('Sign-in failed', '<p>That Google account has no usable email address.</p>'));
        const existing = ctx.db.findUserByUsername(username.value);
        if (existing) {
          ctx.db.linkGoogle(existing.id, identity.sub);
          account = ctx.db.findUserById(existing.id)!;
        } else {
          account = ctx.db.createUser({ id: newId(), username: username.value, usernameType: username.type, googleSub: identity.sub });
        }
      }

      if (account.totpEnabledAt !== null) {
        setPendingCookie(res, account.id, ctx);
        res.setHeader('Set-Cookie', [...([] as string[]).concat(res.getHeader('Set-Cookie') as string[]), clearOauth]);
        return redirect(res, '/login/2fa');
      }
      setSessionCookie(res, account.id, ctx);
      res.setHeader('Set-Cookie', [...([] as string[]).concat(res.getHeader('Set-Cookie') as string[]), clearOauth]);
      return redirect(res, '/dashboard');
    }

    default:
      return sendHtml(res, 404, page('Not found', '<p>Nothing here. <a href="/">Home</a>.</p>'));
  }
}

// ---- rendering ---------------------------------------------------------------

export function esc(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--muted:#9aa3b2;--accent:#7aa2ff;--ok:#5ad38a;--bad:#ff7a7a;--warn:#ffcc66}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 24px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:12px 0}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#0b0d12;color:var(--text);font-size:15px}
button{margin-top:12px;padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#0b0d12;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:640px){.row{grid-template-columns:1fr}}
pre,code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre{background:#0b0d12;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}.err{color:var(--bad);min-height:1.4em;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.token{background:#0b0d12;border:1px dashed var(--accent);border-radius:8px;padding:10px 12px;margin-top:10px;display:none}.qr svg{width:180px;height:180px;background:#fff;padding:6px;border-radius:8px}
.google{display:inline-block;margin-top:12px;padding:9px 14px;border:1px solid var(--line);border-radius:8px;color:var(--text);text-decoration:none}
`;

const SCRIPT = `
async function post(path, body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function wire(form, path, after){form.addEventListener('submit',async e=>{e.preventDefault();const err=form.querySelector('.err');err.textContent='';const body=Object.fromEntries(new FormData(form));try{after(await post(path,body))}catch(x){err.textContent=x.message}})}
`;

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · mcpbridge</title><style>${STYLE}</style></head><body><main>${body}</main><script>${SCRIPT}${script}</script></body></html>`;
}

function landingPage(googleEnabled: boolean): string {
  const google = googleEnabled ? `<a class="google" href="/auth/google">Continue with Google</a>` : '';
  return page('Sign in', `
<h1>mcpbridge</h1>
<p class="sub">Delegate work between your AI agents from anywhere — the work runs on your own machine, where they are signed in.</p>
<div class="row">
  <div class="panel"><h2 style="margin-top:0">Sign in</h2>
    <form id="login"><label>Email or phone</label><input name="username" autocomplete="username" required>
    <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
    <div class="err"></div><button>Sign in</button></form>${google}</div>
  <div class="panel"><h2 style="margin-top:0">Create an account</h2>
    <form id="signup"><label>Email or phone</label><input name="username" autocomplete="username" required>
    <label>Password <span class="muted">(8+ characters)</span></label><input name="password" type="password" autocomplete="new-password" minlength="8" required>
    <div class="err"></div><button>Create account</button></form></div>
</div>`, `
wire(document.getElementById('login'),'/api/login',j=>{location.href=j.twoFactorRequired?'/login/2fa':'/dashboard'});
wire(document.getElementById('signup'),'/api/signup',()=>{location.href='/dashboard'});`);
}

function twoFactorPage(): string {
  return page('2-step verification', `
<h1>2-step verification</h1><p class="sub">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
<div class="panel"><form id="f"><label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required>
<div class="err"></div><button>Continue</button></form></div>`, `
wire(document.getElementById('f'),'/api/login/2fa',()=>{location.href='/dashboard'});`);
}

type Summary = ReturnType<typeof accountSummary>;

function dashboardPage(me: Summary, base: string, googleEnabled: boolean): string {
  const host = base.replace(/\/$/, '');
  const device = me.device.online
    ? `<p><span class="ok">● Online</span> — <b>${esc(me.device.name)}</b> <span class="muted">(agent ${esc(me.device.agentVersion)}, since ${new Date(me.device.connectedAt).toLocaleString()})</span></p>
       <table><tr><th>Agent</th><th>Status</th><th>Detail</th></tr>${me.device.agents
         .map((a) => `<tr><td><code>${esc(a.name)}</code>${a.readsFiles ? '' : ' <span class="muted">(no file access)</span>'}</td><td class="${a.available ? 'ok' : 'bad'}">${a.available ? 'available' : 'unavailable'}</td><td class="muted">${esc(a.detail)}</td></tr>`)
         .join('')}</table>`
    : `<p><span class="bad">● Offline</span> — no machine is connected. On the computer where your AI CLIs are signed in, run the <b>connect</b> command below.</p>`;

  const tokenRow = (kind: 'agent' | 'client', title: string, blurb: string) => {
    const info = me.tokens[kind];
    return `<div class="panel"><h2 style="margin-top:0">${title}</h2><p class="muted" style="margin:0 0 6px">${blurb}</p>
      <p class="muted">${info ? `Created ${new Date(info.createdAt).toLocaleString()}${info.lastUsedAt ? `, last used ${new Date(info.lastUsedAt).toLocaleString()}` : ', never used yet'}` : 'No token yet.'}</p>
      <button class="secondary" data-token="${kind}">${info ? 'Regenerate' : 'Generate'} ${kind} token</button>
      <div class="token" id="tok-${kind}"><div class="muted">Shown once — copy it now.</div><code id="tok-${kind}-value"></code></div></div>`;
  };

  const twoFactor = me.twoFactorEnabled
    ? `<p><span class="ok">On.</span> ${me.recoveryCodesLeft} recovery code${me.recoveryCodesLeft === 1 ? '' : 's'} left.</p>
       <form id="disable"><label>Current code (to turn it off or get new recovery codes)</label><input name="code" inputmode="numeric" autocomplete="one-time-code">
       <div class="err"></div><button class="danger" type="submit">Turn off</button> <button class="secondary" type="button" id="newcodes">New recovery codes</button></form><pre id="codes" style="display:none"></pre>`
    : `<p class="warn">Off.</p><button class="secondary" id="setup">Set up with an authenticator app</button>
       <div id="enrol" style="display:none"><p>Scan this in Google Authenticator, Authy, 1Password or similar, then enter the code it shows.</p>
       <div class="qr" id="qr"></div><p class="muted">Or enter the secret by hand: <code id="secret"></code></p>
       <form id="enable"><label>Code from the app</label><input name="code" inputmode="numeric" autocomplete="one-time-code"><div class="err"></div><button>Turn on</button></form>
       <pre id="codes" style="display:none"></pre></div>`;

  const snippets = `
<h2>Connect your machine</h2><p class="muted">Run this where your AI CLIs are signed in. It stays running and reconnects on its own.</p>
<pre>npx -y mcpbridge connect --relay ${esc(host)} --token <span data-fill="agent">&lt;agent token&gt;</span></pre>
<h2>Connect your clients</h2>
<p class="muted">Claude Code — from any folder:</p>
<pre>claude mcp add -s user --transport http mcpbridge ${esc(host)}/mcp --header "Authorization: Bearer <span data-fill="client">&lt;client token&gt;</span>"</pre>
<p class="muted">Claude Desktop — add to <code>claude_desktop_config.json</code>:</p>
<pre>{ "mcpServers": { "mcpbridge": { "command": "npx", "args": ["-y", "mcp-remote", "${esc(host)}/mcp", "--header", "Authorization: Bearer <span data-fill="client">&lt;client token&gt;</span>"] } } }</pre>
<p class="muted">Cursor — <code>.cursor/mcp.json</code>:</p>
<pre>{ "mcpServers": { "mcpbridge": { "url": "${esc(host)}/mcp", "headers": { "Authorization": "Bearer <span data-fill="client">&lt;client token&gt;</span>" } } } }</pre>
<p class="muted">claude.ai (web and phone) needs OAuth on the connector side; that is the next thing this relay will support.</p>`;

  return page('Dashboard', `
<h1>mcpbridge</h1><p class="sub">${esc(me.username)}${me.googleLinked ? ' · Google linked' : ''}${googleEnabled && !me.googleLinked ? ' · <a href="/auth/google">link Google</a>' : ''} · <form method="post" action="/logout" style="display:inline"><button class="secondary" style="margin:0;padding:2px 8px">Sign out</button></form></p>
<div class="panel"><h2 style="margin-top:0">Your machine</h2>${device}</div>
<div class="row">${tokenRow('agent', 'Agent token', 'Lets a machine serve your account. Keep it on that machine only.')}${tokenRow('client', 'Client token', 'Lets a client delegate as you. Put it in Claude Code, Desktop or Cursor.')}</div>
<div class="panel"><h2 style="margin-top:0">2-step verification</h2>${twoFactor}</div>
${snippets}`, `
for(const b of document.querySelectorAll('[data-token]'))b.addEventListener('click',async()=>{const k=b.dataset.token;try{const j=await post('/api/tokens/'+k);document.getElementById('tok-'+k+'-value').textContent=j.token;document.getElementById('tok-'+k).style.display='block';for(const s of document.querySelectorAll('[data-fill="'+k+'"]'))s.textContent=j.token}catch(x){alert(x.message)}});
const setup=document.getElementById('setup');if(setup)setup.addEventListener('click',async()=>{try{const j=await post('/api/2fa/setup');document.getElementById('qr').innerHTML=j.qrSvg;document.getElementById('secret').textContent=j.secret;document.getElementById('enrol').style.display='block';setup.style.display='none'}catch(x){alert(x.message)}});
const enable=document.getElementById('enable');if(enable)wire(enable,'/api/2fa/enable',j=>{const c=document.getElementById('codes');c.textContent='Recovery codes (shown once):\\n'+j.recoveryCodes.join('\\n');c.style.display='block';enable.style.display='none'});
const disable=document.getElementById('disable');if(disable){wire(disable,'/api/2fa/disable',()=>location.reload());document.getElementById('newcodes').addEventListener('click',async()=>{const code=disable.querySelector('[name=code]').value;try{const j=await post('/api/2fa/recovery-codes',{code});const c=document.getElementById('codes');c.textContent='New recovery codes (shown once):\\n'+j.recoveryCodes.join('\\n');c.style.display='block'}catch(x){disable.querySelector('.err').textContent=x.message}})}`);
}

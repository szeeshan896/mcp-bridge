/**
 * The control panel, as one self-contained page: no build step, no external requests
 * (the Content-Security-Policy forbids them), and every value from the server is set with
 * textContent, never innerHTML, so an agent's output or a provider's error text cannot
 * become markup.
 */
export function uiPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mcpbridge · this computer</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div><h1>mcpbridge</h1><div class="sub">on this computer · <span id="configFile"></span></div></div>
    <button class="ghost" id="refresh" type="button">Refresh</button>
  </header>
  <div id="configError" class="banner bad" hidden></div>

  <section class="panel">
    <div class="row-head"><h2>Relay connection</h2><span id="connPill" class="pill">…</span></div>
    <p class="muted" id="connDetail"></p>
    <form id="relayForm" autocomplete="off">
      <div class="grid3">
        <label>Relay address<input name="url" placeholder="https://mcpbridge.app" required></label>
        <label>Agent token <a href="#" id="tokenHelp" class="hint">where is it?</a><input name="token" type="password" placeholder="mba_…"></label>
        <label>Device name <span class="hint">optional</span><input name="device" placeholder="this computer's name"></label>
      </div>
      <div class="actions">
        <button type="submit">Save &amp; connect</button>
        <button type="button" class="ghost" id="connectBtn">Connect</button>
        <button type="button" class="ghost" id="disconnectBtn">Disconnect</button>
        <span class="err" id="relayErr"></span>
      </div>
    </form>
    <details><summary>Connection log</summary><pre id="connLog"></pre></details>
  </section>

  <section class="panel">
    <h2>Agents</h2>
    <p class="muted">What the relay offers your AI apps. <b>Test</b> sends a one-word prompt, so it spends a tiny amount of a paid key.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Agent</th><th>Status</th><th>Detail</th><th></th></tr></thead>
      <tbody id="agents"></tbody>
    </table></div>
  </section>

  <section class="panel">
    <h2 id="formTitle">Add an agent</h2>
    <form id="agentForm" autocomplete="off">
      <label>Start from<select name="preset" id="preset"></select></label>
      <p class="note" id="presetNote" hidden></p>
      <div class="grid2">
        <label>Name <span class="hint">how your AI apps will call it</span><input name="name" required pattern="[a-z0-9][a-z0-9_\\-]{0,31}"></label>
        <label>Description<input name="description"></label>
      </div>
      <div data-kind="openai ollama">
        <div class="grid2">
          <label data-kind="openai ollama">Base URL<input name="baseUrl"></label>
          <label data-kind="openai">API key <a id="keyLink" class="hint" target="_blank" rel="noopener noreferrer" hidden>get a key</a>
            <input name="apiKey" type="password" placeholder="paste it here; stored on this computer only"></label>
        </div>
        <div class="grid2">
          <label>Model
            <input name="model" placeholder="type an id, or list the models and pick one"></label>
          <label id="modelPick" hidden>Models this key can reach
            <select id="modelSelect"></select></label>
        </div>
        <div class="grid2">
          <div class="inline-actions" data-kind="openai"><button type="button" class="ghost" id="fetchModels">List models</button><span class="muted" id="modelsInfo"></span></div>
        </div>
        <div id="modelMulti" class="multi" hidden>
          <div class="row-head"><b>Add several models at once</b><span class="muted" id="multiCount"></span></div>
          <p class="hint">Each ticked model becomes its own agent with the same key, named after the model, so adding one never replaces another.</p>
          <input id="multiFilter" placeholder="filter, e.g. deepseek, gemma, coder">
          <div id="multiList" class="checks"></div>
          <div class="actions"><button type="button" id="saveMany" disabled>Add ticked models</button><span class="err" id="multiErr"></span><span class="ok" id="multiOk"></span></div>
        </div>
        <label data-kind="openai">Key variable <span class="hint">the name the key is saved under</span><input name="apiKeyEnv" placeholder="e.g. NVIDIA_API_KEY"></label>
      </div>
      <div data-kind="cli">
        <label>Command <span class="hint">one argument per line; {prompt} marks where the prompt goes</span><textarea name="command" rows="4"></textarea></label>
        <label>Prompt goes in<select name="promptVia"><option value="argv">the command line ({prompt})</option><option value="stdin">standard input</option></select></label>
        <fieldset id="allowBox"><legend>What it may do when a client asks it — off means it reads and reports only</legend>
          <label class="check"><input type="checkbox" name="allowEdits"> Change files in the working directory</label>
          <label class="check"><input type="checkbox" name="allowCommands"> Run commands there, such as tests and builds</label>
          <label class="check" id="trustRow"><input type="checkbox" name="allowTrust"> Trust the working directory it is sent to</label>
          <p class="hint" id="allowNote"></p>
          <p class="hint">Any app connected to your relay can ask this agent for work. Allow only what you are happy for those apps to have done on this computer.</p>
        </fieldset>
      </div>
      <label>Timeout, seconds <span class="hint">optional</span><input name="timeoutSeconds" type="number" min="1" max="3600"></label>
      <div class="actions">
        <button type="submit">Save agent</button>
        <button type="button" class="ghost" id="resetForm">Clear</button>
        <span class="err" id="agentErr"></span><span class="ok" id="agentOk"></span>
      </div>
    </form>
  </section>

  <p class="foot muted">Keys and the agent token are saved in <code id="secretsFile"></code>, never in config.json and never sent to the relay. Close this terminal window and the page stops; the connection stops with it.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
:root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--muted:#9aa3b2;--accent:#7aa2ff;--ok:#5ad38a;--bad:#ff7a7a;--warn:#ffcc66}
[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 48px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
h1{font-size:24px;margin:0}h2{font-size:17px;margin:0 0 8px}.sub,.muted,.hint{color:var(--muted)}.sub{font-size:13px;word-break:break-all}.hint{font-size:12px;font-weight:400}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:14px 0}
.row-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 0}input,select,textarea{display:block;width:100%;margin-top:4px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#0b0d12;color:var(--text);font:14px system-ui,sans-serif}
textarea{font:13px ui-monospace,Menlo,Consolas,monospace}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.grid3{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:0 14px}
@media(max-width:720px){.grid2,.grid3{grid-template-columns:1fr}}
button{padding:8px 14px;border:0;border-radius:8px;background:var(--accent);color:#0b0d12;font-weight:600;cursor:pointer;font-size:14px}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}button.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
button:disabled{opacity:.5;cursor:wait}button.small{padding:4px 10px;font-size:13px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}.inline-actions{display:flex;align-items:flex-end;gap:8px;margin-top:10px}
.err{color:var(--bad);font-size:14px}.ok{color:var(--ok);font-size:14px}
.pill{font-size:13px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}.pill.on{color:var(--ok);border-color:var(--ok)}.pill.off{color:var(--bad);border-color:var(--bad)}.pill.wait{color:var(--warn);border-color:var(--warn)}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
td.detail{color:var(--muted);word-break:break-word;font-size:13px}td.btns{white-space:nowrap;text-align:right}td.btns button{margin-left:4px}
.tag{white-space:nowrap;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-left:6px}
.result{margin-top:6px;padding:8px 10px;border-radius:8px;background:#0b0d12;border:1px solid var(--line);white-space:pre-wrap;font:13px ui-monospace,Menlo,Consolas,monospace;color:var(--text)}
.result.bad{border-color:var(--bad)}.result.good{border-color:var(--ok)}
fieldset{border:1px solid var(--line);border-radius:8px;margin:12px 0 0;padding:8px 12px}legend{color:var(--muted);font-size:13px;padding:0 4px}
.multi{border:1px solid var(--line);border-radius:8px;margin:12px 0 0;padding:10px 12px}
.checks{max-height:260px;overflow:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:4px 8px}
.checks label.check{justify-content:space-between;padding:3px 0}.checks .hint{margin-left:auto;text-align:right}
label.check{display:flex;align-items:center;gap:8px;color:var(--text);font-size:14px}label.check input{width:auto;margin:0}
.note{background:#1d2230;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--muted);margin:10px 0 0}
.banner{padding:10px 14px;border-radius:8px;margin:10px 0}.banner.bad{background:#2a1414;border:1px solid var(--bad);color:var(--bad)}
pre{background:#0b0d12;border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;font:12px ui-monospace,Menlo,Consolas,monospace;max-height:220px;overflow:auto}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:13px}a{color:var(--accent)}code{font:12px ui-monospace,Menlo,Consolas,monospace;word-break:break-all}.foot{font-size:13px;margin-top:20px}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
let state = null;
let presets = [];
// test results outlive the periodic refresh that rebuilds the table
const results = {};

async function api(path, body) {
  const init = { headers: { 'X-MCPBridge-UI': '1' } };
  if (body !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

async function load() {
  try { state = await api('/api/state'); } catch (e) { $('configError').hidden = false; $('configError').textContent = e.message; return; }
  presets = state.presets;
  $('configFile').textContent = state.configFile;
  $('secretsFile').textContent = state.secretsFile;
  $('configError').hidden = !state.configError;
  $('configError').textContent = state.configError || '';
  renderConnection();
  renderAgents();
  if (!$('preset').options.length) renderPresets();
}

function renderConnection() {
  const c = state.connection, f = $('relayForm');
  const pill = $('connPill');
  const labels = { connected: ['Online', 'on'], connecting: ['Connecting…', 'wait'], reconnecting: ['Reconnecting…', 'wait'], stopped: ['Offline', 'off'] };
  const [text, cls] = labels[c.state];
  pill.textContent = text; pill.className = 'pill ' + cls;
  $('connDetail').textContent =
    c.state === 'connected' ? 'Connected as "' + c.device + '" since ' + new Date(c.since).toLocaleTimeString() + '. Your AI apps can delegate to the agents below.'
    : c.state === 'reconnecting' ? 'Lost the connection (' + c.reason + '); trying again by itself.'
    : c.state === 'connecting' ? 'Opening the connection…'
    : state.relay ? 'Not connected' + (c.reason ? ' (' + c.reason + ')' : '') + '. Press Connect.' : 'Enter the relay address and the agent token from its dashboard, then Save & connect.';
  if (state.relay && document.activeElement?.form !== f) {
    f.url.value = state.relay.url; f.device.value = state.relay.device;
    f.token.placeholder = 'saved ' + state.relay.token + ' — leave empty to keep it';
  } else if (!state.relay && !f.url.value) { f.url.value = 'https://mcpbridge.app'; }
  $('connectBtn').hidden = !state.relay || c.state !== 'stopped';
  $('disconnectBtn').hidden = c.state === 'stopped';
  $('connLog').textContent = state.connectionLog.join('\\n') || 'nothing yet';
}

function renderAgents() {
  const body = $('agents');
  body.replaceChildren();
  for (const a of state.agents) {
    const label = { 'quota-exhausted': '✗ limit reached', 'sign-in-failed': '✗ sign-in failed', 'directory-not-trusted': '✗ folder not trusted' }[a.status];
    const status = el('td', {}, a.available ? el('span', { class: 'ok', text: '✓ ready' }) : el('span', { class: 'err', text: label || '✗ not ready' }),
      el('div', { class: 'hint', text: a.calls ? a.calls + ' call' + (a.calls === 1 ? '' : 's') + (a.lastSuccessAt ? ', last ok ' + new Date(a.lastSuccessAt).toLocaleTimeString() : '') : (a.available ? 'not tried yet' : '') }));
    const may = !a.readsFiles ? 'cannot read files' : (a.writesFiles || a.runsCommands)
      ? 'may ' + [a.writesFiles ? 'edit files' : '', a.runsCommands ? 'run commands' : ''].filter(Boolean).join(' & ')
      : 'read-only';
    const name = el('td', {}, el('b', { text: a.name }), el('span', { class: 'tag', text: a.origin }), el('div', { class: 'hint', text: may + ' · ' + a.timeoutSeconds + ' s limit' }));
    const detail = el('td', { class: 'detail' }, el('div', { text: a.detail }));
    if (a.key) detail.append(el('div', { class: 'hint', text: 'key ' + a.key.env + ': ' + (a.key.saved ? 'saved ' + a.key.saved : a.key.inEnvironment ? 'from the environment' : 'not set') }));
    const result = el('div');
    const show = (cls, text) => { results[a.name] = [cls, text]; result.className = cls; result.textContent = text; };
    if (results[a.name]) { result.className = results[a.name][0]; result.textContent = results[a.name][1]; }
    detail.append(result);
    const btns = el('td', { class: 'btns' });
    const test = el('button', { class: 'ghost small', type: 'button', text: 'Test', onclick: async () => {
      test.disabled = true; show('result', 'asking ' + a.name + '… (a CLI agent can take a minute)');
      try {
        const r = await api('/api/agents/test', { name: a.name });
        show('result ' + (r.succeeded ? 'good' : 'bad'),
          (r.succeeded ? '✓ ' + (r.output || '(empty answer)') : '✗ ' + r.diagnostics) + '\\n' + (r.durationMs / 1000).toFixed(1) + ' s' + (r.notes ? ' · ' + r.notes : ''));
      } catch (e) { show('result bad', e.message); }
      test.disabled = false;
    } });
    btns.append(test);
    btns.append(el('button', { class: 'ghost small', type: 'button', text: a.origin === 'built-in' ? 'Customise' : 'Edit', onclick: () => editAgent(a) }));
    if (a.origin !== 'built-in') {
      btns.append(el('button', { class: 'danger small', type: 'button', text: 'Remove', onclick: async () => {
        if (!confirm('Remove "' + a.name + '" from your config?' + (a.origin === 'override' ? ' The built-in version comes back.' : ''))) return;
        try { await api('/api/agents/remove', { name: a.name }); await load(); } catch (e) { alert(e.message); }
      } }));
    }
    body.append(el('tr', {}, name, status, detail, btns));
  }
}

function renderPresets() {
  const select = $('preset');
  for (const p of presets) select.append(el('option', { value: p.id, text: p.label }));
  applyPreset(presets[0]);
}

function showKind(kind) {
  for (const node of document.querySelectorAll('[data-kind]')) node.hidden = !node.dataset.kind.split(' ').includes(kind);
  // kept apart from data-kind, which marks the fields to show; the form must not hide itself
  $('agentForm').dataset.activeKind = kind;
}

// mirrors the server's naming, to show each agent's name before it is saved
function agentNameFor(prefix, model) {
  const slug = (model.split('/').pop() || model).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const full = prefix + '-' + (slug || 'model');
  if (full.length <= 32) return full;
  const cut = full.slice(0, 32), dash = cut.lastIndexOf('-');
  return (dash > prefix.length ? cut.slice(0, dash) : cut).replace(/[-_]+$/, '');
}
let autoName = null;
let listedModels = [];

function renderMulti() {
  const f = $('agentForm'), q = $('multiFilter').value.trim().toLowerCase();
  const ticked = new Set([...document.querySelectorAll('#multiList input:checked')].map((i) => i.value));
  const prefix = (presets.find((p) => p.id === f.preset.value) || {}).name || f.name.value || 'agent';
  const shown = listedModels.filter((m) => !q || m.toLowerCase().includes(q) || ticked.has(m));
  $('multiList').replaceChildren(...shown.map((m) => {
    const box = el('input', { type: 'checkbox', value: m });
    box.checked = ticked.has(m);
    box.addEventListener('change', countTicked);
    return el('label', { class: 'check' }, box, el('span', { text: m }), el('span', { class: 'hint', text: agentNameFor(prefix, m) }));
  }));
  countTicked();
}
function countTicked() {
  const n = document.querySelectorAll('#multiList input:checked').length;
  $('multiCount').textContent = n ? n + ' ticked' : '';
  $('saveMany').disabled = n === 0;
  $('saveMany').textContent = n ? 'Add ' + n + ' model' + (n === 1 ? '' : 's') + ' as agents' : 'Add ticked models';
}

function applyPreset(p) {
  const f = $('agentForm');
  autoName = null; listedModels = []; $('modelMulti').hidden = true; $('multiFilter').value = ''; $('multiOk').textContent = ''; $('multiErr').textContent = '';
  $('formTitle').textContent = 'Add an agent';
  f.preset.value = p.id; f.name.value = p.name; f.description.value = p.description || '';
  f.baseUrl.value = p.baseUrl || (p.kind === 'ollama' ? '' : ''); f.model.value = p.model || ''; f.apiKeyEnv.value = p.apiKeyEnv || '';
  f.apiKey.value = ''; f.apiKey.placeholder = 'paste it here; stored on this computer only';
  f.command.value = (p.command || []).join('\\n'); f.promptVia.value = p.promptVia || 'argv'; f.timeoutSeconds.value = '';
  $('keyLink').hidden = !p.keyUrl; if (p.keyUrl) $('keyLink').href = p.keyUrl;
  $('presetNote').hidden = !p.note; $('presetNote').textContent = p.note || '';
  $('modelSelect').replaceChildren(); $('modelPick').hidden = true; $('modelsInfo').textContent = '';
  f.allowEdits.checked = false; f.allowCommands.checked = false; f.allowTrust.checked = false;
  showAllow(null, (p.command || [])[0]);
  $('agentErr').textContent = ''; $('agentOk').textContent = '';
  showKind(p.kind);
}

// which switches mean something depends on the CLI; for one the bridge does not know, none do
const KNOWN = { claude: [1, 1, 0, ''], codex: [1, 1, 0, 'For Codex, edits and commands are one sandbox setting: either turns on both.'],
  grok: [1, 1, 0, 'Grok Build approves everything or nothing: either turns on both.'], gemini: [1, 1, 1, 'Allowing commands also allows edits for Gemini CLI.'] };
function showAllow(permissions, executable) {
  let supports = permissions && permissions.supports, note = permissions ? permissions.note : '';
  if (!supports) {
    const first = String(executable || $('agentForm').command.value.split('\\n')[0] || '');
    const exe = first.split(/[\\\\/]/).pop().toLowerCase().replace(/\\.(exe|cmd|bat|ps1)$/, '');
    const k = KNOWN[exe];
    supports = k ? { edits: !!k[0], commands: !!k[1], trustDirectory: !!k[2] } : null; note = k ? k[3] : '';
  }
  $('allowBox').hidden = !supports;
  if (!supports) return;
  $('trustRow').hidden = !supports.trustDirectory;
  $('allowNote').textContent = note;
}

function editAgent(a) {
  const f = $('agentForm'), c = a.config || {};
  const kind = c.type === 'openai' ? 'openai' : c.type === 'ollama' ? 'ollama' : 'cli';
  const preset = presets.find((p) => p.kind === kind && p.id.startsWith('custom')) || presets.find((p) => p.kind === kind);
  applyPreset(preset);
  $('formTitle').textContent = 'Edit ' + a.name;
  $('modelMulti').hidden = true;
  f.name.value = a.name; f.description.value = c.description || '';
  f.baseUrl.value = c.baseUrl || ''; f.model.value = c.model || ''; f.apiKeyEnv.value = c.apiKeyEnv || '';
  if (a.key && a.key.saved) f.apiKey.placeholder = 'saved ' + a.key.saved + ' — leave empty to keep it';
  f.command.value = (c.command || []).join('\\n'); f.promptVia.value = c.promptVia || 'argv';
  f.timeoutSeconds.value = c.timeoutMs ? Math.round(c.timeoutMs / 1000) : '';
  const allow = c.allow || {};
  f.allowEdits.checked = !!allow.edits; f.allowCommands.checked = !!allow.commands; f.allowTrust.checked = !!allow.trustDirectory;
  showAllow(a.permissions);
  f.scrollIntoView({ behavior: 'smooth' });
}

$('agentForm').command.addEventListener('input', () => showAllow(null));
$('modelSelect').addEventListener('change', (e) => {
  const f = $('agentForm');
  f.model.value = e.target.value;
  // adding, not editing: name it after the model, unless the person typed a name of their own
  const preset = presets.find((p) => p.id === f.preset.value);
  if ($('formTitle').textContent.startsWith('Add') && preset && (f.name.value === preset.name || f.name.value === autoName)) {
    autoName = agentNameFor(preset.name, e.target.value);
    f.name.value = autoName;
  }
});
$('multiFilter').addEventListener('input', renderMulti);
$('saveMany').addEventListener('click', async () => {
  const f = $('agentForm'), btn = $('saveMany');
  const models = [...document.querySelectorAll('#multiList input:checked')].map((i) => i.value);
  const prefix = (presets.find((p) => p.id === f.preset.value) || {}).name || f.name.value;
  $('multiErr').textContent = ''; $('multiOk').textContent = '';
  btn.disabled = true;
  try {
    const r = await api('/api/agents/save-many', { name: prefix, kind: 'openai', models, baseUrl: f.baseUrl.value,
      apiKeyEnv: f.apiKeyEnv.value, apiKey: f.apiKey.value, description: f.description.value });
    $('multiOk').textContent = '✓ added ' + r.saved.join(', ') + ' — press Test on each below';
    for (const i of document.querySelectorAll('#multiList input:checked')) i.checked = false;
    await load();
  } catch (e) { $('multiErr').textContent = e.message; }
  countTicked();
});
$('preset').addEventListener('change', (e) => applyPreset(presets.find((p) => p.id === e.target.value)));
$('resetForm').addEventListener('click', () => applyPreset(presets.find((p) => p.id === $('preset').value) || presets[0]));
$('refresh').addEventListener('click', async () => { await api('/api/reload', {}).catch(() => {}); await load(); });
$('tokenHelp').addEventListener('click', (e) => { e.preventDefault(); alert('Open your relay (for example https://mcpbridge.app), sign in, and press "Generate agent token" on the dashboard. It starts with mba_ and is shown once.'); });

$('fetchModels').addEventListener('click', async () => {
  const f = $('agentForm'), btn = $('fetchModels');
  btn.disabled = true; $('modelsInfo').textContent = 'asking the provider…';
  try {
    const r = await api('/api/models', { baseUrl: f.baseUrl.value, apiKey: f.apiKey.value, apiKeyEnv: f.apiKeyEnv.value });
    // a real select, not a datalist: a datalist only offers what matches the text already
    // in the field, so a pre-filled model hid every other choice
    const current = f.model.value;
    const options = r.models.map((m) => el('option', { value: m, text: m }));
    if (current && !r.models.includes(current)) options.unshift(el('option', { value: current, text: current + '  (not listed by the provider)' }));
    $('modelSelect').replaceChildren(...options);
    if (current) $('modelSelect').value = current;
    $('modelPick').hidden = false;
    $('modelsInfo').textContent = r.models.length + ' models — choose one below';
    listedModels = r.models;
    $('modelMulti').hidden = !$('formTitle').textContent.startsWith('Add');
    renderMulti();
    if (!f.model.value && r.models.length) f.model.value = r.models[0];
  } catch (e) { $('modelsInfo').textContent = e.message; }
  btn.disabled = false;
});

$('agentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, kind = f.dataset.activeKind;
  $('agentErr').textContent = ''; $('agentOk').textContent = '';
  const body = { name: f.name.value, kind, description: f.description.value };
  if (f.timeoutSeconds.value) body.timeoutMs = Number(f.timeoutSeconds.value) * 1000;
  if (kind === 'openai') Object.assign(body, { baseUrl: f.baseUrl.value, model: f.model.value, apiKeyEnv: f.apiKeyEnv.value, apiKey: f.apiKey.value });
  if (kind === 'ollama') Object.assign(body, { baseUrl: f.baseUrl.value, model: f.model.value });
  if (kind === 'cli') Object.assign(body, { command: f.command.value.split('\\n').map((s) => s.trim()).filter(Boolean), promptVia: f.promptVia.value,
    allow: { edits: f.allowEdits.checked, commands: f.allowCommands.checked, trustDirectory: f.allowTrust.checked } });
  // saving under a name already in use replaces that agent; say so before it happens
  const existing = state.agents.find((a) => a.name === f.name.value.trim().toLowerCase());
  if (existing && $('formTitle').textContent.startsWith('Add')) {
    const what = existing.origin === 'built-in' ? 'This replaces the built-in "' + existing.name + '" with your version.'
      : 'An agent named "' + existing.name + '" already exists' + (existing.config && existing.config.model ? ' (' + existing.config.model + ')' : '') + ' and will be replaced.';
    if (!confirm(what + ' Continue? To keep both, cancel and change the name.')) return;
  }
  try {
    const r = await api('/api/agents/save', body);
    $('agentOk').textContent = '✓ saved "' + r.saved + '" — press Test on it below' + (state.connection.state !== 'stopped' ? '; the relay already has it' : '');
    f.apiKey.value = '';
    await load();
  } catch (err) { $('agentErr').textContent = err.message; }
});

$('relayForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; $('relayErr').textContent = '';
  try { await api('/api/relay/save', { url: f.url.value, token: f.token.value, device: f.device.value }); f.token.value = ''; await load(); }
  catch (err) { $('relayErr').textContent = err.message; }
});
$('connectBtn').addEventListener('click', async () => { $('relayErr').textContent = ''; try { await api('/api/relay/connect', {}); await load(); } catch (e) { $('relayErr').textContent = e.message; } });
$('disconnectBtn').addEventListener('click', async () => { try { await api('/api/relay/disconnect', {}); await load(); } catch (e) { $('relayErr').textContent = e.message; } });

load();
setInterval(() => { if (!document.hidden && !document.activeElement?.closest('form')) load(); }, 4000);
`;

import { api, fmt, state, getRange, sinceIso } from '/web/app.js';

export default async function (root) {
  const id = decodeURIComponent(location.hash.split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

const PREVIEW_LEN = 110;

// ---------- shared helpers ----------

function durationFmt(startTs, endTs) {
  if (!startTs || !endTs) return '—';
  const ms = new Date(endTs) - new Date(startTs);
  if (!(ms >= 0)) return '—';

  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return totalSec + 's';

  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return totalMin + 'm ' + (totalSec % 60) + 's';

  const hours = Math.floor(totalMin / 60);
  return hours + 'h ' + (totalMin % 60) + 'm';
}

function modelBadges(models) {
  const names = [...new Set(
    (Array.isArray(models) ? models : String(models || '').split(','))
      .filter(m => m && m !== '<synthetic>')
  )];
  return names.map(m =>
    `<span class="badge ${fmt.modelClass(m)}">${fmt.htmlSafe(fmt.modelShort(m))}</span>`
  ).join(' ');
}

// Slash-command records are stored as raw tag markup; show them as a chip
// instead of the XML.
function commandOf(text) {
  const m = /^<command-name>([^<]+)<\/command-name>/.exec(text || '');
  if (m) return m[1].trim();
  if ((text || '').startsWith('<local-command')) return 'command output';
  return null;
}

function agentLabel(a) {
  if (a.kind === 'compact') return 'compaction';
  if (a.kind === 'side_question') return 'side question';
  return a.subagent_type || ('agent ' + (a.agent_id || '?').slice(0, 7));
}

function rateFor(model) {
  const p = state.pricing;
  if (!p || !p.models) return null;
  if (p.models[model]) return p.models[model];
  const tier = ['opus', 'sonnet', 'haiku'].find(t => (model || '').toLowerCase().includes(t));
  return (tier && p.tier_fallback) ? p.tier_fallback[tier] : null;
}

function usageCost(model, u) {
  const r = rateFor(model);
  if (!r) return null;
  return (
    u.in      * r.input +
    u.out     * r.output +
    u.cacheRd * r.cache_read +
    u.c5      * r.cache_create_5m +
    u.c1      * r.cache_create_1h
  ) / 1e6;
}

// Emit an expandable text placeholder; real text is set via textContent later
// (never innerHTML) to avoid XSS.
function expandable(attr, key, cls = '') {
  return `<span class="prompt-short ${cls}" ${attr}="${key}"></span
         ><button class="expand-btn" ${attr}="${key}">more</button
         ><div class="prompt-full ${cls}" ${attr}="${key}" hidden></div>`;
}

function fillExpandable(root, attr, key, text) {
  const short = root.querySelector(`.prompt-short[${attr}="${key}"]`);
  const full  = root.querySelector(`.prompt-full[${attr}="${key}"]`);
  const btn   = root.querySelector(`button.expand-btn[${attr}="${key}"]`);

  if (short) short.textContent = text.length > PREVIEW_LEN
    ? text.slice(0, PREVIEW_LEN - 1) + '…'
    : text;
  if (full) full.textContent = text;
  if (btn && text.length <= PREVIEW_LEN) btn.hidden = true;
}

// ---------- session list ----------

async function renderList(root) {
  const hashQs = new URLSearchParams(location.hash.split('?')[1] || '');
  const projectFilter = hashQs.get('project') || '';
  const range = getRange();
  const since = sinceIso(range);
  const apiUrl = '/api/sessions?limit=100'
    + (projectFilter ? '&project=' + encodeURIComponent(projectFilter) : '')
    + (since ? '&since=' + encodeURIComponent(since) : '');
  const list = await api(apiUrl);
  const filteredList = list.filter(s => s.turns > 0);

  const projectName = projectFilter
    ? (filteredList.length > 0 ? (filteredList[0].project_name || filteredList[0].project_slug) : projectFilter)
    : '';

  const rangeLabel = `<span class="muted" style="font-size:12px;font-weight:400">${range.days ? `last ${range.days} day${range.days > 1 ? 's' : ''}` : 'all time'}</span>`;

  const heading = projectFilter
    ? `<h2 style="display:flex;align-items:center">
         <span>${fmt.htmlSafe(projectName)} sessions</span>
         <span class="spacer"></span>
         ${rangeLabel}
         <a href="#/sessions" class="muted" style="margin-left:14px">all sessions →</a>
       </h2>`
    : `<h2 style="display:flex;align-items:center"><span>Sessions</span><span class="spacer"></span>${rangeLabel}</h2>`;

  root.innerHTML = `
    <div class="card">
      ${heading}
      <table>
        <thead><tr>
          <th>started</th><th>project</th><th class="blur-sensitive">first prompt</th>
          <th>models</th><th class="num">turns</th><th class="num">agents</th>
          <th class="num">tokens</th><th class="num">duration</th>
        </tr></thead>
        <tbody>
          ${filteredList.map(s => `
            <tr class="rowlink" data-href="#/sessions/${encodeURIComponent(s.session_id)}">
              <td class="mono" style="white-space:nowrap">${fmt.ts(s.started)}</td>
              <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
              <td class="blur-sensitive prompt-preview" title="${fmt.htmlSafe(s.first_prompt || '')}">${fmt.htmlSafe(fmt.short(s.first_prompt, 90)) || '<span class="muted">—</span>'}</td>
              <td>${modelBadges(s.models)}</td>
              <td class="num">${fmt.int(s.turns)}</td>
              <td class="num">${s.agents ? fmt.int(s.agents) : '<span class="muted">—</span>'}</td>
              <td class="num" title="${fmt.int(s.billable_tokens)} billable · ${fmt.int(s.cache_read_tokens)} cache read">${fmt.compact(s.tokens)}</td>
              <td class="num">${durationFmt(s.started, s.ended)}</td>
            </tr>`).join('') || '<tr><td colspan="8" class="muted">no sessions in this range</td></tr>'}
        </tbody>
      </table>
    </div>`;

  root.onclick = e => {
    if (e.target.closest('a')) return;
    const row = e.target.closest('tr.rowlink');
    if (row) location.hash = row.dataset.href.slice(1);
  };
}

// ---------- session detail ----------

// Group main-thread records into exchanges: one block per user prompt, plus a
// leading "session start" block for records before the first prompt.
// Sidechain (subagent) records are attributed to the exchange active at their
// timestamp and aggregated per agent_id.
function buildExchanges(turns) {
  const exchanges = [];
  let cur = null;
  let promptNo = 0;

  const newExchange = promptTurn => ({
    n: promptTurn ? ++promptNo : 0,
    prompt: promptTurn,
    command: promptTurn ? commandOf(promptTurn.prompt_text) : null,
    start: promptTurn ? promptTurn.timestamp : null,
    end: promptTurn ? promptTurn.timestamp : null,
    perModel: new Map(),
    tools: new Map(),
    agents: new Map(),
    resp: [],
    think: [],
    out: 0,
    records: 0,
  });

  for (const t of turns) {
    const isPrompt = !t.is_sidechain && t.type === 'user' && t.prompt_text;
    if (isPrompt) {
      cur = newExchange(t);
      exchanges.push(cur);
      continue;
    }

    if (!cur) {
      cur = newExchange(null);
      cur.start = t.timestamp;
      exchanges.push(cur);
    }
    cur.end = t.timestamp;
    cur.records++;

    if (t.type === 'assistant' && t.model) {
      const u = cur.perModel.get(t.model) || { in: 0, out: 0, cacheRd: 0, c5: 0, c1: 0 };
      u.in      += t.input_tokens || 0;
      u.out     += t.output_tokens || 0;
      u.cacheRd += t.cache_read_tokens || 0;
      u.c5      += t.cache_create_5m_tokens || 0;
      u.c1      += t.cache_create_1h_tokens || 0;
      cur.perModel.set(t.model, u);
      cur.out += t.output_tokens || 0;
    }

    if (t.is_sidechain) {
      const key = t.agent_id || 'unknown';
      const a = cur.agents.get(key) || { msgs: 0, out: 0 };
      a.msgs++;
      a.out += t.output_tokens || 0;
      cur.agents.set(key, a);
    } else {
      const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
      for (const x of tools) cur.tools.set(x.name, (cur.tools.get(x.name) || 0) + 1);
      if (t.type === 'assistant' && t.response_text) cur.resp.push(t.response_text);
      if (t.type === 'assistant' && t.thinking_text) cur.think.push(t.thinking_text);
    }
  }

  for (const ex of exchanges) {
    ex.cost = null;
    for (const [model, u] of ex.perModel) {
      const c = usageCost(model, u);
      if (c != null) ex.cost = (ex.cost || 0) + c;
    }
  }

  return exchanges;
}

function exchangeHtml(ex, idx, maxOut, agentInfoById) {
  let promptHtml;
  if (!ex.prompt) {
    promptHtml = '<span class="muted">session start / context records</span>';
  } else if (ex.command) {
    promptHtml = `<span class="chip" title="slash command">⌘ ${fmt.htmlSafe(ex.command)}</span>`;
  } else {
    promptHtml = expandable('data-prompt', 'e' + idx);
  }

  const toolChips = [...ex.tools.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<span class="chip">${fmt.htmlSafe(name)}${n > 1 ? ` ×${n}` : ''}</span>`)
    .join('');

  const agentChips = [...ex.agents.entries()].map(([aid, a]) => {
    const info = agentInfoById[aid];
    const label = info ? agentLabel(info) : ('agent ' + aid.slice(0, 7));
    const cls = info && info.kind !== 'task' ? 'chip' : 'chip agent';
    return `<span class="${cls}" title="agent ${fmt.htmlSafe(aid)}">⚡ ${fmt.htmlSafe(label)} · ${a.msgs} msg${a.msgs > 1 ? 's' : ''} · ${fmt.compact(a.out)} out</span>`;
  }).join('');

  const respHtml  = ex.resp.length  ? `<div class="ex-resp blur-sensitive">${expandable('data-resp', 'e' + idx, 'response-text')}</div>` : '';
  const thinkHtml = ex.think.length ? `<button class="expand-btn think-btn" data-think="e${idx}">thinking</button><div class="prompt-full think-block" data-think="e${idx}" hidden></div>` : '';

  const stats = [
    ex.cost != null ? fmt.usd4(ex.cost) : null,
    fmt.compact(ex.out) + ' out',
    durationFmt(ex.start, ex.end),
  ].filter(Boolean).join(' · ');

  const meterPct = maxOut > 0 ? Math.max(1, Math.round(100 * ex.out / maxOut)) : 0;

  return `
    <div class="exchange">
      <div class="ex-head">
        <span class="ex-num mono">${ex.prompt ? '#' + ex.n : '·'}</span>
        <span class="ex-time mono">${(ex.start || '').slice(11, 19)}</span>
        <div class="ex-prompt blur-sensitive">${promptHtml}</div>
        <span class="ex-stats mono">${stats}</span>
      </div>
      <div class="ex-meter"><span style="width:${meterPct}%"></span></div>
      <div class="ex-body">
        ${agentChips}${toolChips}${thinkHtml}
      </div>
      ${respHtml}
    </div>`;
}

function rawRowHtml(t, idx) {
  const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
  const toolStr = fmt.htmlSafe(tools.map(x => x.name).join(' · '));

  let content = '—';
  if (t.type === 'user' && t.prompt_text) {
    content = expandable('data-prompt', 'r' + idx);
  } else if (t.type === 'assistant') {
    let html = '';
    if (t.thinking_text) {
      html += `<button class="expand-btn think-btn" data-think="r${idx}">thinking</button
              ><div class="prompt-full think-block" data-think="r${idx}" hidden></div> `;
    }
    if (t.response_text) {
      html += expandable('data-resp', 'r' + idx, 'response-text');
    } else if (toolStr) {
      html += toolStr;
    }
    content = html || '—';
  } else if (toolStr) {
    content = toolStr;
  }

  return `<tr>
    <td class="mono">${(t.timestamp || '').slice(11, 19)}</td>
    <td>${t.type}${t.is_sidechain ? ` <span class="badge" title="${fmt.htmlSafe(t.agent_id || '')}">⚡ ${fmt.htmlSafe((t.agent_id || 'side').slice(0, 6))}</span>` : ''}</td>
    <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
    <td class="blur-sensitive">${content}</td>
    <td class="num">${fmt.int(t.input_tokens)}</td>
    <td class="num">${fmt.int(t.output_tokens)}</td>
    <td class="num">${fmt.int(t.cache_read_tokens)}</td>
  </tr>`;
}

function agentsTableHtml(agents, sessionStart) {
  if (!agents.length) return '';
  return `
    <div class="card" style="margin-top:16px">
      <h3>Agents (${agents.length})</h3>
      <table>
        <thead><tr>
          <th>#</th><th>type</th><th>agent</th><th>models</th>
          <th class="num">msgs</th><th class="num">tool calls</th>
          <th class="num">out</th><th class="num">cache rd</th>
          <th class="num">started at</th><th class="num">duration</th>
        </tr></thead>
        <tbody>
          ${agents.map((a, i) => `<tr>
            <td class="mono">${i + 1}</td>
            <td><span class="${a.kind === 'task' ? 'chip agent' : 'chip'}">⚡ ${fmt.htmlSafe(agentLabel(a))}</span></td>
            <td class="mono" title="${fmt.htmlSafe(a.agent_id || '')}">${fmt.htmlSafe((a.agent_id || 'unknown').slice(0, 8))}</td>
            <td>${modelBadges(a.models)}</td>
            <td class="num">${fmt.int(a.messages)}</td>
            <td class="num">${fmt.int(a.tool_calls)}</td>
            <td class="num">${fmt.compact(a.output_tokens)}</td>
            <td class="num">${fmt.compact(a.cache_read_tokens)}</td>
            <td class="num">+${durationFmt(sessionStart, a.started)}</td>
            <td class="num">${durationFmt(a.started, a.ended)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function renderSession(root, id) {
  const data = await api('/api/sessions/' + encodeURIComponent(id));
  const turns = data.turns || [];
  const agents = data.agents || [];

  let totalIn = 0, totalOut = 0, totalCacheRd = 0, totalCacheWr = 0, toolCalls = 0;
  let userTurns = 0, sidechainMsgs = 0;

  for (const t of turns) {
    if (t.is_sidechain) sidechainMsgs++;
    if (!t.is_sidechain && t.type === 'user' && t.prompt_text && !commandOf(t.prompt_text)) userTurns++;
    if (t.tool_calls_json) toolCalls += JSON.parse(t.tool_calls_json).length;
    if (t.type !== 'assistant') continue;
    totalIn      += t.input_tokens || 0;
    totalOut     += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
    totalCacheWr += (t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0);
  }

  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length - 1] && turns[turns.length - 1].timestamp) || '';

  const agentInfoById = {};
  for (const a of agents) {
    if (a.agent_id) agentInfoById[a.agent_id] = a;
  }
  const taskAgents = agents.filter(a => a.kind === 'task');
  const otherAgents = agents.length - taskAgents.length;

  const exchanges = buildExchanges(turns);
  const maxOut = Math.max(0, ...exchanges.map(ex => ex.out));

  const kpi = (label, value, sub = '') => `
    <div class="card kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>`;

  const resumeCmd = `cd "${cwd || project}"; claude --resume ${id}`;

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">
        <span class="mono" style="font-size:15px">Session ${fmt.htmlSafe(id)}</span>
        <span class="spacer"></span>
        <button id="resume-btn" title="${fmt.htmlSafe(resumeCmd)}">⎘ copy resume command</button>
        <a href="#/sessions" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${turns.length} records</span>
      </div>
    </div>

    <div class="row cols-4" style="margin-top:16px">
      ${kpi('Est. cost', data.cost_usd != null ? fmt.usd(data.cost_usd) : '—', data.cost_estimated ? 'tier-estimated rates' : 'API rates')}
      ${kpi('Duration', durationFmt(started, ended))}
      ${kpi('Your prompts', fmt.int(userTurns), fmt.int(toolCalls) + ' tool calls')}
      ${kpi('Agents', fmt.int(taskAgents.length), otherAgents ? otherAgents + ' compaction/side' : (sidechainMsgs ? fmt.int(sidechainMsgs) + ' agent msgs' : ''))}
    </div>
    <div class="row cols-4" style="margin-top:16px">
      ${kpi('Tokens in', fmt.compact(totalIn))}
      ${kpi('Tokens out', fmt.compact(totalOut))}
      ${kpi('Cache read', fmt.compact(totalCacheRd))}
      ${kpi('Cache write', fmt.compact(totalCacheWr))}
    </div>

    ${agentsTableHtml(agents, started)}

    <div class="card" style="margin-top:16px">
      <h3 style="display:flex;align-items:center;gap:12px">
        <span>Flow</span>
        <span class="spacer"></span>
        <span class="range-tabs">
          <button data-view="flow" class="active">conversation</button>
          <button data-view="raw">raw records</button>
        </span>
      </h3>
      <div id="flow-view">
        ${exchanges.map((ex, i) => exchangeHtml(ex, i, maxOut, agentInfoById)).join('')}
      </div>
      <div id="raw-view" hidden></div>
    </div>`;

  // Fill text content via textContent (never innerHTML) to avoid XSS.
  exchanges.forEach((ex, i) => {
    if (ex.prompt && !ex.command) fillExpandable(root, 'data-prompt', 'e' + i, ex.prompt.prompt_text);
    if (ex.resp.length) fillExpandable(root, 'data-resp', 'e' + i, ex.resp.join('\n\n'));
    if (ex.think.length) {
      const block = root.querySelector(`.think-block[data-think="e${i}"]`);
      if (block) block.textContent = ex.think.join('\n\n---\n\n');
    }
  });

  // The raw table can run to thousands of rows; build it only when opened.
  let rawBuilt = false;
  const buildRawView = () => {
    if (rawBuilt) return;
    rawBuilt = true;

    const rawView = root.querySelector('#raw-view');
    rawView.innerHTML = `
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">content</th><th class="num">in</th><th class="num">out</th><th class="num">cache rd</th></tr></thead>
        <tbody>${turns.map((t, idx) => rawRowHtml(t, idx)).join('')}</tbody>
      </table>`;

    turns.forEach((t, idx) => {
      if (t.prompt_text && t.type === 'user') fillExpandable(rawView, 'data-prompt', 'r' + idx, t.prompt_text);
      if (t.response_text) fillExpandable(rawView, 'data-resp', 'r' + idx, t.response_text);
      if (t.thinking_text) {
        const block = rawView.querySelector(`.think-block[data-think="r${idx}"]`);
        if (block) block.textContent = t.thinking_text;
      }
    });
  };

  // Assignment (not addEventListener) so re-renders don't stack handlers.
  root.onclick = e => {
    const resumeBtn = e.target.closest('#resume-btn');
    if (resumeBtn) {
      navigator.clipboard.writeText(resumeCmd).then(() => {
        const original = resumeBtn.textContent;
        resumeBtn.textContent = 'copied!';
        setTimeout(() => { resumeBtn.textContent = original; }, 1500);
      });
      return;
    }

    const viewBtn = e.target.closest('button[data-view]');
    if (viewBtn) {
      if (viewBtn.dataset.view === 'raw') buildRawView();
      root.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b === viewBtn));
      root.querySelector('#flow-view').hidden = viewBtn.dataset.view !== 'flow';
      root.querySelector('#raw-view').hidden  = viewBtn.dataset.view !== 'raw';
      return;
    }

    const btn = e.target.closest('.expand-btn');
    if (!btn) return;

    if (btn.dataset.think !== undefined) {
      const scope = btn.closest('td, .ex-body') || root;
      const block = scope.querySelector(`.think-block[data-think="${btn.dataset.think}"]`);
      if (!block) return;
      block.hidden = !block.hidden;
      btn.textContent = block.hidden ? 'thinking' : 'less';
      return;
    }

    const isResp = btn.dataset.resp !== undefined;
    const key    = isResp ? btn.dataset.resp : btn.dataset.prompt;
    const attr   = isResp ? 'data-resp' : 'data-prompt';
    const scope  = btn.parentElement;
    const short  = scope.querySelector(`.prompt-short[${attr}="${key}"]`);
    const full   = scope.querySelector(`.prompt-full[${attr}="${key}"]`);
    if (!short || !full) return;
    full.hidden  = !full.hidden;
    short.hidden = !short.hidden;
    btn.textContent = full.hidden ? 'more' : 'less';
  };
}

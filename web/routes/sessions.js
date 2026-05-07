import { api, fmt } from '/web/app.js';

export default async function (root) {
  const id = decodeURIComponent(location.hash.split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

async function renderList(root) {
  const hashQs = new URLSearchParams(location.hash.split('?')[1] || '');
  const projectFilter = hashQs.get('project') || '';
  const apiUrl = '/api/sessions?limit=100' + (projectFilter ? '&project=' + encodeURIComponent(projectFilter) : '');
  const list = await api(apiUrl);

  const projectName = projectFilter
    ? (list.length > 0 ? (list[0].project_name || list[0].project_slug) : projectFilter)
    : '';

  const heading = projectFilter
    ? `<h2 style="display:flex;align-items:center">
         <span>${fmt.htmlSafe(projectName)} sessions</span>
         <span class="spacer"></span>
         <a href="#/sessions" class="muted">all sessions →</a>
       </h2>`
    : '<h2>Sessions</h2>';

  root.innerHTML = `
    <div class="card">
      ${heading}
      <table>
        <thead><tr><th>started</th><th>project</th><th class="num">turns</th><th class="num">tokens</th><th>session</th></tr></thead>
        <tbody>
          ${list.map(s => `
            <tr>
              <td class="mono">${fmt.ts(s.started)}</td>
              <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
              <td class="num">${fmt.int(s.turns)}</td>
              <td class="num">${fmt.int(s.tokens)}</td>
              <td><a href="#/sessions/${encodeURIComponent(s.session_id)}" class="mono">${fmt.htmlSafe(s.session_id.slice(0,8))}…</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const PREVIEW_LEN = 110;

function expandable(text, dataAttr, idx, cls = '') {
  if (text.length <= PREVIEW_LEN) return `<span ${dataAttr}="${idx}" ${cls}></span>`;
  return `<span class="prompt-short ${cls}" ${dataAttr}="${idx}"></span
         ><button class="expand-btn" ${dataAttr}="${idx}">more</button
         ><div class="prompt-full ${cls}" ${dataAttr}="${idx}" hidden></div>`;
}

function promptCellHtml(t, idx) {
  const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
  const toolStr = fmt.htmlSafe(tools.map(x => x.name).join(' · '));

  if (t.type === 'user') {
    if (!t.prompt_text) return toolStr || '—';
    return expandable(t.prompt_text, 'data-prompt', idx);
  }

  if (t.type === 'assistant') {
    let html = '';
    if (t.thinking_text) {
      html += `<button class="expand-btn think-btn" data-think="${idx}">thinking</button
              ><div class="prompt-full think-block" data-think="${idx}" hidden></div> `;
    }
    if (t.response_text) {
      html += expandable(t.response_text, 'data-resp', idx, 'response-text');
    } else if (toolStr) {
      html += toolStr;
    }
    return html || '—';
  }

  return toolStr || '—';
}

async function renderSession(root, id) {
  const turns = await api('/api/sessions/' + encodeURIComponent(id));
  let totalIn = 0, totalOut = 0, totalCacheRd = 0;
  let modelCounts = {};
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
    const m = t.model || 'unknown';
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  }
  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length-1] && turns[turns.length-1].timestamp) || '';

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>Session ${fmt.htmlSafe(id.slice(0,8))}…</span>
        <span class="spacer"></span>
        <a href="#/sessions" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${turns.length} records</span>
        <span>${fmt.int(totalIn)} in · ${fmt.int(totalOut)} out · ${fmt.int(totalCacheRd)} cache rd</span>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Turn-by-turn</h3>
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">content</th><th class="num">in</th><th class="num">out</th><th class="num">cache rd</th></tr></thead>
        <tbody>
          ${turns.map((t, idx) => `<tr>
            <td class="mono">${(t.timestamp || '').slice(11,19)}</td>
            <td>${t.type}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
            <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
            <td class="blur-sensitive">${promptCellHtml(t, idx)}</td>
            <td class="num">${fmt.int(t.input_tokens)}</td>
            <td class="num">${fmt.int(t.output_tokens)}</td>
            <td class="num">${fmt.int(t.cache_read_tokens)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // Populate text content via textContent (never innerHTML) to avoid XSS.
  turns.forEach((t, idx) => {
    const fill = (attr, text) => {
      const short = root.querySelector(`.prompt-short[${attr}="${idx}"]`);
      const full  = root.querySelector(`.prompt-full[${attr}="${idx}"]`);
      const plain = root.querySelector(`span[${attr}="${idx}"]`);
      if (plain) plain.textContent = text;
      if (short) short.textContent = text.slice(0, PREVIEW_LEN - 1) + '…';
      if (full)  full.textContent  = text;
    };
    if (t.prompt_text)   fill('data-prompt', t.prompt_text);
    if (t.response_text) fill('data-resp',   t.response_text);
    if (t.thinking_text) {
      const block = root.querySelector(`.think-block[data-think="${idx}"]`);
      if (block) block.textContent = t.thinking_text;
    }
  });

  root.addEventListener('click', e => {
    const btn = e.target.closest('.expand-btn');
    if (!btn) return;
    if (btn.dataset.think !== undefined) {
      const block = btn.closest('td').querySelector(`.think-block[data-think="${btn.dataset.think}"]`);
      block.hidden = !block.hidden;
      btn.textContent = block.hidden ? 'thinking' : 'less';
      return;
    }
    const isResp = btn.dataset.resp !== undefined;
    const idx    = isResp ? btn.dataset.resp : btn.dataset.prompt;
    const attr   = isResp ? 'data-resp' : 'data-prompt';
    const cell   = btn.closest('td');
    const short  = cell.querySelector(`.prompt-short[${attr}="${idx}"]`);
    const full   = cell.querySelector(`.prompt-full[${attr}="${idx}"]`);
    full.hidden  = !full.hidden;
    short.hidden = !short.hidden;
    btn.textContent = full.hidden ? 'more' : 'less';
  });
}

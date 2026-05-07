import { api, state, $ } from '/web/app.js';

function buildHooksNode(hooks) {
  const frag = document.createDocumentFragment();

  if (!hooks.sources.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No hooks found in ~/.claude/settings.json or any project .claude/settings.json.';
    frag.appendChild(p);
    return frag;
  }

  for (const src of hooks.sources) {
    const labelP = document.createElement('p');
    labelP.className = 'muted';
    labelP.style.margin = '0 0 8px';
    labelP.textContent = 'Source: ';
    const lc = document.createElement('code');
    lc.textContent = src.label;
    labelP.appendChild(lc);
    frag.appendChild(labelP);

    for (const [event, matchers] of Object.entries(src.hooks)) {
      const evP = document.createElement('p');
      evP.style.cssText = 'margin:12px 0 4px;font-weight:600;color:var(--accent)';
      evP.textContent = event;
      frag.appendChild(evP);

      const table = document.createElement('table');
      const thead = table.createTHead();
      const hrow = thead.insertRow();
      for (const [txt, cls] of [['matcher', ''], ['command', ''], ['timeout (s)', 'num']]) {
        const th = document.createElement('th');
        th.textContent = txt;
        if (cls) th.className = cls;
        hrow.appendChild(th);
      }
      const tbody = table.createTBody();
      for (const m of matchers) {
        for (const h of (m.hooks || [])) {
          const row = tbody.insertRow();

          const td1 = row.insertCell();
          const mc = document.createElement('code');
          mc.textContent = m.matcher || '*';
          td1.appendChild(mc);

          const td2 = row.insertCell();
          td2.style.cssText = 'font-size:12px;word-break:break-all';
          const cc = document.createElement('code');
          cc.textContent = h.command || '';
          td2.appendChild(cc);

          const td3 = row.insertCell();
          td3.className = 'num';
          td3.textContent = h.timeout != null ? String(h.timeout) : '—';
        }
      }
      frag.appendChild(table);
    }
  }
  return frag;
}

const TYPE_BADGE = { user: 'haiku', feedback: 'opus', project: 'sonnet', reference: 'haiku' };

function buildMemoryNode(memory) {
  const frag = document.createDocumentFragment();
  let hasContent = false;

  if (memory.global) {
    hasContent = true;
    const details = document.createElement('details');
    details.style.marginBottom = '16px';
    const summary = document.createElement('summary');
    summary.style.cssText = 'cursor:pointer;font-weight:600';
    summary.textContent = 'Global — ';
    const gc = document.createElement('code');
    gc.textContent = '~/.claude/CLAUDE.md';
    summary.appendChild(gc);
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin-top:8px;white-space:pre-wrap;font-size:12px;opacity:0.75;background:var(--bg2);padding:10px;border-radius:4px;overflow:auto';
    pre.textContent = memory.global;
    details.appendChild(pre);
    frag.appendChild(details);
  }

  for (const proj of memory.projects) {
    hasContent = true;
    const div = document.createElement('div');
    div.style.marginBottom = '16px';

    const slugP = document.createElement('p');
    slugP.style.cssText = 'margin:0 0 6px;font-weight:600';
    const slugCode = document.createElement('code');
    slugCode.textContent = proj.slug;
    slugP.appendChild(slugCode);
    div.appendChild(slugP);

    if (!proj.entries.length) {
      const noP = document.createElement('p');
      noP.className = 'muted';
      noP.style.margin = '4px 0 0';
      noP.textContent = 'No memory files.';
      div.appendChild(noP);
    } else {
      for (const e of proj.entries) {
        const details = document.createElement('details');
        details.style.margin = '8px 0';

        const summary = document.createElement('summary');
        summary.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:6px';

        const badge = document.createElement('span');
        badge.className = 'badge ' + (TYPE_BADGE[e.type] || '');
        badge.textContent = e.type || 'note';
        summary.appendChild(badge);

        const nameEl = document.createElement('strong');
        nameEl.textContent = e.name;
        summary.appendChild(nameEl);

        if (e.description) {
          const descEl = document.createElement('span');
          descEl.className = 'muted';
          descEl.style.fontSize = '12px';
          descEl.textContent = e.description;
          summary.appendChild(descEl);
        }

        details.appendChild(summary);

        const pre = document.createElement('pre');
        pre.style.cssText = 'margin-top:6px;white-space:pre-wrap;font-size:12px;opacity:0.75;background:var(--bg2);padding:10px;border-radius:4px;overflow:auto';
        pre.textContent = e.body;
        details.appendChild(pre);

        div.appendChild(details);
      }
    }
    frag.appendChild(div);
  }

  if (!hasContent) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No memory files found in ~/.claude/projects/*/memory/.';
    frag.appendChild(p);
  }
  return frag;
}

export default async function (root) {
  const [cur, hooks, memory] = await Promise.all([
    api('/api/plan'),
    api('/api/hooks'),
    api('/api/memory'),
  ]);

  const plans = Object.entries(cur.pricing.plans);

  root.innerHTML = `
    <div class="card">
      <h2>Settings</h2>
      <h3 style="margin-top:16px">Plan</h3>
      <p class="muted" style="margin:0 0 12px">Sets how cost is displayed. API mode shows pay-per-token rates. Subscription modes show what you actually pay each month.</p>
      <div class="flex">
        <select id="plan">
          ${plans.map(([k,v]) => `<option value="${k}" ${k===cur.plan?'selected':''}>${v.label}${v.monthly?` — $${v.monthly}/mo`:''}</option>`).join('')}
        </select>
        <button class="primary" id="save">Save</button>
        <span id="msg" class="muted"></span>
      </div>

      <hr class="divider">

      <h3>Pricing table</h3>
      <p class="muted" style="margin:0 0 12px">Edit <code>pricing.json</code> in the project root to change rates. Reload the page after editing.</p>
      <table>
        <thead><tr><th>model</th><th class="num">input</th><th class="num">output</th><th class="num">cache read</th><th class="num">cache 5m</th><th class="num">cache 1h</th></tr></thead>
        <tbody>
          ${Object.entries(cur.pricing.models).map(([k,v]) => `
            <tr><td><span class="badge ${v.tier}">${k}</span></td>
              <td class="num">$${v.input.toFixed(2)}</td>
              <td class="num">$${v.output.toFixed(2)}</td>
              <td class="num">$${v.cache_read.toFixed(2)}</td>
              <td class="num">$${v.cache_create_5m.toFixed(2)}</td>
              <td class="num">$${v.cache_create_1h.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">Rates per 1M tokens, USD.</p>

      <hr class="divider">

      <h3>Privacy</h3>
      <p class="muted">Press <code>Cmd/Ctrl + B</code> anywhere to blur prompt text and other sensitive content for screenshots.</p>

      <hr class="divider">

      <h3>Hooks</h3>
      <p class="muted" style="margin:0 0 12px">Shell commands Claude Code runs in response to events (tool use, session stop, etc.).</p>
      <div id="hooks-content"></div>

      <hr class="divider">

      <h3>Memory</h3>
      <p class="muted" style="margin:0 0 12px">Persistent notes written by Claude Code across sessions.</p>
      <div id="memory-content"></div>
    </div>`;

  document.getElementById('hooks-content').appendChild(buildHooksNode(hooks));
  document.getElementById('memory-content').appendChild(buildMemoryNode(memory));

  $('#save').addEventListener('click', async () => {
    const plan = $('#plan').value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    state.plan = plan;
    document.getElementById('plan-pill').textContent = plan;
    $('#msg').textContent = 'Saved.';
    $('#msg').style.color = 'var(--good)';
  });
}

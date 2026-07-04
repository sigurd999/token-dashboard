import { api, fmt, getRange, sinceIso, withSince } from '/web/app.js';

export default async function (root) {
  const range = getRange();
  const since = sinceIso(range);
  const rows = await api(withSince('/api/projects', since));
  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>Projects</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px;font-weight:400">${range.days ? `last ${range.days} day${range.days > 1 ? 's' : ''}` : 'all time'}</span>
      </h2>
      <p class="muted" style="margin:-8px 0 14px">Sorted by billable token spend. Cache reads are billed cheaper, so high cache-read columns are good.</p>
      <table>
        <thead><tr><th>project</th><th class="num">sessions</th><th class="num">turns</th><th class="num">billable tokens</th><th class="num">cache reads</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td title="${fmt.htmlSafe(r.project_slug)}"><a href="#/sessions?project=${encodeURIComponent(r.project_slug)}">${fmt.htmlSafe(r.project_name || r.project_slug)}</a></td>
              <td class="num">${fmt.int(r.sessions)}</td>
              <td class="num">${fmt.int(r.turns)}</td>
              <td class="num">${fmt.int(r.billable_tokens)}</td>
              <td class="num">${fmt.int(r.cache_read_tokens)}</td>
            </tr>`).join('') || `<tr><td colspan="5" class="muted">no activity in this range</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

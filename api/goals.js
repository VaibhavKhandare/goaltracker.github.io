// Public, read-only summary of the tracker for humans and AI agents.
//   GET /api/goals            -> Markdown
//   GET /api/goals?format=json -> JSON
const sync = require('./sync.js');

const RANKS = [['S', 90], ['A', 75], ['B', 60], ['C', 45], ['D', 30], ['E', 0]];
const pad = n => String(n).padStart(2, '0');
function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 864e5); // Asia/Kolkata
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const rankOf = pct => (pct <= 0 ? '–' : (RANKS.find(([, t]) => pct >= t) || ['E'])[0]);
const fmtH = m => `${Math.floor(m / 60)}h ${pad(Math.round(m % 60))}m`;
const prio = { A: 0, B: 1, C: 2, D: 3, E: 4 };

function summarize(d, updatedAt) {
  const today = istDate();
  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  const open = tasks.filter(t => !t.completedAt)
    .sort((a, b) => (prio[a.priority] ?? 9) - (prio[b.priority] ?? 9) || (b.impact || 0) - (a.impact || 0) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
  const persona = (d.persona && d.persona.name) || 'Future Me';
  const ch = d.challenge || {};
  const chDay = ch.start ? Math.floor((Date.parse(today) - Date.parse(ch.start)) / 864e5) + 1 : null;
  const focus = d.focus || {};
  const goalMin = (Number(focus.goal) || 10) * 60;
  const log = d.focusLog || {};
  const todayMin = Number(log[today]) || 0;
  const last30 = Object.keys(log).filter(k => k <= today && k > istDate(-30) && log[k] > 0);
  const avgPct = last30.length ? last30.reduce((a, k) => a + log[k] / goalMin * 100, 0) / last30.length : 0;
  const weekAgo = istDate(-7);
  const done7 = tasks.filter(t => t.completedAt && t.completedAt.slice(0, 10) >= weekAgo);
  const blocks = (Array.isArray(d.blocks) ? d.blocks : []).filter(b => b.date === today).sort((a, b) => a.start.localeCompare(b.start));
  const title = b => { const t = tasks.find(x => x.id === b.taskId); return t ? t.title : (b.title || 'Block'); };
  const vision = (d.vision && Array.isArray(d.vision.future)) ? d.vision.future.map(f => f.text) : [];
  return {
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, today, persona,
    challenge: ch.start ? { tag: ch.tag, days: ch.days, start: ch.start, day: chDay } : null,
    focus: { goalHours: goalMin / 60, level: focus.level || 'D', todayMinutes: Math.round(todayMin), todayRank: rankOf(todayMin / goalMin * 100), avgRank30: rankOf(avgPct), daysLogged30: last30.length },
    frog: open[0] ? { title: open[0].title, priority: open[0].priority, firstStep: open[0].firstStep || '' } : null,
    openTasks: open.map(t => ({ id: t.id, title: t.title, priority: t.priority, impact: t.impact, due: t.due || null, outcome: t.outcome || '', nextStep: ((t.steps || []).find(s => !s.done) || {}).title || null, stepsDone: (t.steps || []).filter(s => s.done).length, stepsTotal: (t.steps || []).length })),
    completedLast7Days: done7.map(t => ({ title: t.title, priority: t.priority, completedAt: t.completedAt })),
    todayBlocks: blocks.map(b => ({ start: b.start, minutes: Number(b.dur), title: title(b) })),
    vision
  };
}

function toMarkdown(s) {
  const L = [];
  L.push(`# Eat the Frog — goals & progress`, '');
  L.push(`Updated: ${s.updatedAt || 'never'} · Today (IST): ${s.today} · Future self: **${s.persona}**`);
  if (s.challenge) L.push(`Challenge: ${s.challenge.tag} — day ${s.challenge.day} of ${s.challenge.days} (started ${s.challenge.start})`);
  L.push(`Focus: today ${fmtH(s.focus.todayMinutes)} → rank **${s.focus.todayRank}** · level ${s.focus.level} · goal ${s.focus.goalHours}h = S · 30-day average rank **${s.focus.avgRank30}** (${s.focus.daysLogged30} days logged)`, '');
  if (s.frog) L.push(`## 🐸 Current frog`, `**${s.frog.title}** (${s.frog.priority})${s.frog.firstStep ? ` — start: ${s.frog.firstStep}` : ''}`, '');
  if (s.todayBlocks.length) { L.push(`## Today's calendar`); s.todayBlocks.forEach(b => L.push(`- ${b.start} (${b.minutes} min) — ${b.title}`)); L.push(''); }
  for (const p of ['A', 'B', 'C', 'D', 'E']) {
    const ts = s.openTasks.filter(t => t.priority === p);
    if (!ts.length) continue;
    L.push(`## Open ${p} tasks (${ts.length})`);
    ts.forEach(t => L.push(`- **${t.title}**${t.due ? ` · due ${t.due}` : ''}${t.stepsTotal ? ` · ${t.stepsDone}/${t.stepsTotal} steps` : ''}${t.nextStep ? ` · next: ${t.nextStep}` : ''}`));
    L.push('');
  }
  L.push(`## Completed in the last 7 days (${s.completedLast7Days.length})`);
  s.completedLast7Days.forEach(t => L.push(`- ${t.title} (${t.priority}, ${t.completedAt.slice(0, 10)})`));
  if (s.vision.length) { L.push('', `## Vision — ${s.persona}`); s.vision.forEach(v => L.push(`- ${v}`)); }
  L.push('', `_JSON: /api/goals?format=json · Editing happens in the app._`);
  return L.join('\n');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');
  try {
    const { state } = await sync.collections();
    const doc = await state.findOne({ _id: 'main' });
    if (!doc || !doc.data) return res.status(404).json({ error: 'No data yet' });
    const s = summarize(sync.publicView(doc.data), doc.updatedAt);
    const wantJson = (req.query && req.query.format === 'json') || /format=json/.test(req.url || '');
    if (wantJson) return res.status(200).json(s);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(toMarkdown(s));
  } catch (e) {
    return res.status(500).json({ error: 'Failed: ' + e.message });
  }
};

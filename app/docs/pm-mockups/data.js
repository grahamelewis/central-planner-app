// pm mockups — one shared fictional world (Alex Rivera's three projects), so
// every page is comparing ideas, not datasets. Everything here is derivable
// from what the dashboard already writes: tasks/<p>.json (status, session
// counters, handoffs, lineage), ledger/ledger.jsonl (time + tokens + cost),
// plan/<p>.json (deadlines) — pages note when they'd need a NEW field.
const TODAY = new Date('2026-07-31T12:00:00');

const PROJECTS = {
  wedge:  { name: 'wedge-model',     v: '--s1', desc: 'Labor-wedge decomposition · ECMA R&R',
            due: { label: 'ECMA response due', date: '2026-09-04' } },
  repkit: { name: 'replication-kit', v: '--s2', desc: 'AEA replication package',
            due: { label: 'AEA data deposit', date: '2026-08-21' } },
  survey: { name: 'survey-pipeline', v: '--s3', desc: 'Panel survey · wave 3',
            due: { label: 'SED abstract', date: '2026-08-15' } },
};

// status vocabulary (glyphs differ by SHAPE, never color alone)
const ST = {
  done:    { g: '✓', cls: 'stD', label: 'done' },
  running: { g: '◠', cls: 'stR', label: 'running' },
  waiting: { g: '⏸', cls: 'stW', label: 'waiting' },
  queued:  { g: '·', cls: 'stQ', label: 'queued' },
};

const TASKS = [
  // ── wedge-model ──
  { id: 'wed-001', p: 'wedge', cat: 'calibration', status: 'done',
    title: 'Calibrate Frisch elasticity from CEX',
    created: '2026-06-09', closed: '2026-06-12', turns: 6, tokIn: 412e3, tokOut: 38e3, cost: 9.80,
    handoff: { numbers: [['Frisch η', '0.72 (SE 0.049)']],
      decisions: ['Pool CEX 2018–2024 waves — the pre/post-COVID split adds noise, not signal'],
      artifacts: ['calib/frisch_eta.csv', 'fig/eta_fit.pdf'] } },
  { id: 'wed-002', p: 'wedge', cat: 'estimation', status: 'done', up: ['wed-001'],
    title: 'Extract wedge series 1985–2024',
    created: '2026-06-12', closed: '2026-06-18', turns: 9, tokIn: 1.14e6, tokOut: 64e3, cost: 21.40,
    handoff: { numbers: [['var. share — preferences', '0.61'], ['var. share — technology', '0.27'], ['residual', '0.12']],
      decisions: ['Baseline detrend: HP λ=1600 (revisited in wed-003)'],
      artifacts: ['out/wedge_series.csv', 'fig/wedge_decomp.pdf'] } },
  { id: 'wed-003', p: 'wedge', cat: 'robustness', status: 'done', up: ['wed-002'],
    title: 'Hamilton-filter robustness pass',
    created: '2026-07-02', closed: '2026-07-06', turns: 7, tokIn: 640e3, tokOut: 41e3, cost: 13.10,
    handoff: { numbers: [['pref. share (Hamilton)', '0.58']],
      decisions: ['Hamilton (2018) replaces HP in the main text — referee 2; HP moves to appendix B'],
      artifacts: ['fig/wedge_hamilton.pdf'] } },
  { id: 'wed-004', p: 'wedge', cat: 'estimation', status: 'running', up: ['wed-002', 'wed-003'],
    title: 'Counterfactual: hold wedge at 1999 level',
    created: '2026-07-24', turns: 11, tokIn: 2.31e6, tokOut: 145e3, cost: 38.70 },
  { id: 'wed-005', p: 'wedge', cat: 'writing', status: 'waiting', up: ['wed-003'],
    title: 'Response letter — referee 2, §3',
    created: '2026-07-21', waitingSince: '2026-07-28', turns: 5, tokIn: 480e3, tokOut: 52e3, cost: 12.20,
    question: 'R2 wants the wedge series under the Fernald TFP vintage — recompute the full series (≈ $15, half a day) or cite appendix B and move on?' },
  { id: 'wed-006', p: 'wedge', cat: 'writing', status: 'queued', up: ['wed-004', 'wed-005'],
    title: 'Figures pass for revised draft', created: '2026-07-24' },
  { id: 'wed-007', p: 'wedge', cat: 'writing', status: 'queued', up: ['wed-004'],
    title: 'Rebuild online-appendix tables', created: '2026-07-24' },

  // ── replication-kit ──
  { id: 'rep-001', p: 'repkit', cat: 'infra', status: 'done',
    title: 'Pin environment — Docker image + renv lock',
    created: '2026-06-20', closed: '2026-06-24', turns: 5, tokIn: 310e3, tokOut: 22e3, cost: 6.40,
    handoff: { decisions: ['Base image pinned rocker/r-ver:4.4.1 — no :latest anywhere'], artifacts: ['Dockerfile', 'renv.lock'] } },
  { id: 'rep-002', p: 'repkit', cat: 'infra', status: 'done',
    title: 'Seed-lock every Monte Carlo run',
    created: '2026-07-08', closed: '2026-07-09', turns: 3, tokIn: 190e3, tokOut: 14e3, cost: 4.10,
    handoff: { numbers: [['master seed', '20260731']] } },
  { id: 'rep-003', p: 'repkit', cat: 'infra', status: 'done', up: ['rep-001', 'rep-002'],
    title: 'Output-diff harness vs paper tables',
    created: '2026-07-10', closed: '2026-07-15', turns: 8, tokIn: 540e3, tokOut: 47e3, cost: 11.90,
    handoff: { numbers: [['tables reproduced', '41 / 41']], artifacts: ['diff/report.html'] } },
  { id: 'rep-004', p: 'repkit', cat: 'writing', status: 'running',
    title: 'README + data availability statement',
    created: '2026-07-29', turns: 2, tokIn: 150e3, tokOut: 18e3, cost: 3.20 },
  { id: 'rep-006', p: 'repkit', cat: 'data', status: 'waiting',
    title: 'License audit — restricted CEX extracts',
    created: '2026-07-23', waitingSince: '2026-07-25', turns: 3, tokIn: 120e3, tokOut: 11e3, cost: 2.90,
    question: 'CEX microdata can’t ship. Bundle a synthetic sample (fake but runnable) or access instructions only?' },
  { id: 'rep-005', p: 'repkit', cat: 'infra', status: 'queued', up: ['rep-003', 'rep-004', 'rep-006'],
    title: 'Zenodo dry-run deposit', created: '2026-07-23' },

  // ── survey-pipeline ──
  { id: 'sur-001', p: 'survey', cat: 'data', status: 'done',
    title: 'Wave-3 ingest + schema harmonization',
    created: '2026-06-30', closed: '2026-07-07', turns: 12, tokIn: 980e3, tokOut: 71e3, cost: 17.30,
    handoff: { numbers: [['N after dedupe', '12,408']], artifacts: ['data/wave3_clean.parquet'] } },
  { id: 'sur-002', p: 'survey', cat: 'data', status: 'done', up: ['sur-001'],
    title: 'PII scrub + hashed crosswalk',
    created: '2026-07-08', closed: '2026-07-10', turns: 4, tokIn: 260e3, tokOut: 19e3, cost: 5.60,
    handoff: { decisions: ['IDs → salted SHA-256; the salt lives in the vault, never the repo'] } },
  { id: 'sur-003', p: 'survey', cat: 'estimation', status: 'done', up: ['sur-002'],
    title: 'Attrition weights (IPW)',
    created: '2026-07-13', closed: '2026-07-17', turns: 8, tokIn: 720e3, tokOut: 58e3, cost: 14.80,
    handoff: { numbers: [['weights trimmed at', '20'], ['effective N', '11,102']],
      artifacts: ['out/ipw_weights.parquet', 'fig/attrition_balance.pdf'] } },
  { id: 'sur-004', p: 'survey', cat: 'writing', status: 'running', up: ['sur-002'],
    title: 'Codebook autogeneration',
    created: '2026-07-30', turns: 2, tokIn: 110e3, tokOut: 12e3, cost: 2.10 },
  { id: 'sur-005', p: 'survey', cat: 'writing', status: 'waiting',
    title: 'SED 2027 abstract',
    created: '2026-07-22', waitingSince: '2026-07-30', turns: 4, tokIn: 340e3, tokOut: 36e3, cost: 6.70,
    question: 'Lead with the attrition-corrected wage series, or with the panel methodology? 150 words won’t fit both.' },
  { id: 'sur-006', p: 'survey', cat: 'writing', status: 'queued',
    title: 'Wave-4 instrument-change memo', created: '2026-07-28' },
];

// ledger weeks (Mon-start): hours + $ per project — the parts NOT derivable
// from tasks (heartbeat time; cost lands per-turn, tasks only hold the sum)
const WEEKS = [
  { mon: '2026-06-08', h: { wedge: 9.5,  repkit: 0,   survey: 0    }, c: { wedge: 14.6, repkit: 0,    survey: 0    } },
  { mon: '2026-06-15', h: { wedge: 11.0, repkit: 0,   survey: 0    }, c: { wedge: 18.2, repkit: 0,    survey: 0    } },
  { mon: '2026-06-22', h: { wedge: 3.0,  repkit: 6.0, survey: 0    }, c: { wedge: 2.1,  repkit: 6.4,  survey: 0    } },
  { mon: '2026-06-29', h: { wedge: 2.0,  repkit: 0,   survey: 12.0 }, c: { wedge: 1.3,  repkit: 0,    survey: 9.9  } },
  { mon: '2026-07-06', h: { wedge: 7.0,  repkit: 4.0, survey: 10.5 }, c: { wedge: 9.4,  repkit: 5.1,  survey: 11.2 } },
  { mon: '2026-07-13', h: { wedge: 2.5,  repkit: 7.0, survey: 9.0  }, c: { wedge: 1.8,  repkit: 9.2,  survey: 14.8 } },
  { mon: '2026-07-20', h: { wedge: 8.0,  repkit: 2.0, survey: 4.0  }, c: { wedge: 9.1,  repkit: 2.9,  survey: 6.7  } },
  { mon: '2026-07-27', h: { wedge: 11.0, repkit: 3.0, survey: 2.5  }, c: { wedge: 38.7, repkit: 3.2,  survey: 2.1  } },
];
const HOUR_TARGET = 35;

// per-project token mix by model tier (ordered: an ordinal, not a categorical)
const MODELS = ['Fable', 'Opus', 'Sonnet', 'Haiku'];
const MODELMIX = {
  wedge:  [2.60e6, 1.40e6, 0.80e6, 0.18e6],
  repkit: [0.30e6, 0.50e6, 0.40e6, 0.11e6],
  survey: [0.90e6, 0.70e6, 0.70e6, 0.11e6],
};

// plan-style usage windows (the status-bar meter, week of Jul 27)
const USAGE = [
  { name: 'session',            sub: 'sliding 5h',        spent: 1.2e6,  budget: 1.0e7  },
  { name: 'week · all models',  sub: 'resets Mon 00:00',  spent: 6.14e7, budget: 1.5e8  },
  { name: 'week · Fable',       sub: 'resets Mon 00:00',  spent: 2.24e7, budget: 3.0e7  },
];

// focused-hours heatmap, Mon..Sun per week (0–4 ≈ 0–6h; null = future)
const DAYS = [
  [2, 3, 2, 1, 2, 0, 0],
  [3, 2, 3, 2, 1, 0, 1],
  [1, 2, 1, 2, 0, 0, 0],
  [2, 2, 3, 0, 0, 0, 0],
  [3, 3, 2, 3, 2, 1, 0],
  [2, 3, 3, 2, 2, 0, 0],
  [2, 1, 2, 2, 1, 0, 0],
  [3, 4, 3, 4, 3, null, null],
];

// ─── helpers ───
const D = (iso) => new Date(iso + 'T12:00:00');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dstr = (iso) => { const d = D(iso); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const daysUntil = (iso) => Math.round((D(iso) - TODAY) / 864e5);
const daysAgo = (iso) => Math.round((TODAY - D(iso)) / 864e5);
const usd = (x) => '$' + x.toFixed(2);
const usd0 = (x) => '$' + Math.round(x);
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.round(n / 1e3) + 'k';
const hrs = (x) => (Math.round(x * 10) / 10) + 'h';
const byId = Object.fromEntries(TASKS.map(t => [t.id, t]));
const tasksOf = (p) => TASKS.filter(t => t.p === p);
const sv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text != null) n.textContent = text; return n; };

// downstream closure: how many not-done tasks sit below `id` in the DAG
function blocks(id) {
  const out = new Set();
  const walk = (x) => TASKS.forEach(t => {
    if ((t.up || []).includes(x) && !out.has(t.id)) { if (t.status !== 'done') out.add(t.id); walk(t.id); }
  });
  walk(id);
  return [...out];
}

// ─── shared tooltip (values also live in labels/tables — never gated) ───
const TT = (() => {
  let n;
  const ensure = () => n || (n = document.body.appendChild(el('div', 'tt')));
  return {
    show(x, y, title, rows) {
      const t = ensure(); t.replaceChildren();
      if (title) t.appendChild(el('div', 'th', title));
      for (const r of rows || []) {
        const d = el('div', 'tr'), k = el('span');
        if (r.sw) { const s = el('i', 'tk'); s.style.background = r.sw; k.appendChild(s); }
        k.appendChild(document.createTextNode(r.k));
        d.append(k, el('b', null, r.v)); t.appendChild(d);
      }
      t.style.display = 'block';
      const b = t.getBoundingClientRect();
      t.style.left = Math.min(x + 14, innerWidth - b.width - 8) + 'px';
      t.style.top = Math.min(y + 14, innerHeight - b.height - 8) + 'px';
    },
    hide() { if (n) n.style.display = 'none'; },
  };
})();
function wireTip(node, fn) { // fn() → {title, rows:[{k,v,sw?}]}
  const show = (e) => { const d = fn(); TT.show(e.clientX, e.clientY, d.title, d.rows); };
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', show);
  node.addEventListener('pointerleave', TT.hide);
  node.addEventListener('focus', () => { const r = node.getBoundingClientRect(), d = fn();
    TT.show(r.left + r.width / 2, r.bottom, d.title, d.rows); });
  node.addEventListener('blur', TT.hide);
}
function legendHtml(items) { // [{name, v}] — v = css var name
  return `<div class="legend">${items.map(i =>
    `<span><i class="ldot" style="background:var(${i.v})"></i>${i.name}</span>`).join('')}</div>`;
}

// agentview mockups — the three scenarios every variant must survive,
// plus tiny shared helpers. Data mirrors session:agents payloads
// ({n, type, desc, status, summary, tools, tokens} + elapsed for the mock).
const SCEN = {
  flight: {
    label: '3 agents · mid-flight',
    agents: [
      { n: 1, type: 'general-purpose', desc: 'Hryshko–Manovskii + Commault passthrough', status: 'running', act: 'WebFetch · sas.upenn.edu/~manovskii/…', tools: 14, tok: '46k', t: '2m07s' },
      { n: 2, type: 'general-purpose', desc: 'Guvenen–Smith and BPSE passthrough', status: 'running', act: 'WebFetch · BPSE 2020 appendix pdf', tools: 6, tok: '20k', t: '36s' },
      { n: 3, type: 'general-purpose', desc: 'ABBL and Guvenen–Ozkan–Madera', status: 'running', act: 'Read · abbl_2023_insurance.pdf', tools: 6, tok: '20k', t: '42s' },
    ],
  },
  straggler: {
    label: 'stragglers · 2 done, 1 grinding',
    agents: [
      { n: 1, type: 'general-purpose', desc: 'Hryshko–Manovskii + Commault passthrough', status: 'running', act: 'WebFetch · 3rd mirror for Commault AEJ pdf', tools: 31, tok: '104k', t: '9m12s' },
      { n: 2, type: 'general-purpose', desc: 'Guvenen–Smith and BPSE passthrough', status: 'done', summary: 'φ = 0.34 (GS 2014 tab 5); BPSE transitory 0.06', tools: 11, tok: '38k', t: '1m48s', ago: '7m' },
      { n: 3, type: 'general-purpose', desc: 'ABBL and Guvenen–Ozkan–Madera', status: 'failed', summary: 'ABBL pdf paywalled on all mirrors', tools: 9, tok: '31k', t: '2m30s', ago: '6m' },
    ],
  },
  team: {
    label: 'workflow · 24 agents in phases',
    phases: [
      { name: 'Find', done: 6, total: 6 },
      { name: 'Verify', done: 9, total: 15, running: 4, failed: 2 },
      { name: 'Synthesize', done: 0, total: 3, running: 0 },
    ],
    agents: Array.from({ length: 24 }, (_, i) => {
      const ph = i < 6 ? 'Find' : i < 21 ? 'Verify' : 'Synthesize';
      const status = i < 6 ? 'done' : i < 15 ? 'done' : i < 17 ? 'failed' : i < 21 ? 'running' : 'queued';
      return { n: i + 1, type: 'workflow', ph, status,
        desc: ph === 'Find' ? `find: lens ${i + 1}` : ph === 'Verify' ? `verify: claim ${i - 5}` : `synthesize ${i - 20}`,
        act: status === 'running' ? 'WebFetch · source ' + (i - 16) : '',
        summary: status === 'done' ? 'ok' : status === 'failed' ? 'refuted' : '',
        tools: 4 + (i % 9), tok: (9 + (i * 3) % 40) + 'k', t: (20 + (i * 7) % 160) + 's', ago: status === 'done' ? (2 + i % 9) + 'm' : '' };
    }),
  },
};
const MARK = { running: '<span class="spin"></span>', done: '<span class="ok">✓</span>', failed: '<span class="bad">✗</span>', queued: '<span class="small">·queued</span>' };
// the stream context every mock sits inside (what the console looks like around it)
const STREAM_TOP = `
  <div class="tl"><span class="tool">[tool: Agent]</span> Guvenen–Smith and BPSE passthrough — Use WebSearch and WebFetch (loa…</div>
  <div class="tl"><span class="tool">[tool: Agent]</span> ABBL and Guvenen–Ozkan–Madera — Use WebSearch and WebFetch (load the…</div>`;
const STREAM_BOT = `<div class="cog">Cogitating…</div>`;
function statesBar(host, render) {
  const bar = document.createElement('div');
  bar.className = 'states';
  bar.innerHTML = Object.entries(SCEN).map(([k, s], i) =>
    `<button data-k="${k}" class="${i === 0 ? 'on' : ''}">${s.label}</button>`).join('');
  host.before(bar);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    bar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    render(SCEN[b.dataset.k], b.dataset.k);
  });
  render(SCEN.flight, 'flight');
}

// ── workflow scenarios (pages 06–09): the 18-cluster lit audit that today
// renders as ONE opaque card + repeated progress lines ──
const WF = {
  name: 'lit-audit-gl-draft',
  goal: 'Audit every literature mention in gl_draft.tex',
  tools: 288, tok: '661k', t: '6m47s',
  phases: [
    { name: 'Audit', done: 18, total: 18 },
    { name: 'Verify', done: 9, total: 15, running: 4, failed: 2 },
    { name: 'Synthesize', done: 0, total: 1 },
  ],
  log: [
    { t: '0m02s', txt: 'phase Audit — 18 citation clusters, one agent each' },
    { t: '2m53s', txt: '18/18 clusters audited · 41 findings' },
    { t: '2m55s', txt: 'phase Verify — each finding adversarially checked' },
    { t: '5m21s', txt: 'Guvenen–Smith φ=0.34 CONFIRMED (tab 5, p.1913)' },
    { t: '6m16s', txt: 'Lucas1987 magnitude REFUTED — cost is 0.05%, draft says 0.5%' },
    { t: '6m47s', txt: 'verify 9/15 · 2 refuted so far' },
  ],
  agents: [
    { n: 7, desc: 'verify: Krusell–Smith 1998 discount-factor claim', act: 'WebFetch · jpe.uchicago.edu', t: '41s' },
    { n: 11, desc: 'verify: Storesletten et al. 2004 persistence', act: 'Read · storesletten_2004.pdf', t: '1m02s' },
    { n: 12, desc: 'verify: Meghir–Pistaferri Table III moments', act: 'WebSearch · replication appendix', t: '33s' },
    { n: 15, desc: 'verify: De Santis 2007 welfare figure', act: 'WebFetch · aeaweb.org', t: '12s' },
  ],
};

// types/contract.d.ts — the typed contract layer (phase 2, typing slice).
//
// Global ambient declarations for the shapes frozen in app/CONTRACT.md:
// the GET /api/state snapshot, the Task record, the WS event payloads
// (discriminated union keyed on the event type app.js's handleEvent switches
// on), and the shared-store shapes that live in public/store.js. These are
// TYPES ONLY — no runtime code is generated or changed. Source of truth is
// CONTRACT.md (v1 + v2 addenda through 2026-08-10); optionality reflects the
// client's boot literals and the server's incremental fields, not aspiration.
// Referenced from JSDoc in public/*.js by bare name (global scope, no import).

/* ───────────────────────── keys ───────────────────────── */

/** A project's config key (`PROJECTS[key]`). */
type ProjectKey = string;
/** `${project}/${taskId}` — the cross-cache session/task key. */
type TaskKey = string;
/** `${project}::${rel}` — the file-cache / editor key ("fkey"). */
type FileKey = string;

/* ───────────────────────── projects / categories ───────────────────────── */

interface ProjectInfo {
  name?: string;
  root?: string;
  color?: string;
  texWatch?: string | null;
  /** 'active' | 'trial' | 'inactive' — inactive hides from nav/overview. */
  status?: string;
}

interface CategoryInfo {
  icon?: string;
  group?: string;
  primer?: string;
  webSearch?: boolean;
  defaults?: { [k: string]: any };
  [k: string]: any;
}

/* ───────────────────────── Task (canonical schema) ───────────────────────── */

interface TaskContext {
  include_abstract?: boolean;
  include_last_session?: boolean;
  include_sibling_tasks?: boolean;
  include_category_primer?: boolean;
  /** enabled persists for schema compat; gating removed 2026-08-07 (always on). */
  web_search?: { enabled?: boolean; sources?: string[] };
  /** Pins: project-relative paths, or ABSOLUTE paths = external pins. */
  files?: string[];
  notes?: string;
}

/** Active provider session state (`task.session` is the compatibility alias;
 *  `providerSessions` retains per-provider thread history across switches). */
interface TaskSession {
  provider?: 'claude' | 'codex' | string;
  /** Claude sessions. */
  sdkSessionId?: string;
  /** Codex sessions. */
  threadId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  turns?: number;
  [k: string]: any;
}

/** Completion record, written on request only (✓ complete wrap-up turn). */
interface TaskHandoff {
  summary?: string;
  artifacts?: [string, string][];
  numbers?: [string, any][];
  decisions?: string[];
  next?: string;
  [k: string]: any;
}

interface TaskLogEntry { ts?: string; note?: string; [k: string]: any }

interface Task {
  /** `${project.slice(0,3)}-<n>` */
  id: string;
  title?: string;
  description?: string;
  project?: ProjectKey;
  category?: string;
  /** Lineage: upstream task ids whose handoffs feed this task's packet. */
  upstream?: string[];
  oversight?: 'auto' | 'propose' | 'coop' | 'manual' | string;
  status?: 'queued' | 'running' | 'waiting' | 'done' | 'manual' | string;
  question?: string | null;
  provider?: 'claude' | 'codex' | string;
  /** Always explicit for new tasks (DEFAULT_MODEL); legacy null coerced at launch. */
  model?: string | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | string | null;
  /** 🛡 prompting override; ignored for oversight 'propose' (locked to plan). */
  permMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | string | null;
  archived?: boolean;
  context?: TaskContext;
  session?: TaskSession | null;
  providerSessions?: { [provider: string]: TaskSession };
  handoff?: TaskHandoff | null;
  created?: string;
  due?: string | null;
  log?: TaskLogEntry[];
  [k: string]: any;
}

/* ───────────────────────── artifacts / pdf watches ───────────────────────── */

interface ArtifactInfo {
  project: ProjectKey;
  /** Absolute path (server-side). */
  path?: string;
  rel: string;
  name?: string;
  mtime?: number | string;
  kind?: 'html' | 'pdf' | string;
}

interface TexProblem {
  file?: string;
  line?: number | null;
  kind?: string;
  message?: string;
}

/** getPdfWatches()[project] — also the shape of `pdf:status` entries. */
interface PdfWatchEntry {
  tex?: string;
  pdf?: string;
  state?: 'building' | 'built' | 'error' | string;
  /** Duration of the last SUCCESSFUL cycle (ms). */
  lastBuildMs?: number | null;
  lastBuiltAt?: string | number | null;
  pages?: number | null;
  /** Quiet builds: current pass boundary while building, null otherwise. */
  pass?: { n?: number; rule?: string } | null;
  /** Duration of a FAILED cycle (ms). */
  errorMs?: number | null;
  /** Compile died without latexmk reporting errors (killed/crashed). */
  dead?: boolean;
  problems?: TexProblem[];
  counts?: { errors?: number; warnings?: number; [k: string]: any };
  [k: string]: any;
}

/* ───────────────────────── ledger / usage meter ───────────────────────── */

interface UsageWindow {
  key?: string;
  name?: string;
  sub?: string;
  pct?: number;
  spent?: number;
  budget?: number;
  resetAt?: number | string | null;
  [k: string]: any;
}

/** weekSummary().usage — realUsage() ('plan') or usageWindows() ('estimate'). */
interface UsageInfo {
  limits?: UsageWindow[];
  source?: 'plan' | 'estimate' | string;
  subscription?: any;
  fetchedAt?: number | string | null;
  [k: string]: any;
}

interface LedgerSummary {
  since?: string;
  perProject?: {
    [project: string]: { seconds?: number; tokensIn?: number; tokensOut?: number; costUsd?: number };
  };
  totals?: { seconds?: number; tokens?: number; costUsd?: number };
  hourTarget?: number;
  usage?: UsageInfo | null;
  [k: string]: any;
}

/* ───────────────────────── providers / auth ───────────────────────── */

interface ModelInfo {
  id: string;
  label?: string;
  isDefault?: boolean;
  /** Codex catalog rows: efforts the model supports + its default. */
  supportedReasoningEfforts?: { id?: string; reasoningEffort?: string; [k: string]: any }[];
  defaultReasoningEffort?: string;
  [k: string]: any;
}

/** lib/auth.js state (snapshot `auth` + `auth:status` events). */
interface AuthState {
  needed?: boolean;
  reason?: string | null;
  loggedIn?: boolean;
  email?: string | null;
  /** 'apikey' → browser login can't fix it; no Sign in button. */
  method?: string | null;
  checking?: boolean;
  loggingIn?: boolean;
  loginError?: string | null;
  lastChecked?: number | string | null;
  available?: boolean;
  [k: string]: any;
}

interface ProviderState {
  id?: string;
  name?: string;
  connected?: boolean;
  models?: ModelInfo[];
  auth?: AuthState;
  lastChecked?: number | string | null;
  [k: string]: any;
}

/** New-task defaults (PATCH /api/providers/defaults, `provider:defaults`). */
interface AgentDefaults {
  provider?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

/* ───────────────────────── sessions (live turns) ───────────────────────── */

/** One live subagent card in the fleet board (`session:agents` roster). */
interface AgentInfo {
  n: number;
  type?: string;
  desc?: string;
  status?: 'running' | 'done' | 'failed' | string;
  summary?: string;
  tools?: number;
  tokens?: number;
  /** Live elapsed, frozen at completion. */
  ms?: number;
  /** Client stamp of the running→done transition (backs "Xm ago"). */
  _doneAt?: number | null;
  [k: string]: any;
}

/** The running turn's live ✎ file-edit aggregate (`session:edits`). */
interface EditsAggregate {
  files?: number;
  created?: number;
  modified?: number;
  deleted?: number;
  adds?: number;
  dels?: number;
  [k: string]: any;
}

/** activeSessions() rows in the snapshot. */
interface SessionInfo {
  project: ProjectKey;
  id: string;
  startedAt?: string | number;
  turnStartedAt?: string | null;
  activity?: { label: string } | null;
  status?: string;
  agents?: AgentInfo[];
  edits?: EditsAggregate | null;
  [k: string]: any;
}

/** An approval card awaiting an answer (`session:permission`). */
interface PermRequest {
  requestId?: string;
  tool?: string;
  input?: any;
  [k: string]: any;
}

/* ───────────────────────── runs / jobs ───────────────────────── */

/** runner.js run info (snapshot `runs[project]`, `run:status` payloads). */
interface RunInfo {
  rel?: string;
  cmdLine?: string;
  state?: 'running' | 'done' | 'error' | 'stopped' | string;
  exitCode?: number | null;
  startedAt?: string | number;
  ms?: number | null;
  /** Quiet builds (.tex runs): live pass boundary, null once finished. */
  pass?: { n?: number; rule?: string } | null;
  pages?: number | null;
  problems?: TexProblem[];
  counts?: { errors?: number; warnings?: number; [k: string]: any };
  /** Cumulative output bytes — run:stream replay guard baseline. */
  bytes?: number;
  /** Server-kept output tail (snapshot only; stripped into runBufs). */
  tail?: string;
  taskId?: string | null;
  [k: string]: any;
}

interface JobProgress {
  frac?: number | null;
  iter?: number | null;
  total?: number | null;
  etaS?: number | null;
  [k: string]: any;
}

/** lib/jobs.js live job card (snapshot `jobs[]`, `job:status` payloads). */
interface JobInfo {
  key: string;
  source?: 'session' | 'run' | string;
  project?: ProjectKey;
  taskId?: string | null;
  file?: string | null;
  lang?: string | null;
  state?: 'running' | 'done' | 'error' | 'stopped' | string;
  stopping?: boolean;
  startedAt?: number | string;
  elapsedMs?: number;
  pid?: number | null;
  cpu?: number | null;
  mem?: number | null;
  progress?: JobProgress | null;
  quietMs?: number | null;
  exitCode?: number | null;
  ms?: number | null;
  bg?: boolean;
  detached?: boolean;
  inline?: boolean;
  description?: string;
  /** Client stamp (perf.now at receipt) driving the local 1s clock. */
  _recvAt?: number;
  [k: string]: any;
}

/* ───────────────────────── texfix / kaimon / update ───────────────────────── */

interface TexFixSuggestion {
  id?: string;
  file?: string;
  find?: string;
  replace?: string;
  why?: string;
  status?: 'open' | 'approved' | 'dismissed' | 'stale' | string;
  [k: string]: any;
}

/** lib/texfix.js fix state (snapshot `texfix[project]`, `texfix:status`). */
interface TexFixState {
  state?: 'running' | 'done' | 'error' | string;
  startedAt?: number | string;
  ms?: number | null;
  model?: string;
  taskId?: string | null;
  tex?: string;
  suggestions?: TexFixSuggestion[];
  note?: string;
  error?: string;
  costUsd?: number;
  [k: string]: any;
}

/** lib/kaimon.js warm-REPL state (snapshot `kaimon`, `kaimon:status`). */
interface KaimonState {
  enabled?: boolean;
  available?: boolean;
  julia?: { [project: string]: boolean };
  daemon?: { state?: string; port?: number; [k: string]: any } | null;
  install?: { state?: string; error?: string; tail?: string; [k: string]: any };
  [k: string]: any;
}

/** lib/updater.js status (snapshot `update`, `update:status`). */
interface UpdateStatus {
  state?: 'unknown' | 'unavailable' | 'checking' | 'ok' | 'behind' | 'updating' | 'error' | string;
  behind?: number;
  ahead?: number;
  dirty?: boolean;
  branch?: string | null;
  upstream?: string | null;
  head?: string | null;
  /** ≤12 incoming. */
  commits?: { sha?: string; subject?: string }[];
  lastChecked?: number | string | null;
  error?: string | null;
  updated?: any;
  [k: string]: any;
}

/** lib/tailnet.js status (snapshot `tailnet`, `tailnet:status`). */
interface TailnetStatus {
  state?: 'checking' | 'off' | 'live' | 'disconnected' | 'unavailable' | 'conflict' | 'error' | string;
  available?: boolean;
  connected?: boolean;
  configured?: boolean;
  shared?: boolean;
  backendState?: string;
  url?: string;
  target?: string;
  error?: string | null;
  checkedAt?: string | null;
  canManage?: boolean;
  [k: string]: any;
}

/* ───────────────────────── snapshots (Δ change history) ───────────────────────── */

interface SnapFileChange {
  rel: string;
  status?: string;
  /** Edit tool calls that hit the file this turn. */
  edits?: number;
  adds?: number;
  dels?: number;
  /** Granted external pin (abs-path rel convention). */
  external?: boolean;
  [k: string]: any;
}

/** One change-set journal entry (`snapshot:new`, GET /api/snapshots). */
interface SnapshotEntry {
  id: string;
  task?: string;
  ts?: number | string;
  files?: SnapFileChange[];
  adds?: number;
  dels?: number;
  [k: string]: any;
}

/* ───────────────────────── plan (◆ next up + ⧉ calendar) ───────────────────────── */

interface PlanDeadline {
  id?: string;
  title?: string;
  /** Day-only ISO date. */
  date?: string;
  /** Optional http(s) conference/CFP link ('' if none). */
  url?: string;
  created?: string;
  [k: string]: any;
}

/** icsUrl is a SECRET and never reaches the client — not in this shape. */
interface PlanCalSource {
  id?: string;
  name?: string;
  count?: number;
  error?: string | null;
  fetched?: number | string | null;
  [k: string]: any;
}

interface PlanState {
  deadlines?: { [project: string]: PlanDeadline[] };
  cal?: {
    sources?: PlanCalSource[];
    includeAllDay?: boolean;
    routes?: { [uid: string]: { to?: string; [k: string]: any } };
    events?: { [k: string]: any }[];
    fetched?: number | string | null;
    [k: string]: any;
  };
}

/* ───────────────────────── decisions ledger ───────────────────────── */

interface DecisionEntry {
  id?: string;
  text?: string;
  scope?: 'prose' | 'code' | 'math' | 'all' | string;
  source?: string;
  created?: string;
  /** Entries are RETIRED, never deleted (audit trail). */
  status?: 'active' | 'retired' | string;
  [k: string]: any;
}

/** decisions/<project>.json (snapshot `decisions[key]`, `decisions:update`). */
interface DecisionsState {
  standing?: string;
  entries?: DecisionEntry[];
}

/* ───────────────────────── GET /api/state snapshot ───────────────────────── */

/** The full snapshot — also the shape of public/store.js's `state` object
 *  (client-side, `jobs` is decanted into jobsLive and `runs[].tail` into
 *  runBufs by applyState; `user`/`auth`/`decisions` are assigned post-boot). */
interface StateSnapshot {
  projects: { [key: string]: ProjectInfo };
  categories: { [key: string]: CategoryInfo };
  abstracts: { [key: string]: string };
  tasks: { [key: string]: Task[] };
  artifacts: ArtifactInfo[];
  pdf: { [key: string]: PdfWatchEntry };
  ledger: LedgerSummary | null;
  providers: { [provider: string]: ProviderState };
  agentDefaults: AgentDefaults;
  sessions: SessionInfo[];
  runs: { [key: string]: RunInfo };
  texfix: { [key: string]: TexFixState };
  kaimon: KaimonState;
  update: UpdateStatus;
  tailnet: TailnetStatus;
  plan: PlanState;
  auth?: AuthState;
  /** GET /api/profile card ({} before first generate). */
  user?: { name?: string; [k: string]: any };
  jobs?: JobInfo[];
  decisions?: { [key: string]: DecisionsState };
  [k: string]: any;
}

/* ───────────────────────── WS events (server → client) ───────────────────────── */

/** Event-type → payload map. Names are frozen (CONTRACT.md); `tick` is the
 *  liveness heartbeat clients need no handler case for. */
type WsEventMap = {
  'state': StateSnapshot;
  'task:update': { project: ProjectKey; task: Task };
  'task:delete': { project: ProjectKey; id: string };
  'session:stream': { project: ProjectKey; id: string; chunk: string };
  'session:activity': { project: ProjectKey; id: string; turnStartedAt: string; activity: { label: string } | null };
  'session:status': {
    project: ProjectKey; id: string; status?: string;
    turnStartedAt?: string;
    tokens?: { in?: number; out?: number }; costUsd?: number;
    error?: string; authNeeded?: boolean; provider?: string;
  };
  'session:agents': { project: ProjectKey; id: string; agents: AgentInfo[] };
  'session:edits': { project: ProjectKey; id: string; edits: EditsAggregate | null };
  'session:permission': {
    project: ProjectKey; id: string; requestId?: string; tool?: string; input?: any;
  };
  'session:permission:resolved': {
    project: ProjectKey; id: string; requestId?: string; allow?: boolean;
  };
  'artifact:new': { artifact: ArtifactInfo };
  'pdf:status': { project: ProjectKey; entry: PdfWatchEntry };
  'ledger:update': LedgerSummary;
  'provider:status': { provider: string; state: ProviderState };
  'provider:defaults': AgentDefaults;
  'run:status': { project: ProjectKey; run: RunInfo | null };
  'run:stream': { project: ProjectKey; chunk: string; off?: number; fd?: number };
  'snapshot:new': { project: ProjectKey; entry: SnapshotEntry };
  'file:changed': { project: ProjectKey; rel: string };
  'job:status': { project: ProjectKey; job: JobInfo };
  'auth:status': AuthState;
  'update:status': UpdateStatus;
  'tailnet:status': TailnetStatus;
  'texfix:status': { project: ProjectKey; fix: TexFixState | null };
  'kaimon:status': KaimonState;
  'decisions:update': { project: ProjectKey; decisions: DecisionsState };
  'plan:update': { [k: string]: any };
  'tick': { t?: number };
};

type WsEventType = keyof WsEventMap;

/** The wire frame: `{type, payload}` discriminated on `type` — handleEvent
 *  receives the two halves split (`handleEvent(msg.type, msg.payload)`). */
type WsEvent = { [K in WsEventType]: { type: K; payload: WsEventMap[K] } }[WsEventType];

/* ───────────────────────── shared-store shapes (store.js) ───────────────────────── */

/** Per-project UI state (ui.per[key]) — a deliberate grab-bag: renderWB and
 *  friends stash view state here (taskId, fileTab, viewerKey, openExtra,
 *  openDirs, snapView, interrupting, …). */
interface PerProject {
  taskId?: string | null;
  /** Center tab: pin index | 'tail' (≋ console) | 'x:<rel>' extra | null. */
  fileTab?: number | string | null;
  viewerKey?: string | null;
  openExtra?: string[];
  [k: string]: any;
}

interface UiState {
  /** 'ov' | 'cats' | 'manage' | 'about' | 'settings' | 'catman' | 'plan' | projectKey */
  view: string;
  per: { [key: string]: PerProject };
  /** Expanded `${project}::${category}` rows on the manage page. */
  manageOpen: Set<string>;
}

/** fileCache entry: text+mtime, or a load-state marker. */
interface FileCacheEntry {
  text?: string;
  mtimeMs?: number;
  error?: any;
  loading?: boolean;
  truncated?: boolean;
  binary?: boolean;
  [k: string]: any;
}

/** edViews entry — the editor's place, kept across tab round-trips. */
interface EdView {
  scrollTop?: number;
  scrollLeft?: number;
  selStart?: number;
  selEnd?: number;
}

interface TranscriptEntry {
  role?: string;
  text?: string;
  ts?: string | number;
  /** Which provider produced an assistant entry (mixed-provider tasks). */
  provider?: string;
  /** The "— turn done · … —" divider saved on the assistant entry. */
  turnLine?: string;
  [k: string]: any;
}

/** htmlEdits entry — live WYSIWYG html edit state. */
interface HtmlEditState {
  rel?: string;
  doctype?: string;
  baseMtimeMs?: number;
  dirty?: boolean;
  /** Edits made while the PUT is in flight bump gen. */
  gen?: number;
  [k: string]: any;
}

/** snapFileCache entry — blobs for the Δ diff view. */
interface SnapBlobEntry {
  before?: string;
  after?: string;
  status?: string;
  loading?: boolean;
  error?: any;
  [k: string]: any;
}

/** runSegs entry — run output segment, stderr-tagged. */
interface RunSeg { fd?: number; text: string }

/** consoleView entry — console scroll kept across task switches. */
interface ConsoleViewState { scrollTop?: number; follow?: boolean }

/** feedCache entry — ◷ Recent activity items (GET /api/feed/:project).
 *  `ts` is an ISO string from all three sources (Δ journal, job history,
 *  task-done log notes). */
interface FeedItem {
  kind?: 'edits' | 'run' | 'done' | string;
  ts?: string;
  taskId?: string | null;
  [k: string]: any;
}

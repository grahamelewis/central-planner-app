// types/globals.d.ts — ambient declarations for the frontend's globals
// (phase 2, typing slice). Three groups:
//   1. CDN deferred-script globals (marked, DOMPurify, KaTeX auto-render) —
//      all undefined-able: the scripts load deferred, every use is call-time
//      guarded (`if (window.marked && …)`).
//   2. Test hooks + app-globals on window (uiHarness contract).
//   3. Lenient DOM shims: this codebase addresses querySelector/closest
//      results and e.target as concrete HTML elements, and stamps private
//      `_x` expandos on elements it owns. Rather than casting at ~150 call
//      sites (casts would edit executable text — forbidden this phase), the
//      members used are declared on Element/EventTarget/Event here. This is
//      a deliberate phase-2 leniency, not a claim about arbitrary Elements.
// Types only — no runtime code.

/* ───────────────── 1. CDN deferred-script globals ───────────────── */

/** marked v12 UMD surface (the two engine instances mdEngine() builds). */
interface MarkedInstance {
  use(opts: { [k: string]: any }): MarkedInstance;
  parse(src: string, opts?: { [k: string]: any }): string;
}
interface MarkedGlobal {
  Marked: new () => MarkedInstance;
  parse?(src: string, opts?: { [k: string]: any }): string;
}
declare var marked: MarkedGlobal | undefined;

interface DOMPurifyGlobal {
  sanitize(html: string, cfg?: { [k: string]: any }): string;
}
declare var DOMPurify: DOMPurifyGlobal | undefined;

/** KaTeX auto-render extension (contrib). */
declare function renderMathInElement(
  el: Element,
  opts?: { delimiters?: { left: string; right: string; display: boolean }[]; [k: string]: any }
): void;

/** KaTeX core (loaded with the auto-render script). */
declare var katex: { render?: Function; renderToString?: Function; [k: string]: any } | undefined;

/** Browser speech-recognition constructor (prefixed on Chrome). */
interface SpeechRecognitionCtor { new (): any }

/* ───────────────── 2. window: test hooks + app globals ───────────────── */

interface Window {
  /* CDN globals mirrored for the `window.x &&` feature checks */
  marked?: MarkedGlobal;
  DOMPurify?: DOMPurifyGlobal;
  renderMathInElement?: typeof renderMathInElement;
  katex?: typeof katex;
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;

  /* test hooks (uiHarness.mjs contract — see CONTRACT.md phase-2 addendum) */
  /** util.js merge3 — exercised directly by merge tests. */
  __merge3?: (baseText: string, oursText: string, theirsText: string) => any;
  /** console.js parseTexMacros — macro-harvest tests. */
  __parseTexMacros?: (text: string) => { [name: string]: any };
  /** net.js staleness sweep — wake-from-sleep tests call it with fake quiet. */
  __wsCloseIfStale?: (quietMs?: number) => void;
  /** store.js pdfPanes — debug handle for out-of-repo QA probe scripts. */
  __pdfPanes?: { [paneKey: string]: PdfPane };
  /** harness-side: the stubbed WebSocket instance (set by uiHarness, not app code) */
  __ws?: any;
  /** harness-side: JSON frames the page tried to send */
  __wsSent?: string[];

  /* app one-shot wiring flags */
  /** session.js dropdown portal: document-level close listener wired once. */
  _dropCloseWired?: boolean;
}

/* ───────────────── 3. lenient DOM shims ───────────────── */

/** Members this app reads off `e.target` without an instanceof gate.
 *  Optional: absent on non-element targets, which the call sites tolerate
 *  (strictNullChecks is off this phase). */
interface EventTarget {
  closest?(selectors: string): HTMLElement | null;
  value?: string;
  tagName?: string;
  id?: string;
  checked?: boolean;
  type?: string;
  isContentEditable?: boolean;
}

/** Generic-listener sites (dynamic event names) receive base `Event`;
 *  the app reads these members guarded by the wiring context. */
interface Event {
  key?: string;
  shiftKey?: boolean;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
}

interface Element {
  /* HTMLElement-family members read on querySelector/closest results.
     (Conflicting derived declarations — e.g. HTMLProgressElement.value:
     number — are tolerated under skipLibCheck; concrete interfaces keep
     their own member types.) */
  dataset: DOMStringMap;
  style: CSSStyleDeclaration;
  value: string;
  /** string | boolean matches lib.dom's HTMLElement.hidden ("until-found"). */
  hidden: string | boolean;
  title: string;
  disabled: boolean;
  checked: boolean;
  open: boolean;
  src: string;
  href: string;
  rel: string;
  target: string;
  offsetWidth: number;
  offsetHeight: number;
  offsetTop: number;
  offsetLeft: number;
  selectionStart: number;
  selectionEnd: number;
  isContentEditable: boolean;
  contentDocument: Document | null;
  /** `Window | null` matches lib.dom's HTMLIFrameElement.contentWindow. */
  contentWindow: Window | null;
  focus(options?: FocusOptions): void;
  blur(): void;
  click(): void;
  select(): void;
  setSelectionRange(start: number, end: number, direction?: string): void;

  /* app expandos — private state stamped on elements the app owns */
  /** run output pre: live character count vs the 200k cap. */
  _chars?: number;
  /** console box: sticky-scroll follow flag. */
  _follow?: boolean;
  /** console/md panes: texMacroRev stamp — re-typeset on mismatch. */
  _mac?: number;
  /** md pane: source signature of the last patch. */
  _src?: string;
  /** job cards: key + last-painted job snapshot + progress state. */
  _jobKey?: string;
  _job?: JobInfo | null;
  _prog?: number | null;
  /** editor ↔ overlay: synchronous pan re-sync (exposed by wireWB). */
  _hlSync?: (() => void) | null;
  /** editor: wrap-aware caret point for texEditor's completion popup. */
  _caretXY?: (() => { x: number; y: number }) | null;
  /** session pane: composer autosize cap, refreshed each wiring pass. */
  _taCapFn?: (() => void) | null;
  _taCap?: number;
  /** rpb: viewer/session split re-clamp (ResizeObserver hook). */
  _vsClamp?: (() => void) | null;
  /** generic one-shot wiring flags / small per-element stashes */
  _wired?: boolean;
  _rel?: string;
  _txt?: string;
  _st?: any;
  _sig?: string;
  _reqId?: string;
  _n?: number;
  _raw?: any;
}

/* ───────────────── vendor pane surface (public/pdfPane.d.ts uses these) ───────────────── */

/** Options for createPdfPane (pdfPane.js — contents off-limits this phase;
 *  surface typed here + in the public/pdfPane.d.ts sidecar). */
interface PdfPaneOptions {
  /** dblclick a page → inverse SyncTeX (PDF points, top-left origin). */
  onSyncEdit?: (page: number, x: number, y: number) => void;
  /** Build the staged bar + verdict chip (quiet builds). */
  buildStatus?: boolean;
  onVerdictClick?: (lastBuildState?: string) => void;
  /** ▶ toolbar control click (meaning lives in the caller + setRun state). */
  onRunClick?: () => void;
}

/** The live PDF.js pane object createPdfPane returns. */
interface PdfPane {
  el: HTMLElement;
  doc: any;
  boxes: any[];
  scale: number;
  fit: boolean;
  savedScroll: number;
  builtStamp: string | number | null;
  generation: number;
  lastBuildState?: string;
  /** viewers.js stamps the sibling-`.tex` probe result on pdfart panes. */
  texRel?: string | null;
  load(url: string, opts?: { keepPlace?: boolean; builtStamp?: string | number | null }): Promise<void>;
  scrollTo(target: { page: number; v?: number | null; H?: number | null; h?: number | null; W?: number | null }): void;
  scrollToPage(n: number): void;
  setRun(o?: { show?: boolean; running?: boolean; dirty?: boolean; title?: string }): void;
  setBuildStatus(e: PdfWatchEntry): void;
  restoreScroll(): void;
  refit(): void;
  destroy(): void;
  [k: string]: any;
}

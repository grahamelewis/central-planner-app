// pdfPane.d.ts — type sidecar for pdfPane.js (phase 2, typing slice).
// pdfPane.js is one of the three pre-split modules whose CONTENTS are
// off-limits; this declaration file shadows it for the type-checker only
// (tsconfig excludes the .js; import resolution prefers the .d.ts), so its
// import surface is typed without touching a byte of the runtime file.
// The browser still loads pdfPane.js unchanged — this file is never served.
// PdfPaneOptions / PdfPane / PdfWatchEntry are global (types/globals.d.ts,
// types/contract.d.ts).

/** Honest progress stop for pass n of the staged build bar. */
export function passFrac(n?: number | null): number;
/** Creep ceiling: just under the next pass stop — never past it. */
export function creepTarget(n?: number | null): number;
/** The one long front-loaded bar transition. */
export const CREEP_EASE: string;
/** Build the in-app PDF.js pane (virtualized pages, keep-place reloads,
 *  zoom, SyncTeX both ways, optional staged build bar + ▶ run control). */
export function createPdfPane(opts?: PdfPaneOptions): PdfPane;

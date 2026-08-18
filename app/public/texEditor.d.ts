// texEditor.d.ts — type sidecar for texEditor.js (phase 2, typing slice).
// texEditor.js is one of the three pre-split modules whose CONTENTS are
// off-limits; this declaration file shadows it for the type-checker only
// (tsconfig excludes the .js; import resolution prefers the .d.ts), so its
// import surface is typed without touching a byte of the runtime file.
// The browser still loads texEditor.js unchanged — this file is never served.
// Parameter types stay lenient (`any` for the editor element): callers hold
// loosely-typed DOM references and the runtime accepts any textarea-like.

/** Extensions the LaTeX editor chrome engages for. */
export const TEX_EXTS: string[];
/** Wire completion popup, auto-pairs, auto-\end, ⌘/ toggle, ⌘J sync onto an
 *  editor textarea. Returns the detach/refresh handle texEditor keeps. */
export function texEditorAttach(ed: any, opts?: { [k: string]: any }): any;
/** ⌘/ — toggle % comments on the selected lines. */
export function toggleComment(ed: any): void;
/** § outline rows parsed from the buffer text. */
export function texOutline(text: string): { [k: string]: any }[];
/** Open the § outline menu anchored to btn; jumpToLine navigates. */
export function texOutlineMenu(btn: any, ed: any, jumpToLine: (line: number) => void): void;
/** Flash the landed-on line after an outline/SyncTeX jump. */
export function texJumpFlash(codeEl: any, line: number): void;
/** Paint problem-line decorations (file-line-error problems) for rel. */
export function texMarkLines(codeEl: any, problems: TexProblem[] | null | undefined, rel?: string | null): void;

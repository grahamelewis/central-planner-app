// Shared LaTeX UI, independent of the editor implementation.
import { texOutline } from './texCore.js';
import { esc } from '../util.js';

export const TEX_EXTS = ['tex', 'sty', 'cls', 'bib'];

/** Open the section outline for a snapshot of the current buffer. */
export function texOutlineMenu(btn, ed, jumpToLine) {
  document.getElementById('texOutlineMenu')?.remove();
  const entries = texOutline(ed.value);
  const menu = document.createElement('div');
  menu.id = 'texOutlineMenu';
  menu.innerHTML = entries.length
    ? entries.map(s => `<div class="pmItem" data-ln="${s.line}" style="padding-left:${13 + s.depth * 14}px">${esc(s.title)}</div>`).join('')
    : '<div class="pmItem" style="cursor:default">no \\section headings yet</div>';
  btn.parentElement.appendChild(menu);
  menu.querySelectorAll('.pmItem[data-ln]').forEach(it => it.addEventListener('click', () => {
    jumpToLine(Number(/** @type {HTMLElement} */ (it).dataset.ln));
  }));
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

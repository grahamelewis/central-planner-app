// pinkinds.js — the ONE list of pin kinds by file name, shared verbatim by the
// server (lib/pins.js → pinKind, the cards) and the browser (util.js →
// pinKindOf, isDataFile, isManifestFile). Pure data + pure functions: no DOM,
// no node imports, so both sides can load it. Lives in public/ because the
// browser needs it served; lib/pins.js imports it by relative path.

/** Data files: pinned as a schema card (columns · types · sample), never the contents. */
export const DATA_EXTS = ['csv', 'tsv', 'parquet', 'dta', 'rds', 'rdata', 'feather', 'xlsx', 'xls'];

/**
 * Project manifests: pinned as a compact "manifest card" (name · version ·
 * deps · scripts/targets) the session can read at a glance. Keyed by exact
 * basename → { format, label }. Note the case-exact names: Cargo.toml and
 * CMakeLists.txt are always spelled this way; make accepts three spellings.
 * @type {{ [basename: string]: { format: string, label: string } }}
 */
export const MANIFEST_NAMES = {
  'Cargo.toml': { format: 'cargo', label: 'Rust · cargo' },
  'package.json': { format: 'npm', label: 'Node · npm' },
  'go.mod': { format: 'gomod', label: 'Go · modules' },
  'CMakeLists.txt': { format: 'cmake', label: 'C/C++ · CMake' },
  'Makefile': { format: 'make', label: 'make' },
  'makefile': { format: 'make', label: 'make' },
  'GNUmakefile': { format: 'make', label: 'make' },
};

/** @param {*} f path or name */
export const basenameOf = (f) => String(f || '').replace(/\/+$/, '').split('/').pop();

/**
 * Manifest descriptor for a path, or null when the basename is not a manifest.
 * @param {*} f
 * @returns {{ format: string, label: string } | null}
 */
export const manifestOf = (f) => Object.prototype.hasOwnProperty.call(MANIFEST_NAMES, basenameOf(f))
  ? MANIFEST_NAMES[basenameOf(f)] : null;

/** @param {*} f */
export const isDataExt = (f) => DATA_EXTS.includes(String(f || '').split('.').pop().toLowerCase());

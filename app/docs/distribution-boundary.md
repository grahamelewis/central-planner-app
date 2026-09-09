# Source, local research, and production releases

## Policy

| Content | Development Git | Production release |
| --- | --- | --- |
| Reviewed server/client code, assets, runtime safety checks | Keep | Include explicitly |
| Regression tests, synthetic fixtures, safety harnesses, maintained Markdown docs | Keep | Exclude |
| Exploratory HTML, experiments, generated renders/logs, personal design notes | Local only | Exclude |
| User configuration, tasks, transcripts, memory, credentials | Never commit | Preserve in separate data root |

Use `.local/` for new local investigations and `.artifacts/` for generated
output. Existing ignored research paths remain usable locally. Do not ban HTML,
JSON, or images by extension: essential UI and regression fixtures use them.
Reviewed test goldens are fixtures, not disposable renders.

`npm run check:boundary` (in `app/`) checks the actual Git index, including
already-tracked/force-added files. `npm run setup:hooks` installs the local
pre-commit guard, refusing to overwrite another hook configuration. CI repeats
the check, tests the source, builds a production artifact, verifies its complete
payload inventory, and smoke-tests the installed server. Hooks can be bypassed;
the CI job is a backstop, not a claim of remote branch-protection enforcement.

## Production payload

`release-manifest.json` is an exact reviewed list, not a recursive copy of
`app/`. New runtime files must be added explicitly. Missing literal imports,
HTML assets, PWA icons, private/development paths, symlinks, extra files and
changed payload hashes fail verification. Dynamic routes need smoke tests too.
Production dependencies come from `npm ci --omit=dev`. Their identities, locked
versions, required Monaco/PDF assets, development-only exclusions, and symlink
containment are checked; their individual contents are not all hashed by our
verifier. Third-party packages may contain their own upstream documentation or
tests; our project's tests/research never enter the application payload.

From the source checkout:

```sh
node app/scripts/release.mjs build --out /absolute/fresh-stage --install
node app/scripts/release.mjs verify /absolute/fresh-stage --require-dependencies
node app/scripts/smoke-runtime.mjs /absolute/fresh-stage
```

These commands do not activate a release. The destination's parent must already
exist; the destination must be new and outside the source. Smoke tests use a
temporary data root, no model calls, and disabled external integrations.

## Install and upgrade

Use three explicit locations: a clean committed **source checkout**, a separate
**installation directory**, and the existing **data root**. Source and data may
still share the old checkout for compatibility, but the installation must not
contain or be inside either. A dedicated source checkout is preferable. Never
run Git pull or a blanket cleanup inside the installation or data directory.

```sh
node app/scripts/deploy.mjs --source /absolute/source --installation /absolute/runtime --data-root /absolute/existing-data
```

The installer refuses dirty/untracked source changes, unrelated existing
directories, redirected paths, and concurrent installs. It creates a new
`releases/release-<uuid>/`, installs and verifies dependencies, then atomically
selects it in `deployment.json`. An interrupted/failed stage leaves the current
selection unchanged. Old and failed stages are retained, never auto-cleaned.
The code does not modify configuration, tasks, transcripts, or memory.

Start the selected version with `node /absolute/runtime/app/server.js`, or point
the desktop shell's `CP_REPO` / persisted `server-location.json` at the runtime
directory. The desktop shell must be updated/repacked for installation-aware
port resolution. Its launcher explicitly pins `CP_ROOT` to the preserved data
root and checks that it still exists before startup. Shipped category defaults
remain available when that data root has no categories file.

In an installed runtime, the Settings updater fetches the separate source
checkout, stages/verifies a fresh release, and changes the selection. A failed
build can be retried even if the source checkout already advanced. Restart is
explicit; an already-running process stays on its old release. A development
checkout retains its legacy source-update workflow; merely pulling these changes
does not migrate that checkout into a production installation.

Rollback selects the verified previous release without touching user data:

```sh
node app/scripts/deploy.mjs --rollback --installation /absolute/runtime
```

Restart afterward. A leftover `.deployment.lock` means an interrupted operation
needs review; do not delete it until no deployment process is running.

## First migration and historical research

Sixty previously tracked exploratory/render files were removed from the Git
index while preserving every local copy in the development checkout. This does
not erase previous Git history. **Before the first pull into any other existing
checkout, back up its copies of those research files outside the checkout:** Git
can remove unchanged tracked copies when applying their removal commit. Do not
confuse `.gitignore` with a backup or a deployment filter.

No live Dropbox migration is performed by setting up this tooling. Before that
separate migration: preserve research, confirm and back up the existing data
root, commit reviewed source, stage/smoke-test a release, stop the old server,
update the desktop/launchd target and port handling, and start exactly one server.
Confirm existing projects, conversations and memory remain visible. Retain the
old launch configuration and release for rollback.

## Verification of this implementation (September 9, 2026)

- Full non-UI application suite, concurrency four: 1,290 passed, zero failed,
  five skipped. An earlier default-concurrency run timed out in the existing
  Julia process-discovery test; that test passed in isolation and in the final
  full run. No process-discovery code was changed for this boundary work.
- Desktop suite: 69 passed. Type checking and staged/unstaged diff checks passed.
- A real production-only dependency install and server smoke test passed for
  the final artifact in a temporary directory, with isolated data and no model
  requests. The test covered desktop/mobile pages, Monaco/PDF assets, APIs,
  category defaults, user-report access, and rejected development/control URLs.
- Independent agent reviews and regression tests exercised failed-stage retry,
  rollback, preserved data, root redirects, tampering, concurrent installs,
  custom desktop ports, and forced-add commit rejection.
- The development checkout's pre-commit hook is enabled. All 60 local research
  copies remain present; only their Git-index entries were removed.

These are local verification results, not a claim that GitHub CI has run or
that the live Dropbox installation has been migrated. No commit/push, desktop
repack, or live server restart was performed in this implementation.

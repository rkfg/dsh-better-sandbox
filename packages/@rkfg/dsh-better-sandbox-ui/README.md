# @rkfg/dsh-better-sandbox-ui

Settings section **Sandbox** for the better-sandbox plugin: four text areas (one path per line) for write grants, read-protected directories, read-protected files and protected path names, plus a one-line field naming the escalation level that opens those names for one approved call. Saving writes the profile patch through the harness settings layer, and the running session switches to the new rules without a restart. Russian copy: [README.ru.md](README.ru.md).

## Why a separate package

A package declaring `dsh.client` must own exactly one Loader entry, otherwise the whole web boot fails with `client-modules: package … resolves from multiple active Loader sources`. The host half of the plugin has six entries, so the client half lives here with a single trivial entry (`index.js`).

## Composition

| File | Role |
|---|---|
| `index.js` | the single host entry (an empty service) |
| `client.js` | registers the `settings.section` slot, renders the form, reads and writes the config |
| `cordis.patch.yml` | bundle layer: that one entry |
| `locale/en.json`, `locale/zh.json` | display metadata shown in Plugin Manager and the Settings inventory |

The client bundle registers itself through `window.__ModuleLoader__.load` with an `id` that must equal the package name: the browser module table keys on that id, and a mismatch produces `duplicate factory registration` plus a dead page while the host side stays healthy. `scripts/check.sh` verifies the equality.

The client declares the services it needs by name: `slots`, `locale`, `connection`, `remote`, `remote.settings`. UI strings exist in `en` and `zh` only — those are the two languages the harness interface supports.

## Why the form does not use its own Remote namespace

Per `cookbook/adding-a-remote-api.md`, a client consuming a plugin namespace must inject `remote.<namespace>`, and that namespace exists only because the build pipeline generates the `./typert` and `./remote` artifacts. A hand-written JavaScript package has no such artifacts, so the form reads `ctx.remote.settings.describe()` (no arguments) and writes `ctx.remote.settings.update('better-sandbox', patch, revision)` — the same path the built-in settings dialog uses. The host-side `sandboxGuard` service remains available to tools and tests.

## Validation

The form checks each field before saving and refuses to write while a field has
problems, listing them in red under that field. Three kinds of fields have three
kinds of rules: path fields need an absolute path or `~/…` (and reject the `~user`
form), while the protected-names field expects a single component such as `.git` — a
name with a separator there is an error, and `.git` itself is correct. The escalation
level is not a list: it is saved as one string, must be a single lowercase word, and
must not borrow a mode name from the harness ladder (`read-only`, `workspace-write`,
`danger-full-access`); an empty value turns the level off. Duplicates inside one list
are rejected in both list kinds.
Existence is deliberately not checked here — the browser cannot reach the plugin
service — so a rule for a directory that does not exist yet is accepted and stays
inert until it appears. `test/settings-ui-probe.mjs` drives this in a real
browser: it opens the section, writes unusable rules and an unusable level name,
presses Save and asserts that every caption appeared and the write was blocked.

## Concurrent edits

`describe()` returns the values together with a document revision, and `update()`
carries that revision back: a write built on a stale snapshot is refused with
`SETTINGS_CONFLICT` instead of silently overwriting someone else's change (the
profile patch is editable from several tabs, the plugin manager, the CLI and a text
editor at once). On that refusal the form keeps what the user typed, refreshes the
revision and asks to save again.

In practice the conflict is rare: the settings layer notifies open forms about
document changes (`settings/document-updated`), and an open section re-reads its
snapshot on its own — observed in a two-tab run, where the second tab's save moved
the revision under the first tab before it pressed Save. The conflict branch is the
fallback for the narrow race between that refresh and the click. The revision guard
itself is covered by `test/revision-probe.js` (`DSH_PROBE=revision`).

## Model Experience

### Influence on the model context

Indirectly, through `@rkfg/dsh-better-sandbox`: the lists saved here decide which announcement lines reach the runtime context and which paths produce read refusals.

#### Token effect

Zero-direct: the section itself adds nothing to the model context.

#### KV Cache effect

Independent: prefix reuse is affected only by the announcement block owned by `@rkfg/dsh-better-sandbox`.

## Known Limitations and Deferred Work

- **No existence check in the form** — the page cannot call the plugin service (a client namespace needs the generated `./typert` and `./remote` artifacts, which this package does not have), so it validates syntax only, including rejecting a rule for the whole filesystem; a rule pointing at a missing directory is saved and reported by the host as `missing` in `sandboxGuard.state()`, together with every rule the host refused.
- **Volatile fields only** — `denyDepth`, `denyScanTtlMs`, `denySkipDirs`, `maskFallback`, `readDenialSignature` are not shown: provider constructors read them, so they require a restart.
- **No apply-preview** — the form does not show which existing rules changed state (newly readable, newly protected) after a save.

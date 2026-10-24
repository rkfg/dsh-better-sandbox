# dsh-sandbox-allowlist-ui

Settings section **Sandbox** for the sandbox-allowlist plugin: four text areas (one path per line) for write grants, read-protected directories, read-protected files and protected path names. Saving writes the profile patch through the harness settings layer, and the running session switches to the new rules without a restart. Russian copy: [README.ru.md](README.ru.md).

## Why a separate package

A package declaring `dsh.client` must own exactly one Loader entry, otherwise the whole web boot fails with `client-modules: package … resolves from multiple active Loader sources`. The host half of the plugin has six entries, so the client half lives here with a single trivial entry (`index.js`).

## Composition

| File | Role |
|---|---|
| `index.js` | the single host entry (an empty service) |
| `client.js` | registers the `settings.section` slot, renders the form, reads and writes the config |
| `cordis.patch.yml` | bundle layer: that one entry |
| `locale/en.json`, `locale/zh.json` | display metadata shown in Plugin Manager and the Settings inventory |

The client declares the services it needs by name: `slots`, `locale`, `connection`, `remote`, `remote.settings`. UI strings exist in `en` and `zh` only — those are the two languages the harness interface supports.

## Why the form does not use its own Remote namespace

Per `cookbook/adding-a-remote-api.md`, a client consuming a plugin namespace must inject `remote.<namespace>`, and that namespace exists only because the build pipeline generates the `./typert` and `./remote` artifacts. A hand-written JavaScript package has no such artifacts, so the form reads `ctx.remote.settings.describe()` (no arguments) and writes `ctx.remote.settings.update('sandbox-allowlist', patch, revision)` — the same path the built-in settings dialog uses. The host-side `sandboxGuard` service remains available to tools and tests.

## Model Experience

### Influence on the model context

Indirectly, through `dsh-sandbox-allowlist`: the lists saved here decide which announcement lines reach the runtime context and which paths produce read refusals.

#### Token effect

Zero-direct: the section itself adds nothing to the model context.

#### KV Cache effect

Independent: prefix reuse is affected only by the announcement block owned by `dsh-sandbox-allowlist`.

## Known Limitations and Deferred Work

- **No client-side path validation** — `sandboxGuard.validate` on the host rejects paths that would cover the harness or the workspace, but the form saves what it is given; such a rule simply never applies.
- **Volatile fields only** — `denyDepth`, `denyScanTtlMs`, `denySkipDirs`, `maskFallback`, `readDenialSignature` are not shown: provider constructors read them, so they require a restart.
- **No apply-preview** — the form does not show which existing rules changed state (newly readable, newly protected) after a save.

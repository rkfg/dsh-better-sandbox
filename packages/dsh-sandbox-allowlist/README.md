# dsh-sandbox-allowlist (host bundle)

Host half of the sandbox rules plugin: the service that owns the rule lists, the three provider subclasses that enforce them, and a small Remote service that reports the effective state. Russian copy: [README.ru.md](README.ru.md).

## Entries

The bundle layer (`cordis.patch.yml`) disables the built-in providers it replaces and inserts one group with these entries. Disabling them in the bundle layer matters: a user patch that only sets values must not be able to bring the base providers back and silently double-register services.

| Entry | Module | Role |
|---|---|---|
| `sandbox-allowlist` | `lib/allowlist.js` | owns the rule lists, the mask stubs, the prompt announcement, the Remote state |
| `fs-allowlist` | `lib/fs.js` | replaces the `fs` provider: read fence and protected-name checks |
| `sandbox-allowlist-runner` | `lib/runner.js` | replaces `sandbox-local`: extra bwrap binds, widened denial dialect for masked reads |
| `subprocess-guard` | `lib/subprocess.js` | replaces `subprocess-local`: the same binds for ripgrep spawns |
| `sandbox-guard-api` | `lib/guard-api.js` | Remote `sandboxGuard`: `state()`, `validate()` |
| `sandbox-allowlist-bundle` | `lib/bundle.js` | the group that carries the children above |

Profile configuration stays to values only:

```yaml
- id: sandbox-allowlist
  name: dsh-sandbox-allowlist/allowlist
  config:
    writableDirs: [...]
    denySegments: [...]
    readDenyDirs: [...]
    readDenyFiles: [...]
```

## Contract notes

- `ConfinedArgv.denialSignatures` is the dialect of a specific backend. This provider appends `permission denied` only when it actually applied read masks under bwrap, and keeps the base rules untouched otherwise; `runnerFailureRules` are never modified, so a runner failure stays distinguishable from a policy denial.
- The rule lists are read at access time, not in the constructor: the four editable fields are `volatile()`, so they arrive as `{ get() }` references and may change while the entry stays mounted. A derived-value cache is keyed by resolved values and also invalidated by the `loader/volatile-update` event.
- Config is the only source of rules. Nothing is cached in a sidecar file: such a file would outrank the profile patch and hide edits made from the Settings page.
- The mask stubs (`lib/.mask/empty-dir`, `lib/.mask/empty-file`, mode `000`) are passed to bwrap as source paths. Deleting them while the harness runs breaks confinement for every command, so they are verified and recreated before each command.

## Model Experience

### Request context: the sandbox rules announcement

#### What the model sees

A `sandbox:allowlist` block is appended to the runtime context right after the sandbox policy section. It exists only when at least one list is non-empty and `announceInPrompt` is on. Three templates:

##### Verbatim text for this field

```markdown
Additional write roots beyond the session workspace (workspace-write mode only): <quoted paths, comma separated>.
Protected path names inside every writable root (workspace-write mode): <quoted names> — writing there is refused the same way as writing outside the workspace, so escalate once with sandbox_permissions and a justification when the user genuinely needs it.
Protected from reading (secrets and personal data): <quoted directories and files, comma separated> — reading their contents is refused for tools and denied inside sandboxed commands; escalate once with sandbox_permissions and a justification only when the user explicitly needs that file.
```

#### Token effect

Conditional. One line per non-empty rule family, length proportional to the number of paths. Empty lists cost nothing.

#### KV Cache effect

Append-only relative to the sandbox policy section: existing context lines keep their text. Editing the lists through the Settings page replaces the block contents, so prefix reuse is invalidated from that block onwards; the order inside the block is fixed (write roots, protected names, protected reads), so unchanged lists produce identical text.

### Refusals as model-visible text

#### What the model sees

Indirectly, through `dsh-tool-fs` and `dsh-tool-bash`: the fence's refusal text for protected reads and the runner's refusal signature reach the tool result. The package supplies the read-refusal message and widens the bwrap dialect with `permission denied`, so a masked read surfaces as a policy refusal with an escalation hint rather than as an unexplained system error.

#### Token effect

Zero-direct beyond the announcement above: refusal text is paid for as a tool result, which depends on what the model attempted.

#### KV Cache effect

Independent: refusal text belongs to the conversation, not to the system prefix, and does not disturb prefix reuse.

## Known Limitations and Deferred Work

- **bwrap depth for protected names** — names are checked at any depth by the filesystem fence, but confinement binds them only up to `denyDepth`; deeper layouts need a configuration change and a restart.
- **Landlock cannot express the denials** — subtracting a write from a broader rule and denying a subpath read are unavailable, so those rules are skipped with a single warning.
- **Processes outside the seams are uncovered** — the harness' own git integration and MCP servers do not go through `ctx.subprocess`, by design.
- **`git` over SSH stops working inside a confined command** while `~/.ssh` is read-protected; `ssh-agent` or an extracted `known_hosts` is required.
- **Protected directory names stay visible** in a parent listing — the mask replaces the mount point instead of filtering the parent.
- **Validation is host-side** — `sandboxGuard.validate` refuses paths that would cover the harness or the workspace, but the Settings form saves whatever it is given.

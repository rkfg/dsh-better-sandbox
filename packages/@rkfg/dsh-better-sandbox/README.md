# @rkfg/dsh-better-sandbox (host bundle)

Host half of the sandbox rules plugin: the service that owns the rule lists, the three provider subclasses that enforce them, and a small Remote service that reports the effective state. Russian copy: [README.ru.md](README.ru.md).

## Entries

The bundle layer (`cordis.patch.yml`) disables the built-in providers it replaces and inserts one group with these entries. Disabling them in the bundle layer matters: a user patch that only sets values must not be able to bring the base providers back and silently double-register services.

| Entry | Module | Role |
|---|---|---|
| `better-sandbox` | `lib/rules.js` | owns the rule lists, the mask stubs, the prompt announcement, the Remote state |
| `better-sandbox-escalation` | `lib/escalation.js` | puts the named level into the escalation vocabulary: the strict-wider table and the tools' `sandbox_permissions` enums |
| `better-sandbox-fs` | `lib/fs.js` | replaces the `fs` provider: read fence and protected-name checks |
| `better-sandbox-runner` | `lib/runner.js` | replaces `sandbox-local`: extra bwrap binds, widened denial dialect for masked reads |
| `better-sandbox-subprocess` | `lib/subprocess.js` | replaces `subprocess-local`: the same binds for ripgrep spawns |
| `better-sandbox-guard` | `lib/guard-api.js` | Remote `sandboxGuard`: `state()`, `validate()` |
| `better-sandbox-bundle` | `lib/bundle.js` | the group that carries the children above |

Paths may be written with `~` or `~/…`: they are expanded against `os.homedir()`
before anything else, so `~/.cache` and `/home/you/.cache` are the same rule. The
`~user` form is not expanded. Rules that cannot apply are kept in `rejected`
(`relative`, `covers-harness`) and rules pointing at a path that does not exist
are marked `missing` — visible through `sandboxGuard.state()`.

Profile configuration stays to values only:

```yaml
- id: better-sandbox
  name: '@rkfg/dsh-better-sandbox/rules'
  config:
    writableDirs: [...]
    denySegments: [...]
    readDenyDirs: [...]
    readDenyFiles: [...]
    segmentLevel: write-segment
```

### The escalation level

`segmentLevel` names one target the harness ladder does not have. A call that asks for it
runs exactly as `workspace-write` does, with every name from `denySegments` writable, for
that single call and after the user approves the card. `escalation.js` contributes the
vocabulary (`WIDER_MODES` plus the `sandbox_permissions` enum of `bash`, `pwsh`, `write`,
`edit`), `fs.js` and `runner.js` enforce it. An empty value turns the level off; a name
that collides with `read-only`, `workspace-write` or `danger-full-access` is reported once
and disables the level rather than advertising a mode nothing can grant.

The harness fixes its ladder twice: the enum is copied into a tool schema when that tool
is applied, and `approveEscalation` consults `WIDER_MODES` at execution. Neither is a
service the plugin owns, so both are edited on the live objects — the registry stores the
definition it was given, prompt schemas are projected from that same `parameters` object,
and argument validation closes over it. A tool that mounts later is caught by
`tools/change`; everything is undone when the entry stops.

## Contract notes

- `ConfinedArgv.denialSignatures` is the dialect of a specific backend. This provider appends `permission denied` only when it actually applied read masks under bwrap, and keeps the base rules untouched otherwise; `runnerFailureRules` are never modified, so a runner failure stays distinguishable from a policy denial.
- The rule lists are read at access time, not in the constructor: the four editable fields are `volatile()`, so they arrive as `{ get() }` references and may change while the entry stays mounted. A derived-value cache is keyed by resolved values and also invalidated by the `loader/volatile-update` event.
- Config is the only source of rules. Nothing is cached in a sidecar file: such a file would outrank the profile patch and hide edits made from the Settings page.
- The mask stubs (`lib/.mask/empty-dir`, `lib/.mask/empty-file`, mode `000`) are passed to bwrap as source paths. Deleting them while the harness runs breaks confinement for every command, so they are verified and recreated before each command.

## Model Experience

### Request context: the sandbox rules announcement

#### What the model sees

A `sandbox:rules` block is appended to the runtime context right after the sandbox policy section. It exists only when at least one list is non-empty and `announceInPrompt` is on. Three templates:

##### Verbatim text for this field

```markdown
Additional write roots beyond the session workspace (workspace-write mode only): <quoted paths, comma separated>.
Protected path names inside every writable root (workspace-write mode): <quoted names> — writing there is refused the same way as writing outside the workspace.
Escalation level "<token>": when a write or a command is refused only because of one of those names, retry that exact call once with sandbox_permissions set to "<token>" and a one-sentence justification. It opens every name above for that single call, with the user's approval; every other rule stays exactly as it is. Prefer it over a wider mode.
Protected from reading (secrets and personal data): <quoted directories and files, comma separated> — reading their contents is refused for tools and denied inside sandboxed commands. No escalation target of this plugin opens a read, so ask the user to change the rule when the file is genuinely needed.
Sandbox guards are NOT applied here: <reasons>. The rules above still bind the file tools, but commands run without that part of the protection.
```

The escalation line is emitted only when the level is on and at least one protected name
exists. The last line is emitted only while a confinement seam reports that a configured
protection is not in force — an unrecognized runner, a runner that cannot express the rule,
a missing mask stub — and it disappears as soon as the protection applies again. Separately,
`escalation.js` appends one sentence to the `sandbox_permissions` parameter description of
`bash`, `pwsh`, `write` and `edit` — the model learns there that a narrower target than
`danger-full-access` exists, because a refusal from `write` or `edit` is rewritten by the
tool into the shared marker and hint, and the plugin cannot add text to it.

#### Token effect

Conditional. One line per non-empty rule family, length proportional to the number of paths. Empty lists cost nothing.

#### KV Cache effect

Append-only relative to the sandbox policy section: existing context lines keep their text. Editing the lists through the Settings page replaces the block contents, so prefix reuse is invalidated from that block onwards; the order inside the block is fixed (write roots, protected names, protected reads), so unchanged lists produce identical text.

### Refusals as model-visible text

#### What the model sees

Indirectly, through `dsh-tool-fs` and `dsh-tool-bash`: the fence's refusal text for protected reads and the runner's refusal signature reach the tool result. The package supplies the read-refusal message and widens the bwrap dialect so a masked read surfaces as a policy refusal rather than an unexplained system error: by default the added signatures are the protected paths themselves, which keeps an unrelated permission error an ordinary one (`readDenialSignature` changes that trade). The read refusal omits the shared escalation hint on purpose: no tool advertises `sandbox_permissions` for a read, so the hint would only send the model into a schema error.

#### Token effect

Zero-direct beyond the announcement above: refusal text is paid for as a tool result, which depends on what the model attempted.

#### KV Cache effect

Independent: refusal text belongs to the conversation, not to the system prefix, and does not disturb prefix reuse.

## Known Limitations and Deferred Work

- **A read cannot be escalated** — `read`, `glob` and `grep` advertise no escalation fields, and the filesystem read methods are handed no policy at all. The level covers the two mutations and the confined shells, nothing else; opening a read-protected path means changing the rule.
- **The level name is model-facing vocabulary** — it must be one lowercase word and must not be `read-only`, `workspace-write` or `danger-full-access`; such a name is reported once and switches the level off.
- **Already-running persistent shells keep their original confinement** — the level applies to a call, so a terminal or a persistent pwsh session keeps the policy it started with until it is restarted.
- **The level is offered where it widens something** — it means the caller's mode with the protected names writable, so it is added to the targets of a `workspace-write` session only. A `read-only` session asks for `workspace-write`, which is what it actually needs; a narrower target than that would be a card promising less than it grants.
- **bwrap depth for protected names** — names are checked at any depth by the filesystem fence, but confinement binds them only up to `denyDepth`, and it does not descend into `denySkipDirs` (`node_modules`, `dist`, caches). A repository deeper than that or inside a skipped directory is unwritable for the file tools yet unprotected inside a command; the scan reports where it stopped, and `denyScanRoots` brings a named tree back under protection.
- **A protected name created moments ago is protected after the scan TTL** — `denyScanTtlMs` is how long a scan stays valid, so a repository initialized a second ago becomes read-only for commands within that window (0 re-walks for every command and pays a synchronous walk each time).
- **A rule that cannot apply is refused rather than approximated** — the filesystem root, a rule covering or lying inside the files of the harness itself, and a read rule covering the working directory are reported in `rejected` and shown on the Settings page.
- **Mask stubs are integrity-checked, not kernel-protected** — the stubs are the source of a bind, and a bind follows a symlinked source, so a replaced stub would mount whatever it points at over the protected path. Every command verifies the stub's type and mode and rebuilds it, which detects and repairs a replacement; mode 000 alone would not, since the owner of a stub can always take write access back. A plugin installed inside a working directory has its stubs writable from there, and the host log says so.
- **Landlock cannot express the denials** — subtracting a write from a broader rule and denying a subpath read are unavailable, so those rules are skipped there; the reason is logged, shown on the page and announced in the model context.
- **Processes outside the seams are uncovered** — the harness' own git integration and MCP servers do not go through `ctx.subprocess`, by design.
- **`git` over SSH stops working inside a confined command** while `~/.ssh` is read-protected; `ssh-agent` or an extracted `known_hosts` is required.
- **A write grant cannot sit inside a read-protected path** — the mask for the parent would hide the grant, and a grant bound first would hide the parent from the mask. The read rule wins: the grant is refused by name (`inside-read-denied` in `rejected`), because a missing grant is visible and fixable while a silently readable secret path is neither.
- **A read rule closes reading, not writing** — a path that is read-protected and also writable (a `.env` inside the workspace, for instance) can be overwritten without ever being read. Say so in the rule list or protect the file with the file tools' own boundary.
- **The refusal dialect is textual** — a masked read is recognized as a policy refusal when the command's error output names the protected path. A command that spells the same path differently (`../file`, a relative path) is still refused by the mask, but reaches the model as an ordinary failure; `readDenialSignature: any` matches the kernel's wording instead, at the cost of calling unrelated permission errors policy denials.
- **Protected directory names stay visible** in a parent listing — the mask replaces the mount point instead of filtering the parent.
- **Refused rules are visible, not silent** — the Settings form blocks unusable syntax (relative paths without `~/`, `~user`, a rule for the whole filesystem, duplicates) and lists what the host refused, with the reason, from the plugin's own `sandboxGuard` service. A rule aimed at a path that does not exist is kept and reported as `missing`.

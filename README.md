# @rkfg/dsh-better-sandbox

Extra sandbox rules for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): writable directories outside the workspace, path names that must stay unwritable, and paths hidden from reading. Rules are live — the Settings page edits them and the running session picks them up without a restart.

Two things the built-in sandbox cannot express, and this plugin adds:

- **Grants.** The built-in `workspace-write` mode allows one root plus temporary directories. Here you add the caches and toolchains an agent legitimately needs (`~/.cache`, `~/.ccache`, `/opt/go`, …) without falling back to `danger-full-access`.
- **Denials.** `.git` inside every writable root becomes unwritable, and secret paths (`~/.ssh`, `~/.npmrc`, mounted shares) become unreadable — the tools get an honest `EACCES`, sandboxed commands get the same error plus a policy marker, so the model sees a refusal instead of file contents.
- **A narrow escalation.** The built-in ladder offers only `workspace-write` and `danger-full-access`, so a refused `git commit` has to ask for the whole filesystem. The plugin adds one named level (`write-segment`): the approval card says that name, and the call runs with the protected path names writable and nothing else changed.

Everything is enforced at the harness seams, not by wrapping the agent: the filesystem provider, the process-sandbox provider and the subprocess provider are replaced by subclasses that add the extra rules.

## How it works

| Layer | Mechanism | Covers |
|---|---|---|
| Filesystem fence | subclass of the harness `fs-sandbox` provider; checks `stat`, `lstat`, `listDir`, `readText`, `streamText`, `readBytes`, `readByteRange`, `watch` and every write | tools `read`, `write`, `edit` and anything else going through `ctx.fs` |
| Process confinement | subclass of the harness `sandbox-local` provider; inserts extra `bwrap` binds after the workspace bind | every `bash`/`pwsh`/terminal command the harness confines |
| Read masks | bind of a mode-000 empty directory/file over a protected path → `EACCES` | reads inside sandboxed commands; the stubs are verified (type and mode) and rebuilt before every command, and an unload removes them only after the commands it already accepted are confined |
| Search fence | wrapper around the harness ripgrep spawn, applying the same `bwrap` arguments | `glob`/`grep`, which run ripgrep through `ctx.subprocess` and never through `ctx.fs` |
| Guard reporting | every reason a grant or a mask was not applied is kept and announced in the model context, written to the host log, and returned by `sandboxGuard.state()` | a rule that silently stopped working, which is the failure mode this plugin must not have |
| Model context | an announcement block listing the grants and the protected paths | the model knows what is allowed before it tries |
| Escalation level | the named target is added to the harness' strict-wider table and to the `sandbox_permissions` enum of `bash`, `pwsh`, `write`, `edit` | what the model may ask for, and what one approved call is given |

## The escalation level

A refusal under `workspace-write` is followed by one retry carrying `sandbox_permissions`.
The built-in ladder offers `workspace-write` (no wider) and `danger-full-access` (the whole
filesystem) — so committing costs the user a card that says *full access*, for a command
that only needs `.git`. The plugin adds a third target, named `write-segment` by default:

```
Allow this operation with write-segment permissions: commit the fix
git add -A && git commit -m "fix the fence"
                                   [ Reject ] [ Allow once ]
```

Approving grants, for that one call only, exactly what the name says: the names from
`denySegments` become writable. The call still runs under bwrap with the same workspace
boundary, the same extra roots, and the same read masks — the contour below checks that a
`git commit` succeeds under the level while `~/.ssh` and the paths outside the workspace
stay refused. Rename the level with `segmentLevel`, or set it to an empty string to drop
the target from the ladder entirely.

A read cannot be escalated: no tool advertises `sandbox_permissions` for `read`, `glob` or
`grep`, so opening a read-protected path means changing the rule.

Protected reads fail closed: the mask is a real mount point with mode `000`, and the plugin re-creates it before each command if something removed it. A command whose confinement is still being built holds the mask, so restarting or disabling the row during a running command keeps that command masked and removes the stubs once it is confined; a command that arrives after the row started closing gets the documented fallback (a tmpfs over a directory, a reported hole for a file) and never leaves a new pair of stubs behind.

## Requirements

- Linux with unprivileged user namespaces and [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap --version`).
- DeepSeek Harness `0.2.1-rc.2`. The dependency versions in both packages are pinned to it on purpose: the `latest` dist-tag of the `@deepseek-ai/*` family points at an old `0.0.1-rc.1`, and the plugin depends on internal provider behaviour that changed between releases.

## Install

Both packages are published under the `@rkfg` scope: this is a personal extension of the harness, not a package of the `@deepseek-ai/*` family, and the scope keeps that difference visible.

From npm (installs both packages into the profile):

```bash
dsh plugin --profile web add @rkfg/dsh-better-sandbox @rkfg/dsh-better-sandbox-ui
```

From GitHub. This is a workspace of two packages, so the git URL must point at one of them — installing the repository root would install the private workspace package and no plugin:

```bash
dsh plugin --profile web add "git+https://github.com/rkfg/dsh-better-sandbox.git#path:/packages/@rkfg/dsh-better-sandbox"
dsh plugin --profile web add "git+https://github.com/rkfg/dsh-better-sandbox.git#path:/packages/@rkfg/dsh-better-sandbox-ui"
```

From a working tree, with the mask stubs and a profile `package.json` backup handled for you:

```bash
./scripts/install.sh --profile web
```

Two things to expect when installing from npm inside a running session. pnpm keeps a content-addressed store in `~/.local/share/pnpm`, which is outside the workspace and therefore read-only to a confined command — add it to `writableDirs` or run the install in a plain terminal. And the harness cannot read `~/.npmrc` while this plugin protects it, so a private registry needs the install to happen outside the sandbox; public packages are unaffected.

Then put the rule values in `~/.dsh/profiles/web/cordis.patch.yml`. The bundle layer of the package already declares the entries and disables the built-in providers it replaces, so the profile only carries values:

```yaml
- id: better-sandbox
  name: '@rkfg/dsh-better-sandbox/rules'
  config:
    writableDirs:
      - /opt/go
      - /home/you/.cache
    denySegments:
      - .git
    readDenyDirs:
      - /home/you/.ssh
      - /home/you/.aws
    readDenyFiles:
      - /home/you/.npmrc
      - /home/you/.netrc
    segmentLevel: write-segment
```

Restart the profile. Adding entries and changing module code always needs a restart; editing the four lists does not.

## Settings page

With `@rkfg/dsh-better-sandbox-ui` installed, the Settings dialog gains a **Sandbox** section: four text areas (one path per line) for writable roots, read-protected directories, read-protected files and protected path names, plus a one-line field naming the escalation level (empty turns the level off). Saving writes the profile patch through the harness settings layer, and the running session switches to the new rules immediately — remove a directory and it becomes readable in the next tool call, add it back and the next call is refused. Renaming the level rewrites the enum of the mounted tools without a restart. The section is translated into English and Chinese, the two languages the harness UI supports.

## Configuration

| Field | Meaning | Live edit |
|---|---|---|
| `writableDirs` | directories outside the workspace that may be written | yes (Settings) |
| `denySegments` | path names that must stay unwritable inside every writable root | yes (Settings) |
| `readDenyDirs`, `readDenyFiles` | hidden from reading via a mode-000 mask | yes (Settings) |
| `segmentLevel` | name of the escalation level that opens the protected names for one approved call; empty turns it off | yes (Settings) |
| `denyDepth`, `denyScanTtlMs`, `denySkipDirs`, `denyScanRoots` | how the confinement scans for protected names: how deep, for how long a scan stays valid (0 re-walks on every command), which directories the walk does not enter, and which extra trees to scan | `denyScanRoots` yes, the rest no |
| `maskFallback`, `readDenialSignature` | behaviour when the mask cannot be created, and how a masked read is recognized in the output of a command (`paths`, `any`, `off`) | no (restart) |
| `announceInPrompt` | add the rules to the model context | no (restart) |

Paths accept `~` and `~/…`; `~user` does not expand. A rule that crosses a boundary is refused rather than approximated, and the reason is written to the host log and returned by `sandboxGuard.state()`: `root` (a rule for the whole filesystem), `covers-harness` or `inside-harness` (a rule over, or inside, the files of the harness itself — the mask stubs live in the plugin folder), `covers-workspace` (a read rule that would hide the working directory), `relative`, `segment`, `missing`.

## Verifying

```bash
./scripts/check.sh     # the same driver against built-in providers, then against the plugin
./scripts/webfull.sh   # isolated full web profile: bundle form, Settings page, live rule edit
```

`check.sh` builds throwaway profiles under `.dsh-test/`, points `DSH_HOME` there and runs a deterministic driver: writes into an allowed directory must report `WROTE`, writes into a denied directory and into `.git` must report `DENIED FS_SANDBOX_DENIED` or `Read-only file system`, reads of the fixture secrets must be refused, and deleting the mask stubs mid-run must be repaired. A third profile runs the lifecycle probe, which unloads the rule owner while a confinement is being built: the command must stay masked, the stubs must be gone once the unload settles, and a late reader must rebuild nothing. Before that it checks syntax, the manifests against the patch layers, the YAML of both patch layers and the language rule above. `webfull.sh` boots the real web stack on its own port and reports activation problems; the expected count is zero.

## Boundaries

Read them before trusting the setup — the plugin narrows what an agent can reach, it is not a container.

- A command running with `danger-full-access` is unsandboxed, so no rule holds inside it — including the read masks, which exist only in a confined mount namespace. The read rules keep the `read`, `glob` and `grep` tools closed there, and nothing else.
- The harness' own git integration and MCP servers run outside these seams and are not covered by design.
- bwrap applies protected names up to `denyDepth` levels and does not descend into `denySkipDirs`; the filesystem fence checks them at any depth. A repository deeper than that is unwritable for the file tools yet unprotected inside a command — the scan reports where it stopped, and `denyScanRoots` names the trees that must be scanned anyway.
- A protected name created moments ago becomes protected for commands after `denyScanTtlMs`; `0` re-walks the roots for every command instead of paying that window.
- The mask stubs are verified (type and mode) and rebuilt before every command, because a bind follows a symlinked source and a replaced stub would show whatever it points at. Mode 000 alone is no defence: the owner of a stub can always take write access back. That is why the plugin folder must not be inside a working directory — the host log says when it is.
- A command admitted after the rule owner started closing is confined with the fallback rather than with a stub: a tmpfs over a read-protected directory still denies reading, while a read-protected file is reported as a hole. The stronger mask covers the commands accepted while the owner was mounted.
- A read rule closes reading, not writing: a read-protected path that is also writable can be overwritten without being read.
- Landlock cannot subtract a write from a broader rule or deny a subpath read, so `denySegments` and `readDeny*` are skipped there — the reason is logged, shown on the Settings page and announced in the model context rather than hidden.
- Names of protected directories stay visible in a parent listing: the mask replaces the mount point, it does not filter the parent.
- `git` over SSH inside a sandboxed command stops working while `~/.ssh` is read-protected; use `ssh-agent` or an extracted `known_hosts`.
- Deleting a protected directory from outside (an escalated command) is not prevented.
- A read cannot be escalated: `read`, `glob` and `grep` advertise no escalation fields, so a read-protected path opens only by changing the rule.
- A persistent terminal or pwsh session keeps the confinement it was started with — the level covers one call, so an already open shell is not re-confined.
- The level extends a vocabulary the harness owns: the target is written into the tool schemas when they mount and repaired on `tools/change`. If the level stops appearing on the card after a harness upgrade, that seam is the first place to look; the dependency pins hold the harness version for exactly this reason.
- The Settings page blocks unusable syntax (relative path without `~/`, `~user`, a rule for the whole filesystem, duplicate) in red and refuses to save. It cannot show what the host refused: a client namespace exists only when the build pipeline generates the `./typert` and `./remote` artifacts, and this package has none, so refusals, the guard report and the scan truncations live in the host log and in `sandboxGuard.state()`.

## Related work

[dsh-better-sandbox](https://www.npmjs.com/package/dsh-better-sandbox) by `developerdh` (MIT) addresses an overlapping problem with a different trade-off, and it came first. Its scope is wider in three places: command rules (`allow` / `ask` / `deny` by pattern, with per-segment handling of compound commands), wildcard directory patterns, and a Windows ACL backend. This package is narrower and deeper: read denials are enforced **inside** confined processes (mode-000 bwrap masks plus the ripgrep fence), protected path names are enforced at any depth in the filesystem layer, and the Linux/bwrap path is what runs on a real machine every day rather than an untested backend. Their README documents that read rules constrain file tools and not shell commands; here the same rules reach the shell. Pick by which half you need — command policy and Windows, or enforced denials under bwrap.

## Repository

```
packages/@rkfg/dsh-better-sandbox/       host bundle: services, providers, Remote service
packages/@rkfg/dsh-better-sandbox-ui/    Settings page (separate package: a client package must own exactly one Loader entry)
scripts/install.sh                    install into a profile, recreate mask stubs
scripts/check.sh                      headless contour with generated fixtures
scripts/webfull.sh                    web contour, probes, `serve` for browser debugging
scripts/page-check.sh                 boots the web profile and loads it in a headless browser
scripts/lint.sh                       node --check over every module
.github/workflows/ci.yml              syntax, contour, YAML, language and page checks on every push
.github/workflows/publish.yml         a version tag publishes both packages through npm trusted publishing
test/                                 driver and probes used by the contours
```

A release is a tag push: set the same `version` in both packages, tag the commit `v<version>`, and `publish.yml` runs the contour, refuses a tag that disagrees with the manifests, and publishes both packages with provenance. It authenticates through OIDC, so no npm token is involved; the trusted publisher (user `rkfg`, this repository, workflow file `publish.yml`) is configured once on each package's settings page, and a freshly created trusted publisher must complete its first publish within two days or it expires.

Code, comments and script output are English; `check.sh` fails when Cyrillic shows up anywhere outside `locale/*.json` and the Russian README copies. The page locales are `en` and `zh`, which is what the pinned harness release supports.

### Renaming a package

A rename touches more than the manifest, and a half-renamed package breaks the web page while the host runs perfectly:

- the `id` passed to `window.__ModuleLoader__.load` inside `client.js` must equal the package name, or the browser loader reports `duplicate factory registration` and the page shows `Failed to load plugins`;
- every `name:` in `cordis.patch.yml` must be quoted when the name is scoped — YAML rejects a plain scalar starting with `@`;
- profiles keep the old name in `dsh.profile.bundles` and the old directory in `node_modules`; two packages with one name fail composition. `scripts/install.sh --drop <old-name>` removes both in a single write.

`scripts/check.sh` asserts the first two statically; `scripts/page-check.sh` asserts the result by loading the page and reading its console. Run both before installing into a real profile.

## License

MIT — see [LICENSE](LICENSE).

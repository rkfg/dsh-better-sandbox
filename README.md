# @rkfg/dsh-sandbox-allowlist

Extra sandbox rules for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): writable directories outside the workspace, path names that must stay unwritable, and paths hidden from reading. Rules are live — the Settings page edits them and the running session picks them up without a restart.

Two things the built-in sandbox cannot express, and this plugin adds:

- **Grants.** The built-in `workspace-write` mode allows one root plus temporary directories. Here you add the caches and toolchains an agent legitimately needs (`~/.cache`, `~/.ccache`, `/opt/go`, …) without falling back to `danger-full-access`.
- **Denials.** `.git` inside every writable root becomes unwritable, and secret paths (`~/.ssh`, `~/.npmrc`, mounted shares) become unreadable — the tools get an honest `EACCES`, sandboxed commands get the same error plus a policy marker, so the model sees a refusal instead of file contents.

Everything is enforced at the harness seams, not by wrapping the agent: the filesystem provider, the process-sandbox provider and the subprocess provider are replaced by subclasses that add the extra rules.

## How it works

| Layer | Mechanism | Covers |
|---|---|---|
| Filesystem fence | subclass of the harness `fs-sandbox` provider; checks `stat`, `listDir`, `readText`, `streamText`, `readBytes`, `readByteRange` and every write | tools `read`, `write`, `edit`, `glob`, `grep` and anything else going through `ctx.fs` |
| Process confinement | subclass of the harness `sandbox-local` provider; inserts extra `bwrap` binds after the workspace bind | every `bash`/`pwsh`/terminal command the harness confines |
| Read masks | bind of a mode-000 empty directory/file over a protected path → `EACCES` | reads inside sandboxed commands; the mask is recreated automatically if deleted |
| Search fence | wrapper around the harness ripgrep spawn, applying the same `bwrap` arguments | `glob`/`grep` tools that shell out to ripgrep |
| Model context | an announcement block listing the grants and the protected paths | the model knows what is allowed before it tries |

Protected reads fail closed: the mask is a real mount point with mode `000`, and the plugin re-creates it before each command if something removed it.

## Requirements

- Linux with unprivileged user namespaces and [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap --version`).
- DeepSeek Harness `0.2.1-rc.2`. The dependency versions in both packages are pinned to it on purpose: the `latest` dist-tag of the `@deepseek-ai/*` family points at an old `0.0.1-rc.1`, and the plugin depends on internal provider behaviour that changed between releases.

## Install

The unscoped name `dsh-sandbox-allowlist` on npm belongs to a different project (see [Related work](#related-work)), so these packages are published under the `@rkfg` scope.

From npm (installs both packages into the profile):

```bash
dsh plugin --profile web add @rkfg/dsh-sandbox-allowlist @rkfg/dsh-sandbox-allowlist-ui
```

From GitHub. This is a workspace of two packages, so the git URL must point at one of them — installing the repository root would install the private workspace package and no plugin:

```bash
dsh plugin --profile web add "git+https://github.com/rkfg/dsh-sandbox-allowlist.git#path:/packages/@rkfg/dsh-sandbox-allowlist"
dsh plugin --profile web add "git+https://github.com/rkfg/dsh-sandbox-allowlist.git#path:/packages/@rkfg/dsh-sandbox-allowlist-ui"
```

From a working tree, with the mask stubs and a profile `package.json` backup handled for you:

```bash
./scripts/install.sh --profile web
```

Then put the rule values in `~/.dsh/profiles/web/cordis.patch.yml`. The bundle layer of the package already declares the entries and disables the built-in providers it replaces, so the profile only carries values:

```yaml
- id: sandbox-allowlist
  name: '@rkfg/dsh-sandbox-allowlist/allowlist'
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
```

Restart the profile. Adding entries and changing module code always needs a restart; editing the four lists does not.

## Settings page

With `@rkfg/dsh-sandbox-allowlist-ui` installed, the Settings dialog gains a **Sandbox** section: four text areas (one path per line) for writable roots, read-protected directories, read-protected files and protected path names. Saving writes the profile patch through the harness settings layer, and the running session switches to the new rules immediately — remove a directory and it becomes readable in the next tool call, add it back and the next call is refused. The section is translated into English and Chinese, the two languages the harness UI supports.

## Configuration

| Field | Meaning | Live edit |
|---|---|---|
Paths accept `~` and `~/…`; `~user` does not expand. Rules that cannot apply are reported by the plugin (`relative`, `covers-harness`), and rules aimed at a path that does not exist are marked `missing`.

| `writableDirs` | directories outside the workspace that may be written | yes (Settings) |
| `denySegments` | path names that must stay unwritable inside every writable root | yes (Settings) |
| `readDenyDirs`, `readDenyFiles` | hidden from reading via a mode-000 mask | yes (Settings) |
| `denyDepth`, `denyScanTtlMs`, `denySkipDirs` | how the confinement scans for protected names | no (restart) |
| `maskFallback`, `readDenialSignature` | behaviour when the mask cannot be created, and the denial dialect added for masked reads | no (restart) |
| `announceInPrompt` | add the rules to the model context | no (restart) |

## Verifying

```bash
./scripts/check.sh     # the same driver against built-in providers, then against the plugin
./scripts/webfull.sh   # isolated full web profile: bundle form, Settings page, live rule edit
```

`check.sh` builds throwaway profiles under `.dsh-test/`, points `DSH_HOME` there and runs a deterministic driver: writes into an allowed directory must report `WROTE`, writes into a denied directory and into `.git` must report `DENIED FS_SANDBOX_DENIED` or `Read-only file system`, reads of the fixture secrets must be refused, and deleting the mask stubs mid-run must be repaired. Before that it checks syntax, the manifests against the patch layers, the YAML of both patch layers and the language rule above. `webfull.sh` boots the real web stack on its own port and reports activation problems; the expected count is zero.

## Boundaries

Read them before trusting the setup — the plugin narrows what an agent can reach, it is not a container.

- A command running with `danger-full-access` is unsandboxed, so the rules do not apply to it.
- The harness' own git integration and MCP servers run outside these seams and are not covered by design.
- bwrap applies protected names up to `denyDepth` levels; the filesystem fence checks them at any depth.
- Landlock cannot subtract a write from a broader rule or deny a subpath read, so `denySegments` and `readDeny*` are skipped there — the plugin logs a warning instead of pretending.
- Names of protected directories stay visible in a parent listing: the mask replaces the mount point, it does not filter the parent.
- `git` over SSH inside a sandboxed command stops working while `~/.ssh` is read-protected; use `ssh-agent` or an extracted `known_hosts`.
- Deleting a protected directory from outside (an escalated command) is not prevented.
- The Settings page blocks unusable syntax (relative path without `~/`, `~user`, duplicate) in red and refuses to save; it cannot check existence, because the page has no channel to the plugin service, so a rule for a missing directory is accepted and inert until that directory appears.

## Related work

[dsh-sandbox-allowlist](https://www.npmjs.com/package/dsh-sandbox-allowlist) by `developerdh` (MIT) addresses an overlapping problem with a different trade-off, and it came first. Its scope is wider in three places: command rules (`allow` / `ask` / `deny` by pattern, with per-segment handling of compound commands), wildcard directory patterns, and a Windows ACL backend. This package is narrower and deeper: read denials are enforced **inside** confined processes (mode-000 bwrap masks plus the ripgrep fence), protected path names are enforced at any depth in the filesystem layer, and the Linux/bwrap path is what runs on a real machine every day rather than an untested backend. Their README documents that read rules constrain file tools and not shell commands; here the same rules reach the shell. Pick by which half you need — command policy and Windows, or enforced denials under bwrap.

## Repository

```
packages/@rkfg/dsh-sandbox-allowlist/       host bundle: services, providers, Remote service
packages/@rkfg/dsh-sandbox-allowlist-ui/    Settings page (separate package: a client package must own exactly one Loader entry)
scripts/install.sh                    install into a profile, recreate mask stubs
scripts/check.sh                      headless contour with generated fixtures
scripts/webfull.sh                    web contour, probes, `serve` for browser debugging
scripts/page-check.sh                 boots the web profile and loads it in a headless browser
scripts/lint.sh                       node --check over every module
test/                                 driver and probes used by the contours
```

Code, comments and script output are English; `check.sh` fails when Cyrillic shows up anywhere outside `locale/*.json` and the Russian README copies. The page locales are `en` and `zh`, which is what the pinned harness release supports.

### Renaming a package

A rename touches more than the manifest, and a half-renamed package breaks the web page while the host runs perfectly:

- the `id` passed to `window.__ModuleLoader__.load` inside `client.js` must equal the package name, or the browser loader reports `duplicate factory registration` and the page shows `Failed to load plugins`;
- every `name:` in `cordis.patch.yml` must be quoted when the name is scoped — YAML rejects a plain scalar starting with `@`;
- profiles keep the old name in `dsh.profile.bundles` and the old directory in `node_modules`; two packages with one name fail composition. `scripts/install.sh --drop <old-name>` removes both in a single write.

`scripts/check.sh` asserts the first two statically; `scripts/page-check.sh` asserts the result by loading the page and reading its console. Run both before installing into a real profile.

## License

MIT — see [LICENSE](LICENSE).

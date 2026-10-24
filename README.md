# dsh-sandbox-allowlist

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

From npm (installs both packages into the profile):

```bash
dsh plugin --profile web add dsh-sandbox-allowlist dsh-sandbox-allowlist-ui
```

From this repository:

```bash
dsh plugin --profile web add git+https://github.com/rkfg/dsh-sandbox-allowlist.git
# or, from a working tree, with the mask stubs and a package.json backup handled for you:
./scripts/install.sh --profile web
```

Then put the rule values in `~/.dsh/profiles/web/cordis.patch.yml`. The bundle layer of the package already declares the entries and disables the built-in providers it replaces, so the profile only carries values:

```yaml
- id: sandbox-allowlist
  name: dsh-sandbox-allowlist/allowlist
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

With `dsh-sandbox-allowlist-ui` installed, the Settings dialog gains a **Sandbox** section: four text areas (one path per line) for writable roots, read-protected directories, read-protected files and protected path names. Saving writes the profile patch through the harness settings layer, and the running session switches to the new rules immediately — remove a directory and it becomes readable in the next tool call, add it back and the next call is refused. The section is translated into English and Chinese, the two languages the harness UI supports.

## Configuration

| Field | Meaning | Live edit |
|---|---|---|
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

`check.sh` builds throwaway profiles under `.dsh-test/`, points `DSH_HOME` there and runs a deterministic driver: writes into an allowed directory must report `WROTE`, writes into a denied directory and into `.git` must report `DENIED FS_SANDBOX_DENIED` or `Read-only file system`, reads of the fixture secrets must be refused, and deleting the mask stubs mid-run must be repaired. `webfull.sh` boots the real web stack on its own port and reports activation problems; the expected count is zero.

## Boundaries

Read them before trusting the setup — the plugin narrows what an agent can reach, it is not a container.

- A command running with `danger-full-access` is unsandboxed, so the rules do not apply to it.
- The harness' own git integration and MCP servers run outside these seams and are not covered by design.
- bwrap applies protected names up to `denyDepth` levels; the filesystem fence checks them at any depth.
- Landlock cannot subtract a write from a broader rule or deny a subpath read, so `denySegments` and `readDeny*` are skipped there — the plugin logs a warning instead of pretending.
- Names of protected directories stay visible in a parent listing: the mask replaces the mount point, it does not filter the parent.
- `git` over SSH inside a sandboxed command stops working while `~/.ssh` is read-protected; use `ssh-agent` or an extracted `known_hosts`.
- Deleting a protected directory from outside (an escalated command) is not prevented.

## Repository

```
packages/dsh-sandbox-allowlist/       host bundle: services, providers, Remote service
packages/dsh-sandbox-allowlist-ui/    Settings page (separate package: a client package must own exactly one Loader entry)
scripts/install.sh                    install into a profile, recreate mask stubs
scripts/check.sh                      headless contour with generated fixtures
scripts/webfull.sh                    web contour, probes, `serve` for browser debugging
scripts/lint.sh                       node --check over every module
test/                                 driver and probes used by the contours
```

Code comments are in Russian; documentation is English with Russian copies (`README.ru.md`).

## License

MIT — see [LICENSE](LICENSE).

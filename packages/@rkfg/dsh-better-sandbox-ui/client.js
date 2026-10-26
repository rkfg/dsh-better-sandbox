/*
 * @rkfg/dsh-better-sandbox-ui / the sandbox settings section (client half).
 *
 * Reads and writes the rules through the harness's regular settings layer
 * (ctx.remote.settings): the list of rules becomes a volatile string field of the
 * better-sandbox entry, so an edit applies without remounting the entries.
 *
 * Format — a hand-written __ModuleLoader__ bundle, no JSX is used.
 */
window.__ModuleLoader__.load({
	id: "@rkfg/dsh-better-sandbox-ui",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		const react = require("react")
		const h = react.createElement
		const useState = react.useState
		const useEffect = react.useEffect
		const useCallback = react.useCallback

		const NS = "better-sandbox"
		const FIELDS = [
			{ key: "writableDirs", hintKey: "hintWritableDirs", kind: "path" },
			{ key: "readDenyDirs", hintKey: "hintReadDenyDirs", kind: "path" },
			{ key: "readDenyFiles", hintKey: "hintReadDenyFiles", kind: "path" },
			{ key: "denySegments", hintKey: "hintDenySegments", kind: "segment" },
			// One word, not a list: the name of the escalation level that opens the path
			// names above for a single approved call. Empty turns the level off.
			{ key: "segmentLevel", hintKey: "hintSegmentLevel", kind: "token" },
		]

		/** The mode names of the harness ladder: a level may not borrow one of them. */
		const RESERVED_LEVELS = ["read-only", "workspace-write", "danger-full-access"]

		const style = {
			wrap: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 },
			field: { display: "flex", flexDirection: "column", gap: 4 },
			label: { fontSize: 14, fontWeight: 500 },
			hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
			area: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: 13, minHeight: 78, padding: "8px 10px", borderRadius: 8, border: ".5px solid var(--dsw-alias-border-l4, #999)", background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", width: "100%", boxSizing: "border-box" },
			input: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: 13, padding: "8px 10px", borderRadius: 8, border: ".5px solid var(--dsw-alias-border-l4, #999)", background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", width: "100%", boxSizing: "border-box" },
			row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
			button: { padding: "6px 12px", fontSize: 13, borderRadius: 8, cursor: "pointer" },
			note: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
			error: { color: "var(--dsw-alias-state-error-primary, #c9541f)", fontSize: 13 },
		}

		const lines = (value) => (Array.isArray(value) ? value : []).map((item) => String(item)).join("\n")
		const toLines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")
		/** The stored value as the text of its control: one word for a token, one rule per line otherwise. */
		const textOf = function (value, kind) {
			return kind === "token" ? String(value ?? "") : lines(value)
		}

		/**
		 * The escalation level is a single word that reaches the model-facing schema, so it
		 * is checked as a token: lowercase, no spaces, and not one of the harness' own mode
		 * names. An empty field is legitimate and means the level is switched off.
		 *
		 * @param text - the contents of the field.
		 * @returns the list of problems: { entry, reason }.
		 */
		const checkToken = function (text) {
			const value = String(text).trim()
			if (value === "") return []
			if (RESERVED_LEVELS.includes(value)) return [{ entry: value, reason: "reservedLevel" }]
			if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) return [{ entry: value, reason: "token" }]
			return []
		}

		const checkField = function (text, kind) {
			return kind === "token" ? checkToken(text) : checkLines(text, kind)
		}

		/**
		 * Rule-line validation runs in the browser. The two kinds of field have their
		 * own rules: a path must be absolute or in ~/… form (the `~user` form is not
		 * supported), and a path name must be one component with no separators and no
		 * `~`. Duplicates are caught for both kinds. The browser cannot check that a
		 * path exists (there is no route from the page to a plugin service), so that is
		 * the host's job: there the rule lands in `rejected` with reason `missing`.
		 *
		 * @param text - the contents of the field, one rule per line.
		 * @param kind - `path` for paths and `segment` for path-component names.
		 * @returns the list of problems: { entry, reason }.
		 */
		const checkLines = function (text, kind) {
			const problems = []
			const seen = new Set()
			for (const raw of String(text).split("\n")) {
				const line = raw.trim()
				if (line === "") continue
				if (kind === "segment") {
					if (line.includes("/") || line === "." || line === ".." || line.startsWith("~")) problems.push({ entry: line, reason: "segment" })
				} else if (line !== "~" && !line.startsWith("~/")) {
					if (line.startsWith("~")) problems.push({ entry: line, reason: "tildeUser" })
					else if (!line.startsWith("/")) problems.push({ entry: line, reason: "relative" })
					// One rule for the whole filesystem would cover every path the session
					// works in, so the host refuses it; the form says so before saving.
					else if (line === "/") problems.push({ entry: line, reason: "rootPath" })
				} else if (/(^|\/)\.\.(\/|$)/.test(line)) {
					// `~/…` is expanded against a home directory the page cannot resolve, and a
					// `..` segment can walk the result back out of it — as far as the filesystem
					// root. The host refuses whatever such a spelling resolves to; the form
					// refuses the spelling itself.
					problems.push({ entry: line, reason: "parentSegment" })
				}
				if (seen.has(line)) problems.push({ entry: line, reason: "duplicate" })
				else seen.add(line)
			}
			return problems
		}

		function SandboxSection(props) {
			const t = props.t
			const api = props.api
			const [state, setState] = useState(null)
			const [drafts, setDrafts] = useState(null)
			const [status, setStatus] = useState(t("loading"))
			const [error, setError] = useState("")
			const [busy, setBusy] = useState(false)
			const [issues, setIssues] = useState({})

			// keepDrafts=true refreshes only the profile snapshot (and the revision) and
			// leaves what is already typed in the fields alone: that is how a conflict clears.
			const reload = useCallback(function (keepDrafts) {
				setBusy(true)
				return api.read()
					.then(function (descriptor) {
						if (descriptor === null) {
							setError(t("missing"))
							setStatus("")
							setState(null)
							setDrafts(null)
							return
						}
						setState(descriptor)
						if (keepDrafts === true) {
							setStatus(t("revision") + " " + descriptor.revision)
							return
						}
						const values = {}
						const value = descriptor.value ?? {}
						for (const field of FIELDS) values[field.key] = textOf(value[field.key], field.kind)
						setDrafts(values)
						const found = {}
						for (const field of FIELDS) found[field.key] = checkField(values[field.key], field.kind)
						setIssues(found)
						setError("")
						setStatus(t("revision") + " " + descriptor.revision)
					})
					.catch(function (failure) {
						setError(String((failure && failure.message) || failure))
					})
					.then(function () {
						setBusy(false)
					})
			}, [api, t])

			useEffect(function () {
				reload()
			}, [reload])

			// A change made elsewhere while the section is open: take the new revision, keep what
			// the user typed, and say that the stored rules moved under the form.
			useEffect(function () {
				if (typeof api.subscribe !== "function") return
				return api.subscribe(function () {
					Promise.resolve(reload(true)).then(function () {
						setStatus(t("remoteChanged"))
					})
				})
			}, [api, reload, t])

			const save = function () {
				if (state === null || drafts === null) return
				const found = {}
				let broken = 0
				for (const field of FIELDS) {
					found[field.key] = checkField(drafts[field.key], field.kind)
					broken += found[field.key].length
				}
				setIssues(found)
				if (broken > 0) {
					setError(t("blocked"))
					return
				}
				const patch = {}
				for (const field of FIELDS) {
					const next = field.kind === "token" ? String(drafts[field.key]).trim() : toLines(drafts[field.key])
					const current = (state.value ?? {})[field.key]
					const changed = field.kind === "token" ? next !== String(current ?? "") : lines(next) !== lines(current)
					if (changed) patch[field.key] = next
				}
				if (Object.keys(patch).length === 0) {
					setStatus(t("unchanged"))
					return
				}
				setBusy(true)
				api.write(patch, state.revision)
					.then(function (result) {
						if (result.ok === false) {
							const failure = new Error(result.message || t("failed"))
							failure.code = result.code
							throw failure
						}
						return reload()
					})
					.catch(function (failure) {
						// A conflict means the profile was edited somewhere else after this form
						// loaded its values: the revision has to be refreshed and what the user
						// typed kept, or the edit is lost along with the rejection. The settings
						// service throws SETTINGS_CONFLICT, and the remote controller maps it to the
						// wire code settings/conflict — the page is handed the second spelling.
						if (failure.code === "SETTINGS_CONFLICT" || failure.code === "settings/conflict") {
							setError(t("conflict"))
							return reload(true)
						}
						setError(String((failure && failure.message) || failure))
					})
					.then(function () {
						setBusy(false)
					})
			}

			if (state === null && drafts === null) {
				return h("div", { style: error === "" ? style.note : style.error }, error === "" ? t("loading") : error)
			}

			return h(
				"div",
				{ style: style.wrap },
				h("p", { style: style.note }, t("intro")),
				error === "" ? null : h("div", { style: style.error }, error),
				FIELDS.map(function (field) {
					const value = drafts === null ? "" : drafts[field.key]
					const broken = issues[field.key] && issues[field.key].length > 0
					const marked = function (base) {
						return broken ? Object.assign({}, base, { borderColor: "var(--dsw-alias-state-error-primary, #c9541f)" }) : base
					}
					const onChange = function (event) {
						const next = event.target.value
						setDrafts(function (prev) {
							return Object.assign({}, prev, (function () { var patch = {}; patch[field.key] = next; return patch })())
						})
						setIssues(function (prev) {
							return Object.assign({}, prev, (function () { var patch = {}; patch[field.key] = checkField(next, field.kind); return patch })())
						})
					}
					return h(
						"label",
						{ key: field.key, style: style.field },
						h("span", { style: style.label }, t(field.key)),
						h("span", { style: style.hint }, t(field.hintKey)),
						// A token is one word, so it gets a one-line box; a rule list keeps the area.
						field.kind === "token"
							? h("input", {
									style: marked(style.input),
									type: "text",
									value: value,
									disabled: busy,
									spellCheck: false,
									onChange: onChange,
								})
							: h("textarea", {
									style: marked(style.area),
									value: value,
									disabled: busy,
									spellCheck: false,
									onChange: onChange,
								}),
						broken
							? h(
									"div",
									{ style: style.error },
									issues[field.key].map(function (problem) {
										return h("div", { key: problem.reason + problem.entry }, t("bad" + problem.reason.charAt(0).toUpperCase() + problem.reason.slice(1)) + ": " + problem.entry)
									})
								)
							: null
					)
				}),
				h(
					"div",
					{ style: style.row },
					h("button", { style: style.button, type: "button", disabled: busy, onClick: save }, t("save")),
					h("button", { style: style.button, type: "button", disabled: busy, onClick: reload }, t("reload")),
					h("span", { style: style.note }, status)
				)
			)
		}

		// `remote.sandboxGuard` is deliberately absent: a client namespace exists only when
		// the build pipeline generates the `./typert` and `./remote` artifacts, and declaring
		// one the bridge cannot resolve leaves the whole entry pending.
		const inject = ["slots", "locale", "connection", "remote", "remote.settings"]

		function apply(ctx) {
			const locale = ctx.locale.register("settings.sandbox", {
				en: {
					nav: "Sandbox",
					intro: "Write grants outside the workspace, read-protected paths, and the escalation level that opens the protected path names for one approved call. Changes apply without a restart.",
					loading: "loading rules…",
					missing: "better-sandbox entry not found — the sandbox plugin is not mounted.",
					revision: "revision",
					unchanged: "no changes",
					failed: "write failed",
					save: "Save",
					reload: "Reload",
					writableDirs: "Writable roots beyond the workspace",
					readDenyDirs: "Read-protected directories",
					readDenyFiles: "Read-protected files",
					denySegments: "Path names refused for writing",
					segmentLevel: "Escalation level that opens those names",
					hintWritableDirs: "one directory per line",
					hintReadDenyDirs: "keys, tokens, personal data",
					hintReadDenyFiles: "one file per line",
					hintDenySegments: "for example .git",
					hintSegmentLevel: "one word, for example write-segment; empty turns the level off",
					blocked: "some lines are unusable — fix the marked entries before saving",
					badRelative: "needs an absolute path or ~/…",
					badTildeUser: "~user form is not supported, use ~/…",
					badDuplicate: "repeated rule",
					badSegment: "expected one path name, for example .git",
					badToken: "expected one lowercase word, for example write-segment",
					badReservedLevel: "that name is a mode of the built-in ladder, the level needs another one",
					badRootPath: "a rule for the whole filesystem is refused, name the directory instead",
					badParentSegment: "a .. segment can walk ~/… out of the home directory, write the path without it",
					remoteChanged: "the stored rules changed elsewhere — the revision is refreshed, your text is kept",
					conflict: "the profile changed after this form was loaded — the fresh revision is in place, check the values and save again",
				},
				zh: {
					nav: "沙盒",
					intro: "工作区之外的写入授权、禁止读取的路径，以及为单次已批准的调用开放受保护路径名称的提权级别。修改即时生效，无需重启。",
					loading: "正在加载规则…",
					missing: "未找到 better-sandbox 配置项 — 沙盒插件未挂载。",
					revision: "修订版本",
					unchanged: "没有变化",
					failed: "保存失败",
					save: "保存",
					reload: "重新加载",
					writableDirs: "工作区之外的可写目录",
					readDenyDirs: "禁止读取的目录",
					readDenyFiles: "禁止读取的文件",
					denySegments: "禁止写入的路径名称",
					segmentLevel: "开放这些名称的提权级别",
					hintWritableDirs: "每行一个目录",
					hintReadDenyDirs: "密钥、令牌、个人数据",
					hintReadDenyFiles: "每行一个文件",
					hintDenySegments: "例如 .git",
					hintSegmentLevel: "一个单词，例如 write-segment；留空表示关闭该级别",
					blocked: "部分条目无法使用 — 请先修正标记的行",
					badRelative: "需要绝对路径或 ~/…",
					badTildeUser: "不支持 ~user 形式，请使用 ~/…",
					badDuplicate: "规则重复",
					badSegment: "期望单个路径名，例如 .git",
					badToken: "期望一个小写单词，例如 write-segment",
					badReservedLevel: "该名称属于内置模式，提权级别需要另一个名称",
					badRootPath: "不允许整条文件系统规则，请写明具体目录",
					badParentSegment: ".. 段会把 ~/… 带出主目录，请写成完整路径",
					remoteChanged: "已保存的规则在别处被修改 — 修订版本已刷新，你的输入已保留",
					conflict: "本表单载入后配置已被修改 — 已取到最新修订版本，请检查内容后再次保存",
				},
			})
			const t = ctx.locale.bind("settings.sandbox")

			const unwrap = function (response) {
				if (response && response.ok === false) {
					const failure = new Error(response.error && response.error.message ? response.error.message : "settings call failed")
					failure.code = response.error && response.error.code ? response.error.code : ""
					throw failure
				}
				return response && "value" in response ? response.value : response
			}

			const api = {
				read: function () {
					return Promise.resolve()
						.then(function () {
							return ctx.remote.settings.describe()
						})
						.then(function (response) {
							const view = unwrap(response)
							const rows = Array.isArray(view)
								? view
								: (view && Array.isArray(view.namespaces) ? view.namespaces : (view && Array.isArray(view.descriptors) ? view.descriptors : []))
							return rows.find(function (row) { return row.ns === NS }) || null
						})
				},
				write: function (patch, revision) {
					return Promise.resolve()
						.then(function () {
							return ctx.remote.settings.update(NS, patch, revision)
						})
						.then(function (response) {
							unwrap(response)
							return { ok: true }
						})
						.catch(function (failure) {
							return { ok: false, code: (failure && failure.code) || "", message: String((failure && failure.message) || failure) }
						})
				},
			}

			// The document can change while this section sits open — another window, the config
			// file, a patch edit. The revision is a compare-and-set counter, so a stale one turns
			// the next Save into a rejection; taking the new snapshot when the document moves
			// keeps the typed text and drops the stale revision.
			const listeners = new Set()
			const offSettings = typeof ctx.remote.$on === "function" ? ctx.remote.$on("settings/document-updated", function (ns) {
				if (ns !== NS) return
				for (const listener of listeners) listener()
			}) : void 0

			ctx.effect(function () {
				return function () {
					if (typeof locale === "function") locale()
					if (typeof offSettings === "function") offSettings()
				}
			}, "better-sandbox-ui: section dictionary")

			const subscribe = function (listener) {
				listeners.add(listener)
				return function () { listeners.delete(listener) }
			}

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "sandbox",
						order: 45,
						label: function () { return t("nav") },
						inject: function () {
							return { t: t, api: api, subscribe: subscribe }
						},
					},
					SandboxSection
				)
			})
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})

/*
 * dsh-sandbox-allowlist-ui / клиентский раздел настроек песочницы.
 *
 * Читает и пишет правила через штатный слой настроек харнесса
 * (ctx.remote.settings): список правил становится volatile-полем строки
 * sandbox-allowlist, поэтому правка применяется без перемонтирования записей.
 *
 * Формат — ручной бандл __ModuleLoader__, JSX не используется.
 */
window.__ModuleLoader__.load({
	id: "dsh-sandbox-allowlist-ui",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		const react = require("react")
		const h = react.createElement
		const useState = react.useState
		const useEffect = react.useEffect
		const useCallback = react.useCallback

		const NS = "sandbox-allowlist"
		const FIELDS = [
			{ key: "writableDirs", hintKey: "hintWritableDirs" },
			{ key: "readDenyDirs", hintKey: "hintReadDenyDirs" },
			{ key: "readDenyFiles", hintKey: "hintReadDenyFiles" },
			{ key: "denySegments", hintKey: "hintDenySegments" },
		]

		const style = {
			wrap: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 },
			field: { display: "flex", flexDirection: "column", gap: 4 },
			label: { fontSize: 14, fontWeight: 500 },
			hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
			area: { fontFamily: "var(--ds-font-family-code, monospace)", fontSize: 13, minHeight: 78, padding: "8px 10px", borderRadius: 8, border: ".5px solid var(--dsw-alias-border-l4, #999)", background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", width: "100%", boxSizing: "border-box" },
			row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
			button: { padding: "6px 12px", fontSize: 13, borderRadius: 8, cursor: "pointer" },
			note: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
			error: { color: "var(--dsw-alias-state-error-primary, #c9541f)", fontSize: 13 },
		}

		const lines = (value) => (Array.isArray(value) ? value : []).map((item) => String(item)).join("\n")
		const toLines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")

		function SandboxSection(props) {
			const t = props.t
			const api = props.api
			const [state, setState] = useState(null)
			const [drafts, setDrafts] = useState(null)
			const [status, setStatus] = useState(t("loading"))
			const [error, setError] = useState("")
			const [busy, setBusy] = useState(false)

			const reload = useCallback(function () {
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
						const values = {}
						const value = descriptor.value ?? {}
						for (const field of FIELDS) values[field.key] = lines(value[field.key])
						setDrafts(values)
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

			const save = function () {
				if (state === null || drafts === null) return
				const patch = {}
				for (const field of FIELDS) {
					const next = toLines(drafts[field.key])
					const current = (state.value ?? {})[field.key]
					if (lines(next) !== lines(current)) patch[field.key] = next
				}
				if (Object.keys(patch).length === 0) {
					setStatus(t("unchanged"))
					return
				}
				setBusy(true)
				api.write(patch, state.revision)
					.then(function (result) {
						if (result.ok === false) throw new Error(result.message || t("failed"))
						return reload()
					})
					.catch(function (failure) {
						setError(String((failure && failure.message) || failure))
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
					return h(
						"label",
						{ key: field.key, style: style.field },
						h("span", { style: style.label }, t(field.key)),
						h("span", { style: style.hint }, t(field.hintKey)),
						h("textarea", {
							style: style.area,
							value: drafts === null ? "" : drafts[field.key],
							disabled: busy,
							spellCheck: false,
							onChange: function (event) {
								const value = event.target.value
								setDrafts(function (prev) {
									return Object.assign({}, prev, (function () { var next = {}; next[field.key] = value; return next })())
								})
							},
						})
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

		const inject = ["slots", "locale", "connection", "remote", "remote.settings"]

		function apply(ctx) {
			const locale = ctx.locale.register("settings.sandbox", {
				en: {
					nav: "Sandbox",
					intro: "Write grants outside the workspace and read-protected paths. Changes apply without a restart.",
					loading: "loading rules…",
					missing: "sandbox-allowlist entry not found — the sandbox plugin is not mounted.",
					revision: "revision",
					unchanged: "no changes",
					failed: "write failed",
					save: "Save",
					reload: "Reload",
					writableDirs: "Writable roots beyond the workspace",
					readDenyDirs: "Read-protected directories",
					readDenyFiles: "Read-protected files",
					denySegments: "Path names refused for writing",
					hintWritableDirs: "one directory per line",
					hintReadDenyDirs: "keys, tokens, personal data",
					hintReadDenyFiles: "one file per line",
					hintDenySegments: "for example .git",
				},
				zh: {
					nav: "沙盒",
					intro: "工作区之外的写入授权与禁止读取的路径。修改即时生效，无需重启。",
					loading: "正在加载规则…",
					missing: "未找到 sandbox-allowlist 配置项 — 沙盒插件未挂载。",
					revision: "修订版本",
					unchanged: "没有变化",
					failed: "保存失败",
					save: "保存",
					reload: "重新加载",
					writableDirs: "工作区之外的可写目录",
					readDenyDirs: "禁止读取的目录",
					readDenyFiles: "禁止读取的文件",
					denySegments: "禁止写入的路径名称",
					hintWritableDirs: "每行一个目录",
					hintReadDenyDirs: "密钥、令牌、个人数据",
					hintReadDenyFiles: "每行一个文件",
					hintDenySegments: "例如 .git",
				},
			})
			const t = ctx.locale.bind("settings.sandbox")

			const unwrap = function (response) {
				if (response && response.ok === false) throw new Error(response.error && response.error.message ? response.error.message : "settings call failed")
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
							return { ok: false, message: String((failure && failure.message) || failure) }
						})
				},
			}

			ctx.effect(function () {
				return function () {
					if (typeof locale === "function") locale()
				}
			}, "sandbox-allowlist-ui: словарь раздела")

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "sandbox",
						order: 45,
						label: function () { return t("nav") },
						inject: function () {
							return { t: t, api: api }
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

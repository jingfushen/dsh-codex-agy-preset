/**
 * Codex subagent backend, published as one row of this bundle.
 *
 * `@deepseek-ai/dsh-subagent-codex` is NOT part of any shipped distribution:
 * dsh-base registers only the in-process `spawn` and `fork` backends, and the
 * shipped `standard` preset carries a `tool-subagent-codex` row with
 * `disabled: true` because no provider answers that name. This row registers
 * the provider for the whole profile; the preset below exposes the tool.
 *
 * The package drives `codex app-server --stdio` over JSON-RPC and is versioned
 * with the harness (0.2.0-rc.2 matches the desktop runtime 0.2.0-rc.2), so it
 * is installed outside the app bundle in ~/.dsh/subagent-backends and
 * re-exported here by absolute path:
 *
 *   cd ~/.dsh/subagent-backends
 *   npm install --omit=dev --ignore-scripts @deepseek-ai/dsh-subagent-codex@0.2.0-rc.2
 *
 * Re-exporting (rather than a bare specifier) keeps this bundle dependency
 * free: a profile-installed bundle resolves bare specifiers from its own
 * node_modules, which would tie the profile to a second copy of the package.
 *
 * `Config` is deliberately NOT re-exported: the package builds it from its own
 * copy of @deepseek-ai/schemastery, and handing the loader a schema object from
 * a foreign copy risks a validation failure that would take the whole mount
 * down. The row states its two settings explicitly and `apply()` applies its
 * own guard to `disposeGraceMs`.
 *
 * ── LOCAL SHIM: reasoning effort (added 2026-10-17) ─────────────────────────
 *
 * The package can fix the MODEL (`model`, forwarded as the per-thread
 * `thread/start` model) but has no reasoning-effort field anywhere: its Config
 * is `{providerName, model, env, permissionMode, disposeGraceMs}`, and
 * `turn/start` is sent as `{threadId, input}`. Effort can therefore only come
 * from native Codex config — which is exactly what `codex app-server -c
 * key=value` exists to override: a launch-time replacement for a
 * `~/.codex/config.toml` key, scoped to the one child process.
 *
 * So `apply` below consumes `reasoningEffort` from this row's config and
 * injects `-c model_reasoning_effort="<value>"` into the spawned argv,
 * intercepting the seam the provider itself uses (`ctx.subprocess.spawn`)
 * rather than editing the installed package. The package stays pristine and
 * survives its documented reinstall, and the setting stays visible in the row
 * config next to `model`.
 *
 * Verified against the bundled payload (0.153.4) on 2026-10-17 by reading the
 * effective config over a real app-server stdio session (`config/read`):
 * `-c model="gpt-5.6-sol" -c model_reasoning_effort="max"` reported
 * `model_reasoning_effort: "max"`; with no override it reported the native
 * `"medium"`.
 *
 * Scope: the override touches only the child DSH starts. `~/.codex/config.toml`
 * is untouched, so the interactive CLI and the desktop app keep their own model
 * and effort.
 */

import { apply as applyBackend, inject, name } from '/Users/jingfu-shen/.dsh/subagent-backends/node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js'

/** Levels this account's models advertise; anything else is passed through but flagged. */
const KNOWN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max', 'persistent'])

/** The subcommand token the override must follow, because `codex app-server` owns `-c`. */
const APP_SERVER_TOKEN = 'app-server'

/**
 * Insert `-c model_reasoning_effort="<effort>"` immediately after `app-server`.
 *
 * The argv is the package's `[node, <codex.js>, 'app-server', '--stdio']`; the
 * override is an `app-server` option, so it must sit after that subcommand and
 * before the transport flag. Any argv the token is missing from is returned
 * untouched, which keeps a future argv change a visible no-op rather than a
 * stray argument.
 *
 * @param spec - the subprocess spec the provider is about to spawn.
 * @param effort - validated reasoning-effort level.
 * @returns a spec whose argv carries the override.
 */
function injectEffortArgv(spec, effort) {
	const argv = spec?.argv
	if (!Array.isArray(argv)) return spec
	const at = argv.indexOf(APP_SERVER_TOKEN)
	if (at < 0) return spec
	return {
		...spec,
		argv: [...argv.slice(0, at + 1), '-c', `model_reasoning_effort="${effort}"`, ...argv.slice(at + 1)],
	}
}

/**
 * A ctx view whose `subprocess.spawn` rewrites argv, forwarding everything else.
 *
 * The provider captures ctx at registration and reads `ctx.subprocess` at spawn
 * time, so the interception has to live on a view of ctx rather than on the
 * shared service (mutating that would pin every other provider too). Both
 * proxies forward every other property to the real objects, so
 * `registerProvider`, `logger`, and cordis plumbing behave exactly as before.
 *
 * @param ctx - the real plugin context.
 * @param effort - validated reasoning-effort level.
 * @returns a ctx view that pins the effort on every child it starts.
 */
function ctxWithEffort(ctx, effort) {
	const subprocess = ctx.subprocess
	const patchedSubprocess = new Proxy(subprocess, {
		get(target, prop) {
			if (prop === 'spawn') return (spec) => target.spawn.call(target, injectEffortArgv(spec, effort))
			return Reflect.get(target, prop, target)
		},
	})
	return new Proxy(ctx, {
		get(target, prop) {
			if (prop === 'subprocess') return patchedSubprocess
			return Reflect.get(target, prop, target)
		},
	})
}

/**
 * Register the Codex provider, pinning the row's optional reasoning effort.
 *
 * @param ctx - context carrying the shared subagent and subprocess services.
 * @param config - the package's row config plus the local `reasoningEffort`.
 */
function apply(ctx, config = {}) {
	const { reasoningEffort, ...passthrough } = config
	if (reasoningEffort === undefined || reasoningEffort === null) {
		return applyBackend(ctx, passthrough)
	}
	if (typeof reasoningEffort !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(reasoningEffort)) {
		throw new Error(`codex backend: reasoningEffort must be a plain effort name such as "max" (got ${JSON.stringify(reasoningEffort)})`)
	}
	if (!KNOWN_EFFORTS.has(reasoningEffort)) {
		ctx.logger?.warn?.(`codex backend: reasoningEffort "${reasoningEffort}" is not one of ${[...KNOWN_EFFORTS].join(', ')}; passing it through`)
	}
	return applyBackend(ctxWithEffort(ctx, reasoningEffort), passthrough)
}

export { apply, inject, name }

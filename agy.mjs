/**
 * One-shot `agy` (Antigravity CLI) subagent provider for the delegation seam.
 *
 * Modelled on @deepseek-ai/dsh-subagent-codex: an OUT-OF-PROCESS one-shot
 * provider that advertises NO start-time capabilities and publishes through the
 * seam's run-handle / result contract. Where codex is driven over the Codex
 * app-server JSON-RPC protocol, agy is driven through its documented
 * non-interactive print mode, so this adapter owns argv construction and the
 * JSON result envelope instead of a wire protocol.
 *
 * ── argv shape (verified against agy, not guessed) ──────────────────────────
 * `--print` takes the PROMPT as its value: `agy --print` alone exits 2 with
 * "flag needs an argument: -print". agy additionally guards against a following
 * flag being mistaken for the prompt:
 *
 *   $ agy --print --output-format bogus x
 *   Error: --print took "--output-format" as its prompt, so the intended prompt
 *   was left as an argument and ignored. Attach the prompt to the flag
 *   (--print='your prompt') and move --output-format elsewhere
 *
 * So every other flag is emitted BEFORE it and the prompt is attached as
 * `--print=<prompt>`. The prompt never passes through a shell: the seam spawns
 * an argv array, never a command string.
 *
 * ── proxy (the reason this plugin exists in this shape) ─────────────────────
 * Every child gets an explicit proxy environment pointing at this machine's
 * system proxy, 127.0.0.1:12450, on HTTP_PROXY / HTTPS_PROXY / ALL_PROXY, with
 * NO_PROXY emptied so nothing bypasses it. This must be restated here because
 * the subprocess seam starts children from a SCRUBBED environment — an agy
 * child would otherwise inherit none of it and the run would not go through
 * that port.
 *
 * ── why the seam helpers are re-implemented ─────────────────────────────────
 * Every plugin in this preset is deliberately self-contained (relative imports
 * plus `node:` builtins only; none of them touches a bare package specifier).
 * This file follows that convention and therefore re-states the two contracts
 * it needs — settleRunResult and subprocessRunHandle — against their documented
 * behaviour rather than importing them.
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { connect } from 'node:net'

export const name = 'subagent-agy'
export const inject = ['subagents', 'subprocess']

/** This machine's system proxy, confirmed with `scutil --proxy`. */
const PROXY_URL = 'http://127.0.0.1:12450'

/** Envelope selector emitted before `--print`; see the header note on ordering. */
const DEFAULT_OUTPUT_ARGS = ['--output-format', 'json']

/** POSIX grace between subprocess termination tiers. */
const DEFAULT_DISPOSE_GRACE_MS = 3000

/** The seam's bounded-diagnostic limit for SubagentResult.diagnostic. */
const DIAGNOSTIC_LIMIT_BYTES = 4096

/** Per-stream in-memory cap; the CLI's stdout is a result, not a transcript. */
const STREAM_CAP_BYTES = 4 * 1024 * 1024

/**
 * agy takes the prompt as an argv element, so an enormous task would hit the
 * OS argv ceiling and surface as an opaque spawn failure. Refuse it early with
 * an actionable message instead. agy's `--input-format stream-json` would lift
 * this, but that request shape is unverified against a working account.
 */
const MAX_PROMPT_BYTES = 256 * 1024

/** How long the pre-spawn proxy probe may take before it is called unreachable. */
const PROXY_PROBE_TIMEOUT_MS = 1500

/**
 * Out-of-process children cannot honour parent-enforced start features
 * (agentOptions / outputSchema / maxDepth / toolFilter / persona), so the
 * service rejects a request needing any of them rather than accepting and
 * silently ignoring it.
 */
const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

/** Trim a string to a UTF-8 byte budget (a replacement char may end it). */
function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`
}

/** Reject `cwd` unless it is an absolute path to an existing directory. */
function requireUsableCwd(prefix, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error(`${prefix}: the delegating session has no working directory`)
  }
  if (!cwd.startsWith('/')) {
    throw new Error(`${prefix}: child working directory must be absolute, got ${JSON.stringify(cwd)}`)
  }
  let stats
  try {
    stats = statSync(cwd)
  }
  catch (error) {
    throw new Error(`${prefix}: child working directory is not usable: ${String(error?.message ?? error)}`)
  }
  if (!stats.isDirectory()) {
    throw new Error(`${prefix}: child working directory is not a directory: ${cwd}`)
  }
  return cwd
}

/**
 * Read the proxy endpoint out of the child environment, if one is configured.
 * @param env - the environment handed to the child.
 * @returns the endpoint to probe, or `undefined` when no proxy is set.
 */
function proxyEndpoint(env) {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
    ?? env.ALL_PROXY ?? env.all_proxy
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let url
  try {
    url = new URL(raw)
  }
  catch {
    return undefined
  }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port <= 0 || url.hostname === '') return undefined
  return { url: raw, host: url.hostname, port }
}

/**
 * Fail BEFORE spawning when the configured proxy cannot accept a connection.
 *
 * agy reports an unreachable proxy as its generic "Eligibility check failed"
 * text, which points the reader at the account instead of at the dead proxy —
 * observed while testing: pointing the proxy at a closed port produced
 * `Eligibility check failed: ... connect: connection refused`, and the whole
 * run failed in 165ms. Probing here keeps that diagnosis where it belongs.
 * @param prefix - diagnostic prefix.
 * @param endpoint - the proxy to probe.
 * @returns a promise resolving when the proxy accepts a TCP connection.
 */
function assertProxyReachable(prefix, endpoint) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(new Error(`${prefix}: proxy ${endpoint.url} is not reachable (${error.message}) — start the proxy, or set verifyProxy: false to start the child anyway`))
    }
    socket.setTimeout(PROXY_PROBE_TIMEOUT_MS, () => finish(new Error(`no answer within ${PROXY_PROBE_TIMEOUT_MS}ms`)))
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}

/** Flatten the delegated prompt's text blocks into one task string. */
function promptText(prompt) {
  const parts = []
  for (const block of prompt ?? []) {
    if (block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n')
}

/** Buffer one child stream with a byte cap, keeping the head. */
function collectStream(stream) {
  const chunks = []
  let size = 0
  let truncated = false
  if (stream !== undefined && stream !== null && typeof stream.on === 'function') {
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      if (size >= STREAM_CAP_BYTES) {
        truncated = true
        return
      }
      const room = STREAM_CAP_BYTES - size
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer
      chunks.push(slice)
      size += slice.length
      if (slice.length < buffer.length) truncated = true
    })
    stream.on('error', () => {})
  }
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated,
  }
}

/**
 * Read agy's `--output-format json` envelope:
 *
 *   {"conversation_id":"","status":"ERROR","response":"","error":"…",
 *    "duration_seconds":0,"num_turns":0,"usage":{…}}
 *
 * Deliberately tolerant: an unparseable or unrecognised body falls back to raw
 * stdout as the answer, so a future agy build that changes the envelope degrades
 * to "the text agy printed" instead of failing the delegation.
 * @param raw - the child's full stdout.
 * @returns the answer text and, when the child reported one, its error.
 */
function parseEnvelope(raw) {
  const text = raw.trim()
  if (text.length === 0) return { answer: '', error: undefined }
  let value
  try {
    value = JSON.parse(text)
  }
  catch {
    return { answer: text, error: undefined }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { answer: text, error: undefined }
  }
  const reported = typeof value.error === 'string' && value.error.length > 0 ? value.error : undefined
  const status = typeof value.status === 'string' ? value.status : ''
  if (reported !== undefined || /error|fail/i.test(status)) {
    return { answer: '', error: reported ?? `agy reported status ${JSON.stringify(status)}` }
  }
  const response = typeof value.response === 'string' ? value.response : ''
  return { answer: response.length > 0 ? response : text, error: undefined }
}

/** A promise that rejects once `signal` aborts. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('subagent-agy: aborted'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Settle an out-of-process run under the seam contract: the returned promise
 * never rejects after publication, local cancellation wins over an observed
 * outcome, and any failure is flattened to `stopReason: 'error'` carrying a
 * bounded provider-authored diagnostic. The request's abort listener is removed
 * on every path.
 */
function settleRunResult(parts) {
  return Promise.resolve()
    .then(() => parts.attempt())
    .then(
      (result) => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
        return result
      },
      (error) => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
        const failure = error instanceof Error ? error : new Error(String(error))
        try {
          parts.onError?.(failure, 'error')
        }
        catch {}
        const detail = truncateBytes(parts.collectDiagnostic?.() ?? failure.message, DIAGNOSTIC_LIMIT_BYTES)
        const result = { output: parts.collectOutput(), stopReason: 'error' }
        if (detail.length > 0) result.diagnostic = detail
        return result
      },
    )
}

/**
 * Publish the seam run handle for an out-of-process child. `dispose()` is
 * idempotent through one memoized teardown: it detaches the abort listener,
 * settles local cancellation without assuming the child cooperates, then awaits
 * the backend's teardown to actual exit.
 */
function subprocessRunHandle(parts) {
  let disposal
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose() {
      disposal ??= (async () => {
        parts.signal.removeEventListener('abort', parts.onAbort)
        parts.requestCancel()
        await parts.teardown()
      })()
      return disposal
    },
  }
}

/** Tear the child down through the seam's termination ladder to actual exit. */
async function disposeAgyChild(child) {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  }
  catch {}
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Start the `agy` child and publish its one-shot run.
 * @param request - the resolved subagent start request.
 * @param spec - plugin context, resolved config, and the validated child directory.
 * @returns the published run handle.
 */
async function startAgyRun(request, spec) {
  const task = promptText(request.prompt)
  if (task.length === 0) throw new Error('subagent-agy: the delegated prompt carries no text')
  const taskBytes = Buffer.byteLength(task, 'utf8')
  if (taskBytes > MAX_PROMPT_BYTES) {
    throw new Error(`subagent-agy: prompt is ${taskBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte argv ceiling — delegate a shorter task`)
  }
  if (request.signal.aborted) throw new Error('subagent-agy: request was aborted before startup')

  // Probe before spawning so an unreachable proxy is reported as itself rather
  // than as agy's misleading eligibility failure.
  const endpoint = proxyEndpoint(spec.config.env)
  if (endpoint !== undefined && spec.config.verifyProxy) {
    await assertProxyReachable('subagent-agy', endpoint)
    if (request.signal.aborted) throw new Error('subagent-agy: request was aborted before startup')
  }

  const argv = [spec.config.command, ...spec.config.outputArgs, `--print=${task}`]
  const child = spec.ctx.subprocess.spawn({
    argv,
    cwd: spec.cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.config.disposeGraceMs,
    env: spec.config.env,
  })

  const stdout = collectStream(child.stdout)
  const stderr = collectStream(child.stderr)

  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-agy: run cancelled locally'))
    try {
      child.terminate()
    }
    catch {}
  }
  const onAbort = () => requestCancel()
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = () => {
    const { answer } = parseEnvelope(stdout.text())
    return answer.length > 0 ? [{ type: 'text', text: answer }] : []
  }

  const attempt = async () => {
    if (runAbort.signal.aborted) throw new Error('subagent-agy: run cancelled before the child settled')
    const outcome = await Promise.race([child.done, abortPromise(runAbort.signal)])
    if (runAbort.signal.aborted) throw new Error('subagent-agy: run cancelled before the child settled')
    const { answer, error } = parseEnvelope(stdout.text())
    if (error !== undefined) throw new Error(`subagent-agy: ${error}`)
    if (outcome.exitCode !== 0) {
      throw new Error(`subagent-agy: agy exited with code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}`)
    }
    if (answer.length === 0) throw new Error('subagent-agy: agy completed without a final answer')
    return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
  }

  const result = settleRunResult({
    attempt,
    collectOutput,
    // Prefer agy's own error text (its message is the actionable one); fall
    // back to the child's stderr tail.
    collectDiagnostic: () => {
      const { error } = parseEnvelope(stdout.text())
      if (error !== undefined) return error
      const tail = stderr.text().trim()
      return tail.length > 0 ? tail : undefined
    },
    cancelled: () => runAbort.signal.aborted,
    onError: (failure, stopReason) => {
      try {
        spec.ctx.logger?.warn?.(`subagent-agy: child run failed (${stopReason}): ${failure.message}`)
      }
      catch {}
    },
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: randomUUID(),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeAgyChild(child),
  })
}

/** One publisher of a named `agy` child, running agy's print mode once. */
class AgyProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  name = 'agy'
  capabilities = NO_START_CAPABILITIES
  inheritsParentContext = false

  async start(request) {
    const parentCwd = request.parent?.session?.header?.cwd
    if (parentCwd === undefined) {
      throw new Error('subagent-agy: no working directory for the child — delegate from a parent session that has one')
    }
    return startAgyRun(request, {
      ctx: this.ctx,
      config: this.config,
      cwd: requireUsableCwd('subagent-agy', parentCwd),
    })
  }
}

/**
 * Register the `agy` provider.
 * @param ctx - context carrying the shared subagent registry and subprocess seam.
 * @param config - optional `command`, `outputArgs`, `env`, and `disposeGraceMs`.
 */
export function apply(ctx, config = {}) {
  const resolved = {
    command: typeof config.command === 'string' && config.command.length > 0 ? config.command : 'agy',
    outputArgs: Array.isArray(config.outputArgs) ? config.outputArgs.map(String) : [...DEFAULT_OUTPUT_ARGS],
    // Proxy defaults first so a config can override or extend them, never drop
    // them by accident.
    env: {
      HTTP_PROXY: PROXY_URL,
      HTTPS_PROXY: PROXY_URL,
      ALL_PROXY: PROXY_URL,
      NO_PROXY: '',
      ...(config.env ?? {}),
    },
    disposeGraceMs: Number.isFinite(config.disposeGraceMs) ? config.disposeGraceMs : DEFAULT_DISPOSE_GRACE_MS,
    // Probe the configured proxy before every spawn unless explicitly disabled.
    verifyProxy: config.verifyProxy !== false,
  }
  ctx.subagents.registerProvider(new AgyProvider(ctx, resolved))
}

/**
 * `codex_imagegen` — a model-facing tool that wraps the Codex CLI's own image
 * generation, so a DeepSeek Harness agent can create or edit raster images
 * without leaving the harness.
 *
 * ── what it wraps (verified on this machine, 2026-10-10) ────────────────────
 * There is no DSH image-generation service. The capability lives in Codex as
 * the shipped `.system/imagegen` skill, which drives Codex's built-in
 * `image_gen` tool (GPT Image) in the signed-in ChatGPT account; its outputs
 * land under `$CODEX_HOME/generated_images/<thread>/<call>.png`. This tool runs
 * `codex exec` non-interactively with an instruction that names that workflow
 * and a destination path, then resolves the produced file.
 *
 * ── why it spawns directly instead of through the subprocess seam ───────────
 * A preset plugin here is plain ESM loaded by the Loader into the Host process;
 * it cannot import `@deepseek-ai/dsh-tools` (a profile-installed bundle has no
 * node_modules for shipped packages). It therefore declares a raw JSON Schema
 * and a `{ schema, render }` output — the exact form `ctx.tools.register`
 * accepts (the same shape @deepseek-ai/dsh-mcp-client builds for MCP tools) —
 * and uses `node:child_process` to run the CLI. Codex is a long-running,
 * network-bound child that must inherit this machine's `HOME` and `PATH`
 * (`~/.local/bin`), which the seam's scrubbed environment would not provide.
 *
 * ── batch mode ──────────────────────────────────────────────────────────────
 * The tool declares that a batch of related assets is ONE generation, not many:
 * ask for a sheet on an even grid, then cut it. Pass `grid: { rows, cols }` and
 * the tool cuts the sheet itself with `python3` + Pillow into
 * `<stem>-r{row}c{col}.png` beside it; the tool description tells the model that
 * cropping the sheet by hand (bash + Pillow) is equally fine. The declaration
 * lives in the description because it is a policy for the calling agent, and it
 * is restated in the Codex instruction when `grid` is present so the child lays
 * the sheet out on the same grid.
 *
 * ── model ───────────────────────────────────────────────────────────────────
 * The child runs `codex exec -m gpt-6-astra -c model_reasoning_effort="xhigh"`
 * by default: GPT-6-Astra at extra-high effort, verified against
 * ~/.codex/models_cache.json (the slug is `gpt-6-astra`; it advertises the
 * `xhigh` level). Override or disable either through the row's config:
 * `model: null` and `reasoningEffort: null` fall back to the CLI's own
 * defaults.
 *
 * ── timeout ─────────────────────────────────────────────────────────────────
 * Image generation takes tens of seconds to a few minutes. The tool declares a
 * 15-minute `timeoutMs`; the profile's tool-call timeout policy enforces it
 * cooperatively and hands back `exec.signal`, which this tool wires to SIGTERM
 * -> SIGKILL on the child so an aborted call does not orphan a codex process.
 */

import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'tool-codex-imagegen'
export const inject = ['tools']

/** 15 minutes: enough for a batch prompt, short enough to fail visibly. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** The Codex model the child runs, and its reasoning effort. */
const DEFAULT_MODEL = 'gpt-6-astra'
const DEFAULT_REASONING_EFFORT = 'xhigh'

/** Interpreter used for batch-sheet cropping; must have Pillow available. */
const DEFAULT_PYTHON = 'python3'

/** Cap on each captured child stream; codex's stdout is a result, not a log. */
const STREAM_CAP_BYTES = 2 * 1024 * 1024

/** How far before the spawn we still accept a generated file as "ours". */
const CLOCK_SLACK_MS = 5000

/** Extensions treated as generated images when scanning Codex's output tree. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'What to generate or change, in full detail: subject, style, composition, colors, and any text that must appear. Describe an edit as the change plus the reference image(s).',
    },
    out: {
      type: 'string',
      description:
        'Optional absolute path for the finished image (for example /Users/me/project/assets/hero.png). Parent directories are created. Defaults to <workspace>/imagegen/codex-imagegen-<timestamp>.png.',
    },
    refs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional absolute paths of reference images to edit, restyle, or match.',
    },
    grid: {
      type: 'object',
      additionalProperties: false,
      required: ['rows', 'cols'],
      properties: {
        rows: { type: 'integer', description: 'Tile rows to cut the generated sheet into (1-16).' },
        cols: { type: 'integer', description: 'Tile columns to cut the generated sheet into (1-16).' },
      },
      description:
        'Batch mode: ask for ONE sheet holding rows x cols variants and have the tool cut it into separate files. Use this instead of one call per asset for icon sets, card or illustration variants, sprite sheets, and any family of related images.',
    },
    cwd: {
      type: 'string',
      description:
        'Optional working root for the Codex child. Defaults to the calling session workspace, which is what you normally want.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    path: { type: 'string' },
    generated: { type: 'array', items: { type: 'string' } },
  },
  required: ['content'],
  additionalProperties: false,
}

/**
 * Build the instruction handed to `codex exec`. It states the skill to use, the
 * exact destination, and the exact final line to answer with, because the child
 * is a fresh session that sees none of the parent conversation. In batch mode it
 * also pins the sheet layout, because the tiles are cut on an even grid.
 */
function buildInstruction(prompt, outPath, refs, grid) {
  const lines = [
    'Use your imagegen skill (the built-in image_gen tool) to produce the image described below.',
    'Do not write code, SVG, or HTML to draw it; the result must be a raster image from image_gen.',
    '',
    prompt,
  ]
  if (refs.length > 0) {
    lines.push('', `Reference image(s) are attached: ${refs.join(', ')}.`)
  }
  if (grid !== undefined) {
    lines.push(
      '',
      `Lay the whole result out as ONE sheet on a clean ${grid.cols}-column by ${grid.rows}-row grid:`,
      'one self-contained subject centered in each cell, equal cell sizes, even gutters,',
      'nothing crossing a cell boundary, and no labels, borders, or stray marks in the gutters.',
      `The sheet will be cut into ${grid.rows * grid.cols} separate square-ish images along that grid.`,
    )
  }
  lines.push(
    '',
    `When the image is ready, copy the final selected file to this absolute path (create parent directories if needed):`,
    outPath,
    'Then reply with that path alone on the last line.',
  )
  return lines.join('\n')
}

/** Buffer one child stream up to a cap, keeping the head and the exit tail. */
function collectStream(stream) {
  const chunks = []
  let bytes = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (bytes >= STREAM_CAP_BYTES) {
      truncated = true
      return
    }
    const room = STREAM_CAP_BYTES - bytes
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    chunks.push(slice)
    bytes += slice.length
    if (slice.length < chunk.length) truncated = true
  })
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => truncated,
  }
}

/** Recursively collect files under `dir` newer than `sinceMs`. */
function findImagesNewerThan(dir, sinceMs, found = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      findImagesNewerThan(full, sinceMs, found)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !IMAGE_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
    try {
      const stats = statSync(full)
      if (stats.mtimeMs >= sinceMs) found.push({ path: full, mtimeMs: stats.mtimeMs })
    } catch {
      /* a file that vanished mid-scan is not our result */
    }
  }
  return found
}

/** Locate the newest codex output, preferring the requested destination. */
function resolveProducedImage(outPath, codexHome, sinceMs) {
  if (outPath !== undefined && existsSync(outPath)) {
    return { path: outPath, generated: [] }
  }
  const root = join(codexHome, 'generated_images')
  const found = findImagesNewerThan(root, sinceMs - CLOCK_SLACK_MS).sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (found.length === 0) return { path: undefined, generated: [] }
  const newest = found[0].path
  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true })
    copyFileSync(newest, outPath)
    return { path: outPath, generated: found.map((f) => f.path) }
  }
  return { path: newest, generated: found.map((f) => f.path) }
}

/**
 * Validate the optional batch grid. Bounds are 1-16 per axis: past that the
 * tiles are too small to be useful and the request is almost certainly a
 * mistake. Returns `undefined` when the caller asked for a single image.
 */
function normalizeGrid(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('codex_imagegen: `grid` must be an object with integer `rows` and `cols`')
  }
  const { rows, cols } = raw
  for (const [label, value] of [['rows', rows], ['cols', cols]]) {
    if (!Number.isInteger(value) || value < 1 || value > 16) {
      throw new Error(`codex_imagegen: \`grid.${label}\` must be an integer between 1 and 16, got ${JSON.stringify(value)}`)
    }
  }
  if (rows * cols === 1) return undefined
  return { rows, cols }
}

/**
 * Pillow program that cuts one sheet into `rows x cols` tiles on even integer
 * boundaries. It runs as one `python3 -c` argv element (never through a shell)
 * and prints the written paths, one per line.
 *
 * Boundaries are `floor(i * size / n)`, so with an odd pixel size the tiles
 * differ by at most one pixel and together cover every pixel exactly once.
 */
const CROP_PROGRAM = [
  'import sys',
  'from PIL import Image',
  'src, tmpl, rows, cols = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])',
  'im = Image.open(src)',
  'W, H = im.size',
  'written = []',
  'for r in range(rows):',
  '    y0, y1 = r * H // rows, (r + 1) * H // rows',
  '    for c in range(cols):',
  '        x0, x1 = c * W // cols, (c + 1) * W // cols',
  '        p = tmpl.format(r=r + 1, c=c + 1)',
  '        im.crop((x0, y0, x1, y1)).save(p)',
  '        written.append(p)',
  'print("\\n".join(written))',
].join('\n')

/**
 * Cut one generated sheet into tiles beside it: `hero.png` with grid 2x3 gives
 * `hero-r1c1.png` … `hero-r2c3.png`.
 * @returns the written tile paths.
 */
async function cropGridTiles(sheetPath, grid, python) {
  const extension = extname(sheetPath) || '.png'
  const stem = basename(sheetPath, extension)
  const template = join(dirname(sheetPath), `${stem}-r{r}c{c}${extension}`)
  const { stdout } = await execFileAsync(
    python,
    ['-c', CROP_PROGRAM, sheetPath, template, String(grid.rows), String(grid.cols)],
    { maxBuffer: 1024 * 1024 },
  )
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/** Run one command to completion under the caller's abort signal. */
function runCodex(argv, options, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = collectStream(child.stdout)
    const stderr = collectStream(child.stderr)
    let settled = false
    let killTimer

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 3000)
      killTimer.unref?.()
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }

    child.on('error', (error) => {
      finish(
        rejectPromise,
        new Error(`codex_imagegen: could not start ${argv[0]} (${error.message}). Install the Codex CLI or set the tool's command config.`),
      )
    })
    child.on('close', (code, sig) => {
      const out = stdout.text()
      const err = stderr.text()
      if (signal?.aborted === true) {
        finish(rejectPromise, new Error('codex_imagegen: the tool call was aborted before codex finished'))
        return
      }
      finish(resolvePromise, { code, signal: sig, stdout: out, stderr: err, truncated: stdout.truncated() || stderr.truncated() })
    })
  })
}

/** Pick the codex executable: explicit config, the local install, then PATH. */
function resolveCommand(config) {
  const candidates = []
  if (typeof config.command === 'string' && config.command.length > 0) candidates.push(config.command)
  candidates.push(join(homedir(), '.local', 'bin', 'codex'), 'codex')
  for (const candidate of candidates) {
    if (!candidate.includes('/')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'codex'
}

function textBlock(text) {
  return { type: 'text', text }
}

function createDefinition(config) {
  const command = resolveCommand(config)
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  // `model: null` / `reasoningEffort: null` explicitly defer to Codex's config.
  const model = config.model === null
    ? undefined
    : typeof config.model === 'string' && config.model.length > 0 ? config.model : DEFAULT_MODEL
  const reasoningEffort = config.reasoningEffort === null
    ? undefined
    : typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0
      ? config.reasoningEffort
      : DEFAULT_REASONING_EFFORT
  // Interpreter used to cut a batch sheet into tiles (needs Pillow).
  const python = typeof config.pythonCommand === 'string' && config.pythonCommand.length > 0
    ? config.pythonCommand
    : DEFAULT_PYTHON
  const codexHome = typeof config.codexHome === 'string' && config.codexHome.length > 0
    ? config.codexHome
    : process.env.CODEX_HOME ?? join(homedir(), '.codex')

  return {
    name: 'codex_imagegen',
    description:
      'Generate a new raster image, or edit an existing one, with OpenAI GPT Image through the Codex CLI\'s imagegen skill (the child runs GPT-6-Astra at xhigh reasoning effort by default). Use it for bitmap assets — illustrations, icons with shading, photos, textures, mockups. Do not use it for SVG/vector work or anything better built directly in HTML/CSS. Returns the path of the produced file; pass `out` to place it at a chosen absolute path, and `refs` to edit reference images. BATCH: when several related images are needed (an icon set, card or slide variants, a sprite sheet, a family of illustrations), do NOT call this tool once per asset. Ask for ONE sheet that holds them all on an even grid, and either pass `grid` so the tool cuts the sheet into separate tiles, or cut it yourself with the bash tool afterwards.',
    parameters: PARAMETERS,
    timeoutMs,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks = Array.isArray(value?.content) ? value.content : []
        const text = blocks
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        return text.length > 0 ? [textBlock(text)] : [textBlock('codex_imagegen finished without a file path')]
      },
    },
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('codex_imagegen: `prompt` must be a non-empty string')

      const sessionCwd = exec?.agent?.session?.header?.cwd
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
        ? args.cwd
        : typeof sessionCwd === 'string' && sessionCwd.length > 0
          ? sessionCwd
          : process.cwd()
      if (!isAbsolute(cwd)) throw new Error(`codex_imagegen: working directory must be absolute, got ${JSON.stringify(cwd)}`)

      const refs = Array.isArray(args.refs) ? args.refs.filter((ref) => typeof ref === 'string' && ref.length > 0) : []
      for (const ref of refs) {
        if (!isAbsolute(ref)) throw new Error(`codex_imagegen: reference image must be an absolute path, got ${JSON.stringify(ref)}`)
        if (!existsSync(ref)) throw new Error(`codex_imagegen: reference image not found: ${ref}`)
      }

      const grid = normalizeGrid(args.grid)

      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const outPath = typeof args.out === 'string' && args.out.length > 0
        ? resolve(args.out)
        : join(cwd, 'imagegen', `codex-imagegen-${stamp}.png`)
      if (!isAbsolute(outPath)) throw new Error(`codex_imagegen: output path must resolve to an absolute path`)

      const instruction = buildInstruction(prompt, outPath, refs, grid)
      const argv = [command, 'exec', '--skip-git-repo-check', '--color', 'never', '-C', cwd]
      for (const ref of refs) argv.push('--image', ref)
      if (model !== undefined) argv.push('-m', model)
      // Quoted so the TOML parser gets a string; `xhigh` alone still works via
      // the raw-string fallback, but the explicit form is unambiguous.
      if (reasoningEffort !== undefined) argv.push('-c', `model_reasoning_effort="${reasoningEffort}"`)
      argv.push(instruction)

      const startedAt = Date.now()
      const env = { ...process.env, ...(config.env ?? {}) }
      const result = await runCodex(argv, { cwd, env }, exec?.signal)

      const produced = resolveProducedImage(outPath, codexHome, startedAt)
      if (produced.path === undefined) {
        const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-12).join('\n')
        const suffix = result.truncated ? ' (output truncated)' : ''
        throw new Error(
          `codex_imagegen: codex exited with code ${String(result.code)} and produced no image file.${suffix}` +
            (tail.length > 0 ? `\n--- codex output tail ---\n${tail}` : ''),
        )
      }

      const lines = [`Generated image: ${produced.path}`]
      let tiles = []
      if (grid !== undefined) {
        try {
          tiles = await cropGridTiles(produced.path, grid, python)
          lines.push(`Cut into ${tiles.length} tiles (${grid.cols} columns x ${grid.rows} rows):`)
          for (const tile of tiles) lines.push(`- ${tile}`)
        } catch (error) {
          // The sheet exists and is usable; report the failed cut instead of
          // throwing the whole call away, so the caller can crop it itself.
          lines.push(
            `Could not cut the sheet into a ${grid.cols}x${grid.rows} grid (${error instanceof Error ? error.message : String(error)}).`,
            'The full sheet above is intact: crop it with the bash tool (python3 + Pillow is installed) or another image tool.',
          )
        }
      }
      if (produced.generated.length > 1) {
        lines.push(`Other images from this run (${produced.generated.length - 1}):`)
        for (const path of produced.generated.slice(1)) lines.push(`- ${path}`)
      }
      if (result.code !== 0) {
        lines.push(`Note: codex exited with code ${String(result.code)} after producing the file.`)
      }

      const allFiles = [produced.path, ...tiles]
      return {
        content: [textBlock(lines.join('\n'))],
        path: produced.path,
        generated: allFiles,
      }
    },
  }
}

/**
 * Register `codex_imagegen` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional `command`, `model`, `codexHome`, `env`, `timeoutMs`, `pythonCommand`.
 */
export function apply(ctx, config = {}) {
  ctx.tools.register(createDefinition(config))
}

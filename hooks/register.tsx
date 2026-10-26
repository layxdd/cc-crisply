import type { EngineInterface, Register, RenderChildren } from 'claude-code'
import { atom, memberOf, read, update } from 'claude-code'
import type { Run } from './layout'
import { frameWidth, hardWrap, layoutTable, pad, softWrap, textWidth, wrap, wrapRuns } from './layout'
import type { Drawing, Look, Pictures, Shade } from './merman'
import {
  fileUrl,
  folderOf,
  hashOf,
  kindOf,
  MIN_PICTURE,
  noteOf,
  pictureFor,
  previewPathOf,
  renderPicture,
  renderText,
  shadeName,
  svgOf,
  writePreview,
} from './merman'
import type { CodeBlock, Inline, ProseBlock, Quote, Segment, Table } from './parse'
import { parseInline, plainInline, plainText, showCodeTicks, splitMarkdown, splitProse, tableAsCsv } from './parse'

// One per message, so a copy draws again only the message it marks.
const copied = atom({ plugin: 'cc-crisply', key: 'copied' } as const, null)

// One per Mermaid diagram (its source, width and theme): its merman picture
// once drawn, or why there is none.
const figures = atom({ plugin: 'cc-crisply', key: 'figures' } as const, null)

// The border around the person's prompt, in the theme's primary blue, on
// the prompt's own background, with its pointer in the left border's place
// on the first row, so the text keeps its column: as Claude Code draws them.
const PROMPT_COLOR = 'permission'
const PROMPT_BACKGROUND = 'userMessageBackground'
const PROMPT_POINTER = '❯'
// The narrowest window the box is drawn in.
const PROMPT_MIN_WIDTH = 12

// What a table's copy buttons can take at most: `[ ✓ copied ]`, a gap and
// `[ ✓ copied ]` again.
const BUTTONS_WIDTH = 25

// The icons on the buttons: two boxes to copy, a check once copied, and an
// arrow out to the browser.
const COPY_ICON = '⧉'
const DONE_ICON = '✓'
const PREVIEW_ICON = '↗'

// What to install to see diagrams, told once.
const INSTALL_HINT = `Install merman-cli to see Mermaid diagrams drawn`

// Inline code and links in the colors Claude Code gives them, in the blocks
// the plugin draws: code in the theme's light blue, and links in bright blue,
// the nearest a plugin can name to the terminal's own bright blue Claude Code
// uses (a color is a theme key, a name or hex). Bold takes no color of its own.
const CODE_COLOR = 'suggestion'
const LINK_COLOR = 'blueBright'

// Headings in Claude's orange; the copy buttons in the links' blue.
const HEADING_COLOR = 'claude'
const BUTTON_COLOR = LINK_COLOR

// A task list item's `- [ ]` or `- [x]`, in the inline code color; a ticked
// item's text is then dim and struck, with no `~~` marks.
const TASK_COLOR = CODE_COLOR

// How long a pressed copy button reads `copied` before it reads as before.
const COPIED_FOR_MS = 2000

// How a run of a block the plugin draws looks; a link's also says where it
// goes.
type Style = {
  color?: string
  bold?: boolean
  italic?: boolean
  strikethrough?: boolean
  dimColor?: boolean
  href?: string
}

// A block with copy buttons: `n` numbers it within its message, for the
// buttons' keys and the `copied` mark.
type Copyable = { n: number; requestId: string; text: string; table?: Table }

// Numbers a message's code blocks and tables 1, 2, … in order, those in
// quotes included.
function numberBlocks(requestId: string, segments: Segment[], numbered = new Map<Segment, Copyable>()) {
  for (const seg of segments) {
    if (seg.kind === 'prose') continue
    if (seg.kind === 'quote') {
      numberBlocks(requestId, seg.parts, numbered)
      continue
    }
    const n = numbered.size + 1
    numbered.set(
      seg,
      seg.kind === 'table' ? { n, requestId, text: seg.raw, table: seg } : { n, requestId, text: seg.source },
    )
  }

  return numbered
}

// A first line a shell would run: a prompt sign, or a common command.
const COMMAND =
  /^(\$ |(sudo|npm|npx|pnpm|yarn|bun|git|gh|cd|ls|mkdir|rm|cp|mv|cat|echo|export|curl|wget|brew|pip3?|python3?|node|docker|kubectl|make|cargo|go|claude|chmod|chown|ssh|tar|grep|find|source)( |$))/

// How JSON opens: an object's first key or its end, an array's first value or
// its end.
const JSON_START = /^(\{\s*["}]|\[\s*(["{[\]\d-]|(true|false|null)\s*[,\]]))/

// Whether the code is JSON: once its fence has closed, if it parses; while
// it streams, which no part of it would, by how it opens (JSON_START).
function isJson(source: string, isOpen: boolean): boolean {
  if (!JSON_START.test(source)) return false
  if (isOpen) return true
  try {
    JSON.parse(source)

    return true
  } catch {
    return false
  }
}

// The language to highlight a block in: the fence's as written, so it is
// highlighted as Claude Code highlights it, or for a fence with none a guess
// from the code itself.
function codeLanguage(seg: CodeBlock): string | undefined {
  if (seg.language !== '') return seg.language
  const source = seg.source.trim()
  if (isJson(source, seg.isOpen)) return 'json'
  if (COMMAND.test(source)) return 'bash'

  return undefined
}

// Tab and newline are the only control characters a drawing takes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

// Code as a fence again, for Claude Code's markdown to highlight in its own
// colors: one backtick longer than any run of them opening a line inside, so
// the code cannot close it.
function fenceOf(source: string, language = '') {
  const runs = source.match(/^\s*`{3,}/gm) ?? []
  const ticks = '`'.repeat(Math.max(3, ...runs.map(r => r.trim().length + 1)))

  return `${ticks}${language}\n${source}\n${ticks}`
}

// The message whose button shows `copied`, so a copy in another one can
// clear it.
let marked: string | undefined

// The diagrams being drawn, by their state's key, so each starts once; and
// the previews being written, by their source and look.
const drawing = new Set<string>()
const writing = new Map<string, Promise<string>>()
// What each diagram was last drawn as, by its message and number, so the
// debug log has a line when that changes and not at every streamed word.
const drawnAs = new Map<string, string>()
// How many times in a row each diagram's drawing was cut short: past
// MAX_CUT_SHORT, the failure is stored, so one that always throws (a timeout,
// an unwritable folder) stops being drawn again at every render.
const cutShort = new Map<string, number>()
const MAX_CUT_SHORT = 3

// The Claude Code theme's look, for the diagrams' colors, as last read.
let look: Look = 'dark'
// How long the system's appearance is trusted before it is asked again.
const APPEARANCE_FOR_MS = 10_000
let appearance: { look: Look; at: number } | undefined
// How long the theme's look, once read, is trusted: a message is drawn again
// at each streamed word, and the look need not be read each time.
const LOOK_FOR_MS = 2000
let lookRead: { look: Look; at: number } | undefined
// The terminal's background as last read (backgroundFor), none where it
// can't be read, trusted as long as the system's appearance: the read itself,
// so renders at once share one.
let background: { hex: Promise<string | undefined>; at: number } | undefined

// In Ghostty, its background as it is configured now (`ghostty
// +show-config`, `background = #1f1f1f`). A theme of its own can be dark
// while macOS is light. Rejects where Ghostty could not be asked.
async function ghosttyBackgroundOf($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('TERM_PROGRAM')) !== 'ghostty') return undefined
  const folder = await $.env.get('GHOSTTY_BIN_DIR')
  const ghostty = folder === undefined ? 'ghostty' : `${folder}/ghostty`
  const run = await $.process.run([ghostty, '+show-config'], { timeoutMs: 3000 })
  const hex = /^background\s*=\s*#?([0-9a-f]{6})\s*$/im.exec(run.stdout)?.[1]

  return hex === undefined ? undefined : `#${hex.toLowerCase()}`
}

// In kitty, its background as its config sets it now (`#1a1b26`), read by
// kitty's own config loader so `include`d theme files count. Its remote
// control, which could ask the running window, is off by default. Rejects
// where kitty could not be asked.
async function kittyBackgroundOf($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('KITTY_WINDOW_ID')) === undefined) return undefined
  const script = 'from kitty.cli import create_default_opts; print(create_default_opts().background.as_sharp)'
  const run = await $.process.run(['kitty', '+runpy', script], { timeoutMs: 3000 })
  const hex = /^#([0-9a-f]{6})\s*$/im.exec(run.stdout)?.[1]

  return hex === undefined ? undefined : `#${hex.toLowerCase()}`
}

// The terminal's background, Ghostty's or kitty's, as read now.
async function readBackground($: EngineInterface): Promise<string | undefined> {
  return (await ghosttyBackgroundOf($)) ?? (await kittyBackgroundOf($))
}

// The terminal's background where it can be read, asked again after a while:
// by the worker where it runs, which no newer render aborts. A read that
// fails keeps the background last read, so a picture's shade, and so its
// key, does not flip from one read to the next.
async function backgroundFor($: EngineInterface): Promise<string | undefined> {
  const now = await $.clock.now()
  if (background === undefined || now - background.at > APPEARANCE_FOR_MS) {
    const last = background?.hex
    const read = isWorking
      ? new Promise<string | undefined>((resolve, reject) => queue($, { kind: 'background', resolve, reject }))
      : readBackground($)
    background = { hex: read.catch(() => last), at: now }
  }

  return background.hex
}

// A background color (`#1f1f1f`) as dark or light, by its luminance.
function lookOfHex(hex: string): Look {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? 'dark' : 'light'
}

// The terminal's own background for a picture in `look` to sit on, where it
// can be read and is of that look: a dark picture in a light terminal keeps
// its palette's.
async function canvasFor($: EngineInterface, look: Look): Promise<string | undefined> {
  try {
    const hex = await backgroundFor($)

    return hex !== undefined && lookOfHex(hex) === look ? hex : undefined
  } catch {
    return undefined
  }
}

// Whether the terminal's background is dark or light, for the theme `auto`:
// the terminal's own word where it gives one (COLORFGBG, `15;0` light text on
// black), else its background where it can be read (backgroundFor), else
// macOS's appearance, which most terminals there follow; dark where none
// says.
async function systemLookOf($: EngineInterface): Promise<Look> {
  // An empty or odd value says nothing.
  const colors = (await $.env.get('COLORFGBG'))?.split(';').at(-1) ?? ''
  if (/^\d+$/.test(colors)) return Number(colors) === 7 || Number(colors) >= 9 ? 'light' : 'dark'
  const hex = await backgroundFor($)
  if (hex !== undefined) return lookOfHex(hex)
  const style = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle']).catch(() => undefined)
  if (style === undefined) return 'dark'

  return style.exitCode === 0 && /dark/i.test(style.stdout) ? 'dark' : 'light'
}

// The look of the theme Claude Code draws in now: a light or dark theme's
// own, and for `auto` the system's (systemLookOf), asked again after a while.
// Read as each diagram is drawn, so a theme changed any way is followed.
// One that can't be read keeps the look last read. The `theme` setting,
// `dark` or `light`, is the look whatever the theme.
async function lookFor($: EngineInterface, theme: 'auto' | Look): Promise<Look> {
  if (theme !== 'auto') return theme
  try {
    const now = await $.clock.now()
    if (lookRead !== undefined && now - lookRead.at < LOOK_FOR_MS) return lookRead.look
    const theme = String((await $.config.list()).find(row => row.key === 'theme')?.value ?? '')
    let found: Look
    if (theme.includes('light')) found = 'light'
    else if (theme.includes('dark')) found = 'dark'
    else {
      if (appearance === undefined || now - appearance.at > APPEARANCE_FOR_MS) {
        appearance = { look: await systemLookOf($), at: now }
      }
      found = appearance.look
    }
    lookRead = { look: found, at: now }

    return found
  } catch {
    return look
  }
}

// Whether the install hint has been looked at this session.
let isHintChecked = false

// Whether the terminal draws pictures, from what it is: the terminals Claude
// Code draws them in, Ghostty and kitty (`always`), and iTerm2 3.5 and later
// in the fullscreen layout alone (`fullscreen`). None inside tmux, zellij or
// screen, which hold pictures back or draw them nowhere; the
// `diagramDisplay` setting `text` turns them off everywhere.
async function knownImagesOf($: EngineInterface): Promise<'always' | 'fullscreen' | undefined> {
  const [term, program, version, tmux, zellij, screen] = await Promise.all([
    $.env.get('TERM'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('TERM_PROGRAM_VERSION'),
    $.env.get('TMUX'),
    $.env.get('ZELLIJ'),
    $.env.get('STY'),
  ])
  if (tmux !== undefined || zellij !== undefined || screen !== undefined) return undefined
  if (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty') return 'always'
  const [major = 0, minor = 0] = (version ?? '').split('.').map(Number)
  if (program === 'iTerm.app' && (major > 3 || (major === 3 && minor >= 5))) return 'fullscreen'

  return undefined
}

// Whether merman-cli runs here.
async function mermanRuns($: EngineInterface) {
  try {
    return (await $.process.run(['merman-cli', '--version'], { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

// Whether the session runs over SSH, where a preview written here can't open
// on the person's screen.
async function sshOf($: EngineInterface): Promise<boolean> {
  const [connection, tty] = await Promise.all([$.env.get('SSH_CONNECTION'), $.env.get('SSH_TTY')])

  return connection !== undefined || tty !== undefined
}

// Writes the diagram's preview once, and again only after a failed try or
// once its file is gone, as a temp folder cleaned during a long session
// leaves it.
async function previewFor($: EngineInterface, source: string): Promise<string> {
  const shown = look
  const key = `${hashOf(source)}:${shown}`
  const known = writing.get(key)
  if (known !== undefined) {
    const path = await known
    if (await $.fs.exists(path).catch(() => true)) return path
    // Written again once, however many asked while it was gone.
    if (writing.get(key) === known) writing.delete(key)
    const again = writing.get(key)
    if (again !== undefined) return again
  }
  const preview = writePreview($, source, shown)
  writing.set(key, preview)
  preview.catch(() => writing.delete(key))

  return preview
}

// The command that opens a page in the default browser: `open` on macOS,
// `start` on Windows, `xdg-open` elsewhere.
async function openerOf($: EngineInterface): Promise<string[]> {
  if ((await $.env.get('OS')) === 'Windows_NT') return ['cmd', '/c', 'start', '']
  const uname = await $.process.run(['uname', '-s']).catch(() => undefined)

  return uname?.stdout.trim() === 'Darwin' ? ['open'] : ['xdg-open']
}

// Work a render starts that outlives it: drawing a diagram, writing its
// preview, reading the terminal's background. A render can't do it on its own `$`: the engine aborts
// a render's commands once a newer render of its message supersedes it, which
// scrolling and streaming do all the time, and refuses state written while a
// render is dispatched. So it queues the work, and a worker session.start
// runs for the session's life does it on that hook's `$`.
type Job =
  | { kind: 'draw'; key: string; isPicture: boolean; source: string; width: number; shade: Shade }
  | { kind: 'preview'; source: string }
  | { kind: 'background'; resolve: (hex: string | undefined) => void; reject: (error: unknown) => void }
const jobs: Job[] = []
// Whether the worker runs, and how to wake it when work is queued or a job
// ends.
let isWorking = false
let wake: (() => void) | undefined
// The worker of the latest session.start, the one that takes jobs: an earlier
// session's `$` (before /clear or /resume) may run no more commands, so its
// worker stops.
let generation = 0
// How many draws and previews run at once, each up to six merman runs: a
// resize queues box art for every diagram at every width it passes. A
// background read is never held back, as a render waits on it.
const MAX_RUNNING = 3
let running = 0

// Queues a render's work for the worker; before session.start (as in a test)
// there is none, and the render's own `$` does it once the render is out.
// Box art queued for a diagram at another width is dropped, not drawn: the
// room has changed since.
function queue($: EngineInterface, job: Job) {
  if (!isWorking) {
    $.clock.after(0, () => {
      void runJob($, job)
    })

    return
  }
  if (job.kind === 'draw' && !job.isPicture) {
    for (let k = jobs.length - 1; k >= 0; k--) {
      const old = jobs[k]
      if (old?.kind === 'draw' && !old.isPicture && old.source === job.source) {
        jobs.splice(k, 1)
        drawing.delete(old.key)
      }
    }
  }
  jobs.push(job)
  wake?.()
}

async function runJob($: EngineInterface, job: Job) {
  if (job.kind === 'preview') await previewFor($, job.source).catch(() => undefined)
  else if (job.kind === 'background') await readBackground($).then(job.resolve, job.reject)
  else await drawNow($, job.key, job.isPicture, job.source, job.width, job.shade)
}

// The worker: takes each job as it is queued, none waited on by the next, but
// no more than MAX_RUNNING draws and previews at once; till a newer session's
// worker (`generation`) takes over.
async function work($: EngineInterface, own: number) {
  isWorking = true
  while (own === generation) {
    const at = jobs.findIndex(one => one.kind === 'background' || running < MAX_RUNNING)
    const job = at < 0 ? undefined : jobs.splice(at, 1)[0]
    if (job !== undefined) {
      const isHeld = job.kind !== 'background'
      if (isHeld) running += 1
      void runJob($, job).finally(() => {
        if (isHeld) running -= 1
        wake?.()
      })
      continue
    }
    let woken: (() => void) | undefined
    await new Promise<void>(resolve => {
      woken = resolve
      wake = resolve
    })
    // A worker woken to stop leaves the newer one's wake in place.
    if (wake === woken) wake = undefined
  }
}

// Draws a diagram as a picture or box art, and stores it under `key` (its
// member of `figures`), which draws the message again.
async function drawNow(
  $: EngineInterface,
  key: string,
  isPicture: boolean,
  source: string,
  width: number,
  shade: Shade,
) {
  try {
    const result = await (isPicture ? renderPicture($, source, shade) : renderText($, source, width, shade.look))
    $.ui.log(
      `cc-crisply: ${isPicture ? 'picture' : 'box art'} ${key}: ${'failed' in result ? `failed: ${result.failed}` : 'drawn'}`,
      { to: 'debug' },
    )
    // A render cut short is not merman failing: left unstored, the next
    // drawing asks again, a few times.
    if ('failed' in result && result.isCutShort === true) {
      const tries = (cutShort.get(key) ?? 0) + 1
      if (tries < MAX_CUT_SHORT) {
        cutShort.set(key, tries)
        return
      }
    }
    cutShort.delete(key)
    const stored = 'failed' in result ? { failed: result.failed } : result
    await update($, memberOf(figures, { requestId: key }), () => stored)
  } finally {
    drawing.delete(key)
  }
}

// Facts about the host, each asked once, then kept: asked first by the
// worker, so a superseded render can't cut the asking short.
let knownImages: Promise<'always' | 'fullscreen' | undefined> | undefined
let ssh: Promise<boolean> | undefined
let merman: Promise<boolean> | undefined
let opener: Promise<string[]> | undefined

function knownImagesFor($: EngineInterface) {
  knownImages ??= knownImagesOf($)

  return knownImages
}

function isSsh($: EngineInterface) {
  ssh ??= sshOf($)

  return ssh
}

function hasMerman($: EngineInterface) {
  merman ??= mermanRuns($)

  return merman
}

function openerFor($: EngineInterface) {
  opener ??= openerOf($)

  return opener
}

// Writes the diagram's preview, a page of merman's SVG, and opens it in the
// browser, or says why not.
async function openPreview($: EngineInterface, source: string): Promise<string | undefined> {
  try {
    const preview = await previewFor($, source)
    const run = await $.process.run([...(await openerFor($)), preview])
    if (run.exitCode !== 0) return `Could not open the diagram: ${run.stderr.trim() || `exit ${run.exitCode}`}`

    return undefined
  } catch (error) {
    return `Could not open the diagram: ${error instanceof Error ? error.message : String(error)}`
  }
}

// Copies `text`, the block's own unless given, and marks the button that took
// it (`as`: a table's `csv`, a diagram's `svg`, or none for the block's own
// text) as copied for a moment.
async function copy($: EngineInterface, block: Copyable, as: '' | 'csv' | 'svg', surface?: 'terminal', text?: string) {
  const { isCopied } = await $.ui.copy({ text: text ?? block.text, surface })
  if (isCopied) {
    if (marked !== undefined && marked !== block.requestId) {
      await update($, memberOf(copied, { requestId: marked }), () => null)
    }
    marked = block.requestId
    const mark = `${block.n}${as === '' ? '' : `:${as}`}`
    const member = memberOf(copied, { requestId: block.requestId })
    await update($, member, () => mark)
    // Back to its label after a moment, unless another copy took the mark.
    $.clock.after(COPIED_FOR_MS, () => {
      void update($, member, value => (value === mark ? null : value))
    })
  }
}

export const register: Register = (on, options) => {
  // Pictures where the terminal is known to draw them and box art elsewhere
  // (`auto`), box art everywhere (`text`), or diagrams left as code (`code`).
  const display =
    options.diagramDisplay === 'text' || options.diagramDisplay === 'code' ? options.diagramDisplay : 'auto'
  // The diagrams' palette: the Claude Code theme's look (`auto`), or `dark`
  // or `light` whatever the theme.
  const theme = options.diagramTheme === 'dark' || options.diagramTheme === 'light' ? options.diagramTheme : 'auto'
  // Whether the person's prompts are drawn in a border.
  const hasPromptBorder = options.promptBorder !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The worker for the session's life, on this hook's `$`, taking over
    // from the last session's, which is woken to stop; the host facts asked
    // on it first.
    generation += 1
    wake?.()
    void hasMerman($)
    void isSsh($)
    void knownImagesFor($)
    void work($, generation)

    return started
  })

  // The person's own prompt, boxed in the primary color on its own
  // background, the border on it too, so the box is drawn row by row: the
  // dim pointer in the left border's place on the first row, so the text
  // keeps the column Claude Code gives it, and each line wrapped inside, its
  // spaces as typed, all of it, as Claude Code draws it. Not a task's
  // notification nor another agent's message. The `promptBorder` setting off, or a window too narrow for the
  // box, Claude Code draws it.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, ($, e, next) => {
    const width = e.viewport?.columns ?? 80
    if (e.surface !== 'terminal' || !hasPromptBorder || width < PROMPT_MIN_WIDTH) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The pointer or border and a space before the text, a space and the
    // border after it.
    const inner = width - 4
    const lines = clean(e.props.text)
      .split('\n')
      .flatMap(line => softWrap(line.replace(/\t/g, '    '), inner))
    const edge = (text: string) => (
      <Text color={PROMPT_COLOR} backgroundColor={PROMPT_BACKGROUND}>
        {text}
      </Text>
    )
    const rule = '─'.repeat(width - 2)

    return (
      <Box flexDirection="column" marginTop={1}>
        {edge(`╭${rule}╮`)}
        {lines.map((line, k) => (
          <Box flexDirection="row">
            {k === 0 ? (
              <Text color="inactive" backgroundColor={PROMPT_BACKGROUND}>
                {PROMPT_POINTER}
              </Text>
            ) : (
              edge('│')
            )}
            <Text color="text" backgroundColor={PROMPT_BACKGROUND}>
              {` ${pad(line, inner, 'left')} `}
            </Text>
            {edge('│')}
          </Box>
        ))}
        {edge(`╰${rule}╯`)}
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const { Box, Text, Button, Markdown, Link, Image } = $.ui.resolve(e)

    const segments = splitMarkdown(e.props.text)
    const numbered = numberBlocks(e.requestId, segments)
    if (numbered.size === 0 && splitProse(e.props.text).every(b => b.kind === 'engine')) {
      const text = showCodeTicks(e.props.text)

      return next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
    }

    const lastCopied = await read($, memberOf(copied, e))
    // A block sits beside the two-cell gutter Claude Code gives a reply.
    const room = Math.max(20, (e.viewport?.columns ?? 80) - 2)
    const isFullscreen = e.viewport?.isFullscreen === true

    // Each closed Mermaid fence as merman drew it, read before drawing so the
    // drawing waits on nothing: a picture for a terminal that shows them, box
    // art for one that doesn't (knownImagesOf, and the setting), none when
    // the setting is `code`. One not drawn
    // yet is drawn after this render, on a timer, and shown as code till it is
    // stored, which draws the message again; one merman failed on stays code,
    // with why under its header, as all do without merman-cli.
    const figured = new Map<CodeBlock, Pictures | Drawing>()
    const failures = new Map<CodeBlock, string>()
    // Where each closed fence's preview is, for its preview button: none
    // without merman-cli to draw it, with diagrams left as code, or over SSH.
    const previews = new Map<CodeBlock, string>()
    const closed: [CodeBlock, number][] = []
    const collect = (list: Segment[], space: number) => {
      for (const seg of list) {
        if (seg.kind === 'quote') collect(seg.parts, space - 2)
        if (seg.kind === 'code' && seg.language === 'mermaid' && !seg.isOpen) closed.push([seg, space])
      }
    }
    collect(segments, room)
    // Whether merman-cli is here to draw a diagram's SVG for its svg button.
    let canDrawSvg = false
    if (closed.length > 0) {
      look = await lookFor($, theme)
      const isMerman = await hasMerman($)
      canDrawSvg = isMerman
      const known = await knownImagesFor($)
      const isPicture = display === 'auto' && (known === 'always' || (known === 'fullscreen' && isFullscreen))
      const isRemote = await isSsh($)
      const folder = await folderOf($)
      // A picture sits on the terminal's own background where it can; box
      // art has none of its own, and no diagram drawn needs none read.
      const shade: Shade = isPicture && isMerman ? { look, canvas: await canvasFor($, look) } : { look }
      for (const [seg, space] of closed) {
        const source = clean(seg.source)
        if (!isMerman || display === 'code') continue
        if (!isRemote) {
          previews.set(seg, previewPathOf(folder, source, look))
          // On the main screen the preview is a link the terminal opens
          // itself, so its file is written ahead of a click.
          if (!isFullscreen) queue($, { kind: 'preview', source })
        }
        // A picture is drawn once at its own size, and fitted to the room as
        // it is shown; box art is drawn to the room.
        const key = isPicture ? `${hashOf(source)}:${shadeName(shade)}:pic` : `${hashOf(source)}:${space - 4}:art`
        const value = await read($, memberOf(figures, { requestId: key }))
        if (value !== null) {
          if ('failed' in value) failures.set(seg, value.failed)
          else figured.set(seg, value)
        }
        if (value !== null || drawing.has(key)) continue
        drawing.add(key)
        queue($, { kind: 'draw', key, isPicture, source, width: space - 4, shade })
      }
      // Once ever, with a diagram to show it by, how to see it drawn.
      if (!isMerman && display !== 'code' && !isHintChecked) {
        isHintChecked = true
        if ((await $.store.get('mermanHint')) === undefined) {
          await $.store.set('mermanHint', true)
          $.ui.toast(INSTALL_HINT)
        }
      }
    }

    // `name` is what the button copies: `copy` for a code block, `md` and
    // `csv` for a table, `mermaid` for a diagram's source and `svg` for its
    // picture as merman's SVG, drawn when pressed.
    const copyButton = (block: Copyable, name: 'copy' | 'md' | 'csv' | 'mermaid' | 'svg') => {
      const as = name === 'csv' || name === 'svg' ? name : ''
      const isDone = lastCopied === `${block.n}${as === '' ? '' : `:${as}`}`
      const label = isDone ? `${DONE_ICON} copied` : `${COPY_ICON} ${name}`
      const press = async (surface?: 'terminal') => {
        if (name === 'csv' && block.table !== undefined) return copy($, block, as, surface, tableAsCsv(block.table))
        if (name !== 'svg') return copy($, block, as, surface)
        const svg = await svgOf($, clean(block.text), look)
        if (typeof svg === 'string') return copy($, block, as, surface, svg)
        $.ui.toast(`Could not draw the SVG: ${svg.failed}`)
      }

      return (
        // Plain, so it draws its own `[ … ]` in the button color.
        <Button
          key={`copy-${block.n}${as === '' ? '' : `-${as}`}`}
          label={label}
          plain
          onPress={pressed => {
            void press(pressed.surface === 'terminal' ? 'terminal' : undefined)
          }}
        >
          <Text color={BUTTON_COLOR} bold>{`[ ${label} ]`}</Text>
        </Button>
      )
    }

    // A table's buttons, over its right edge.
    const tableButtons = (block: Copyable, width: number) => (
      <Box justifyContent="flex-end" gap={1} width={width}>
        {copyButton(block, 'csv')}
        {copyButton(block, 'md')}
      </Box>
    )

    // A block as drawn, and how many rows it takes: what a quote's bar is as
    // tall as.
    type Drawn = [RenderChildren, number]

    // A diagram's preview. In the fullscreen layout, where a click reaches
    // it, a button beside the copy button that writes its page and opens it.
    // On the main screen, where a click reaches no button, a link to the page
    // that Claude Code draws as a reply's, for the terminal to open. None
    // where `previews` has none.
    const previewButton = (seg: CodeBlock, block: Copyable, label: string) => {
      const preview = previews.get(seg)
      if (preview === undefined) return null
      const source = clean(seg.source)
      const open = () => {
        void openPreview($, source).then(failed => failed !== undefined && $.ui.toast(failed))
      }
      if (isFullscreen) {
        return (
          <Button key={`preview-${block.n}`} label={label} plain onPress={open}>
            <Text color={BUTTON_COLOR} bold>{`[ ${label} ]`}</Text>
          </Button>
        )
      }
      const href = fileUrl(preview)

      return (
        <Markdown
          key={`preview-${block.n}`}
          text={`[\\[ ${label} \\]](${href})`}
          pressableLinks={[href]}
          onLinkPress={open}
        />
      )
    }

    // The frame opens on a header, the language at its left and the buttons
    // at its right, ruled off from the body by a line from border to border
    // (the borders draw over anything placed on them, so no `├`). Each block
    // is drawn `space` cells wide: the room, less a quote's bars.
    const frame = (
      name: string,
      buttons: RenderChildren,
      body: RenderChildren,
      bodyRows: number,
      space: number,
      isOpen = false,
    ): Drawn => [
      <Box flexDirection="column" width={space}>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" width={space}>
          <Box justifyContent="space-between" paddingX={1}>
            <Text dimColor>{name}</Text>
            <Box gap={1}>{buttons}</Box>
          </Box>
          <Text color="subtle">{'─'.repeat(Math.max(0, space - 2))}</Text>
          <Box paddingX={1}>{body}</Box>
        </Box>
        {isOpen && <Text dimColor>…</Text>}
      </Box>,
      bodyRows + 4 + (isOpen ? 1 : 0),
    ]

    // Code, diffs included, is drawn by Claude Code's markdown, in the colors
    // it gives a fence when the plugin is off. In a quote it comes wrapped
    // to the frame, so its rows are known. Its header is `name` and its
    // buttons, the copy button unless given others; a `note`, dim and
    // wrapped, comes before the code.
    const drawCode = (
      seg: CodeBlock,
      block: Copyable,
      space: number,
      isQuoted = false,
      name?: string,
      buttons: RenderChildren = copyButton(block, 'copy'),
      note?: string,
    ): Drawn => {
      const language = codeLanguage(seg)
      const inner = Math.max(1, space - 4)
      const source = clean(seg.source)
      const code = isQuoted
        ? source
            .split('\n')
            .flatMap(line => hardWrap(line.replace(/\t/g, '    '), inner))
            .join('\n')
        : source
      const rows = code.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidth(line) / inner)), 0)
      const noted = note === undefined ? [] : wrap(note, inner)

      return frame(
        name ?? (seg.language || language || 'text'),
        buttons,
        <Box flexDirection="column">
          {noted.map(line => (
            <Text dimColor>{line}</Text>
          ))}
          <Markdown text={fenceOf(code, language)} />
        </Box>,
        noted.length + rows,
        space,
        seg.isOpen,
      )
    }

    // A Mermaid diagram: its merman picture or box art once drawn, inside the
    // frame's borders and padding, four cells narrower than the space; till
    // then, and where there is neither, its source as code. Its kind is named, but a
    // flowchart's. The preview button comes once its fence has closed.
    const drawFigure = (seg: CodeBlock, block: Copyable, space: number, isQuoted = false): Drawn => {
      const source = clean(seg.source)
      const kind = kindOf(source)
      // The header as it fits on one row of the frame, so a narrow terminal
      // does not wrap it and break the frame: the kind dropped first, then the
      // preview button's word. The copy button is measured at its widest; a
      // diagram with no preview leaves no room for one.
      const widthOf = (button: string) =>
        Math.max(textWidth(`[ ${COPY_ICON} ${button} ]`), textWidth(`[ ${DONE_ICON} copied ]`))
      const copyWidth = widthOf('mermaid') + (canDrawSvg ? 1 + widthOf('svg') : 0)
      const canPreview = previews.has(seg)
      const fits = (title: string, label: string) =>
        textWidth(title) + 1 + (canPreview ? textWidth(`[ ${label} ]`) + 1 : 0) + copyWidth <= space - 4
      let name = kind === undefined ? seg.language : `${seg.language} · ${kind}`
      let label = `${PREVIEW_ICON} preview`
      if (!fits(name, label)) name = seg.language
      if (!fits(name, label)) label = PREVIEW_ICON
      const buttons = [
        previewButton(seg, block, label),
        canDrawSvg && copyButton(block, 'svg'),
        copyButton(block, 'mermaid'),
      ]
      const figure = figured.get(seg)
      // A line in the debug log when what the diagram is drawn as changes,
      // with where its message is: on screen (its rows shown), or not.
      const drawnAsNow = (what: string) => {
        const at = `${e.requestId}#${block.n}`
        const where = e.props.onScreen === null ? 'off screen' : e.props.onScreen === undefined ? '' : 'on screen'
        if (drawnAs.get(at) === what) return
        drawnAs.set(at, what)
        $.ui.log(`cc-crisply: diagram ${at} drawn as ${what}${where === '' ? '' : `, ${where}`}`, { to: 'debug' })
      }
      if (figure !== undefined && 'text' in figure) {
        const lines = clean(figure.text).split('\n')
        drawnAsNow('box art')

        return frame(
          name,
          buttons,
          <Box flexDirection="column">
            {lines.map(line => (
              <Text>{line === '' ? ' ' : line}</Text>
            ))}
          </Box>,
          lines.length,
          space,
        )
      }
      // Of the pictures, as written and turned, the one drawn larger here,
      // sideways while that is about as large: within the frame, and within
      // the window itself, narrower than the frame in a very narrow one. One
      // too small to read there is shown as its code, which wraps.
      const windowRoom = (e.viewport?.columns ?? 80) - 6
      const shown =
        figure === undefined
          ? undefined
          : pictureFor(figure.pictures, Math.min(space - 4, windowRoom), e.viewport?.rows)
      if (shown !== undefined && shown.columns >= MIN_PICTURE.columns && shown.rows >= MIN_PICTURE.rows) {
        const { picture, columns, rows } = shown
        drawnAsNow(`picture figure-${block.n}-${columns}x${rows}`)

        // Keyed by its size too: drawn again at another size with the same
        // PNG, the engine sends the terminal nothing, which keeps the picture
        // at its old size and clips it to the new box. A new key draws it anew.
        return frame(
          name,
          buttons,
          <Image
            key={`figure-${block.n}-${columns}x${rows}`}
            source={{ png: picture.png }}
            columns={columns}
            rows={rows}
            alt={`${kind ?? 'flowchart'} diagram`}
          />,
          rows,
          space,
        )
      }

      const failure = failures.get(seg)
      drawnAsNow(
        seg.isOpen
          ? 'code (still streaming)'
          : shown !== undefined
            ? `code (picture ${shown.columns}x${shown.rows} too small)`
            : figure !== undefined
              ? 'code'
              : failure !== undefined
                ? 'code (merman failed)'
                : display === 'code'
                  ? 'code (set to code)'
                  : 'code (waiting for merman)',
      )

      return drawCode(
        seg,
        block,
        space,
        isQuoted,
        name,
        buttons,
        failure === undefined ? undefined : noteOf(failure, canPreview),
      )
    }

    const drawTable = (table: Table, block: Copyable, space: number): Drawn => {
      // Its cells as drawn: tab and newline the only control characters.
      const seg = { ...table, header: table.header.map(clean), rows: table.rows.map(row => row.map(clean)) }
      const layout = layoutTable(seg, space)

      if (layout === undefined) {
        // Too narrow for columns: one card per row, `Header: value` lines,
        // each wrapped inside the card's border and padding.
        const lineRows = (row: string[]) =>
          row.reduce(
            (sum, cell, k) => sum + wrap(`${plainInline(seg.header[k] ?? '')}: ${plainInline(cell)}`, space - 4).length,
            0,
          )

        return [
          <Box flexDirection="column" width={space}>
            {tableButtons(block, space)}
            {seg.rows.map(row => (
              <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
                {row.map((cell, k) => (
                  <Text>
                    <Text bold>{plainInline(seg.header[k] ?? '')}: </Text>
                    {plainInline(cell)}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>,
          1 + seg.rows.reduce((sum, row) => sum + 2 + lineRows(row), 0),
        ]
      }

      const { align } = layout
      // A table narrower than its buttons widens its last column, so the
      // buttons always end on its right edge (sized for `✓ copied`, so a press
      // does not move it).
      const widths = [...layout.widths]
      const short = Math.min(space, BUTTONS_WIDTH) - (frameWidth(widths.length) + widths.reduce((a, b) => a + b, 0))
      if (short > 0) widths[widths.length - 1] = (widths[widths.length - 1] ?? 0) + short
      const width = frameWidth(widths.length) + widths.reduce((a, b) => a + b, 0)
      const rule = (l: string, m: string, r: string) => (
        <Text color="subtle">{l + widths.map(w => '─'.repeat(w + 2)).join(m) + r}</Text>
      )
      const heightOf = (cells: string[][]) => Math.max(...cells.map(c => c.length), 1)
      const drawRow = (cells: string[][], isHead: boolean) =>
        Array.from({ length: heightOf(cells) }, (_, line) => (
          <Text>
            {widths.map((w, k) => (
              <Text>
                <Text color="subtle">{k === 0 ? '│ ' : ' │ '}</Text>
                <Text bold={isHead}>{pad(cells[k]?.[line] ?? '', w, isHead ? 'left' : (align[k] ?? 'left'))}</Text>
              </Text>
            ))}
            <Text color="subtle"> │</Text>
          </Text>
        ))

      return [
        <Box flexDirection="column" width={width}>
          {tableButtons(block, width)}
          {rule('╭', '┬', '╮')}
          {drawRow(layout.header, true)}
          {rule('├', '┼', '┤')}
          {layout.rows.flatMap(row => drawRow(row, false))}
          {rule('╰', '┴', '╯')}
        </Box>,
        4 + heightOf(layout.header) + layout.rows.reduce((sum, row) => sum + heightOf(row), 0),
      ]
    }

    // Inline markdown as Claude Code draws it, but for the color of headings,
    // and strikethrough, which Claude Code leaves as written. Each block is
    // laid out line by line here, every line a row of Texts side by side.
    // `isMuted` draws every part dim and drops its own color, for a ticked
    // task's row: a color set on an inner part would outshine the row's dim.
    const runs = (parts: Inline[], base: Style, isMuted: boolean): Run<Style>[] =>
      parts.flatMap((p): Run<Style>[] => {
        if (typeof p === 'string') return [{ text: p, style: base }]
        const color = (c: string | undefined) => (isMuted ? undefined : c)
        const dimColor = isMuted || base.dimColor
        // Code keeps its backticks, all in the code color.
        if (p.kind === 'code')
          return [{ text: `\`${p.text}\``, style: { ...base, color: color(CODE_COLOR), dimColor } }]
        if (p.kind === 'link') {
          // No underline of ours: the terminal dashes an OSC 8 link's underline
          // itself, and makes it solid under the pointer, as on Claude Code's
          // own links.
          const style = { ...base, color: color(LINK_COLOR), dimColor, href: p.href }

          return [{ text: plainText(p.children), style }]
        }
        if (p.kind === 'strong') {
          // Bold keeps the color around it, a heading's included.
          return runs(p.children, { ...base, bold: true, dimColor }, isMuted)
        }
        if (p.kind === 'em') return runs(p.children, { ...base, italic: true, dimColor }, isMuted)
        // Struck text is dim and keeps its `~~` marks, themselves not struck.
        const marks = { ...base, dimColor: true }

        return [
          { text: '~~', style: marks },
          ...runs(p.children, { ...base, dimColor: true, strikethrough: true }, isMuted),
          { text: '~~', style: marks },
        ]
      })

    // How many rows markdown text takes, wrapped to `width` cells.
    const rowsOf = (text: string, width: number) => wrapRuns(runs(parseInline(clean(text)), {}, false), width).length

    // Markdown text in `base`'s style, wrapped to `width` cells.
    const lines = (text: string, base: Style, width: number, isMuted = false) => (
      <Box flexDirection="column">
        {wrapRuns(runs(parseInline(clean(text)), base, isMuted), width).map(line => (
          <Box flexDirection="row">{line.length === 0 ? <Text> </Text> : line.map(drawRun)}</Box>
        ))}
      </Box>
    )
    const drawRun = ({ text, style }: Run<Style>) => {
      const { href, ...props } = style
      if (href === undefined) return <Text {...props}>{text}</Text>

      return (
        <Text {...props}>
          <Link href={href} label={text} />
        </Text>
      )
    }

    // A paragraph, heading, list, quote or rule, laid out as Claude Code lays
    // it: `-` and `1.` markers two cells deeper a level, a dim `▎` before an
    // italic quote, a level-one heading also italic. Headings are drawn in
    // Claude's orange; a rule spans the width in the frame's rule color. In
    // `base`'s style, as a quote's italic.
    const drawProse = (block: Exclude<ProseBlock, { kind: 'engine' }>, width = room, base: Style = {}) => {
      if (block.kind === 'paragraph') return lines(block.text, base, width)
      if (block.kind === 'rule') return <Text color="subtle">{'─'.repeat(width)}</Text>
      if (block.kind === 'heading') {
        const isTop = block.level === 1

        return lines(block.text, { ...base, bold: true, color: HEADING_COLOR, italic: isTop || base.italic }, width)
      }
      if (block.kind === 'quote') {
        return (
          <Box flexDirection="row">
            <Text dimColor>
              {Array(rowsOf(block.text, width - 2))
                .fill('▎ ')
                .join('\n')}
            </Text>
            {lines(block.text, { ...base, italic: true }, width - 2)}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {block.items.map(item => {
            const marker =
              item.task === undefined ? `${item.marker} ` : `${item.marker} [${item.task === 'done' ? 'x' : ' '}] `
            const space = width - item.depth * 2 - textWidth(marker)
            const isDone = item.task === 'done'

            return (
              <Box flexDirection="row" marginLeft={item.depth * 2}>
                <Text color={item.task === undefined ? undefined : TASK_COLOR}>{marker}</Text>
                {lines(item.text, isDone ? { ...base, dimColor: true, strikethrough: true } : base, space, isDone)}
              </Box>
            )
          })}
        </Box>
      )
    }

    // How many rows a block drawProse draws takes.
    const proseRows = (block: Exclude<ProseBlock, { kind: 'engine' }>, width: number): number => {
      if (block.kind === 'rule') return 1
      if (block.kind === 'quote') return rowsOf(block.text, width - 2)
      if (block.kind !== 'list') return rowsOf(block.text, width)

      return block.items.reduce((sum, item) => {
        const marker = item.task === undefined ? `${item.marker} ` : `${item.marker} [ ] `

        return sum + rowsOf(item.text, width - item.depth * 2 - textWidth(marker))
      }, 0)
    }

    // Prose goes back to Claude Code, which draws it as any reply: markdown
    // untouched, and on the reply's first part its own bullet and gutter. A
    // heading, or a block holding strikethrough or a task box, the plugin
    // draws itself. Every other part sits in a gutter of ours, its bullet
    // drawn as Claude Code draws it when the part opens the reply. The engine refuses its own drawing under a
    // Box given a width, so the row around it has none.
    const gutter = (isFirst: boolean, body: RenderChildren, marginTop?: number) => (
      <Box flexDirection="row" marginTop={marginTop}>
        <Box minWidth={2} flexShrink={0}>
          <Text color="text">{isFirst ? '⏺' : ' '}</Text>
        </Box>
        {body}
      </Box>
    )
    // A code block, table or quote, `width` cells wide.
    const drawBlock = (seg: Exclude<Segment, { kind: 'prose' }>, width: number, isQuoted = false): Drawn => {
      if (seg.kind === 'quote') return drawQuote(seg, width)
      const block = numbered.get(seg) as Copyable
      if (seg.kind === 'table') return drawTable(seg, block, width)

      return seg.language === 'mermaid'
        ? drawFigure(seg, block, width, isQuoted)
        : drawCode(seg, block, width, isQuoted)
    }
    // A quote that holds code or a table, drawn whole behind a dim `▎` bar as
    // tall as it, as Claude Code draws a quote's: its prose italic, its blocks
    // framed as any, a blank row between its parts. The bar is a column of as
    // many `▎` as the parts take rows, so nothing has to cut it.
    const drawQuote = (seg: Quote, width: number): Drawn => {
      const inner = width - 2
      const children: Drawn[] = []
      for (const part of seg.parts) {
        if (part.kind !== 'prose') {
          children.push(drawBlock(part, inner, true))
          continue
        }
        for (const block of splitProse(part.text, true)) {
          if (block.kind !== 'engine')
            children.push([drawProse(block, inner, { italic: true }), proseRows(block, inner)])
        }
      }
      const height = children.reduce((sum, [, rows]) => sum + rows, 0) + Math.max(0, children.length - 1)

      return [
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{Array(height).fill('▎').join('\n')}</Text>
          </Box>
          <Box flexDirection="column" gap={1}>
            {children.map(([node]) => node)}
          </Box>
        </Box>,
        height,
      ]
    }
    // Claude Code draws each run of its prose at once, none waiting on the
    // last; the parts keep their order.
    const parts: (RenderChildren | Promise<RenderChildren>)[] = []
    for (const seg of segments) {
      if (seg.kind === 'prose') {
        for (const block of splitProse(seg.text)) {
          const isFirst = e.props.isFirstOfReply && parts.length === 0
          if (block.kind !== 'engine') {
            parts.push(gutter(isFirst, <Box width={room}>{drawProse(block)}</Box>, 1))
            continue
          }
          const text = showCodeTicks(block.text)
          const prose = next({ ...e, props: { ...e.props, text, isFirstOfReply: isFirst } })
          parts.push(isFirst ? prose : prose.then(drawn => gutter(false, drawn)))
        }
        continue
      }
      // Claude Code's drawing brings a blank line above it; a block takes the
      // same, so the parts keep the reply's spacing.
      const isFirst = e.props.isFirstOfReply && parts.length === 0
      parts.push(gutter(isFirst, drawBlock(seg, room)[0], 1))
    }

    return <Box flexDirection="column">{await Promise.all(parts)}</Box>
  })
}

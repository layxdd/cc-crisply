// Draws Mermaid diagrams with merman-cli: a PNG for a terminal that shows
// pictures, Unicode box art for one that doesn't (or the plugin's own, for a
// kind merman draws none for), and for the browser an HTML page of merman's
// SVG.

import type { EngineInterface } from 'claude-code'
import { textWidth, wrap } from './layout'
import { artOf, linesOf } from './textart'

// How long merman may take over one diagram.
const TIMEOUT_MS = 5000
// The PNG is drawn at twice its CSS size, so it stays sharp on a Retina
// screen.
const SCALE = 2
// How many of a picture's CSS pixels go in a terminal column, a row being
// twice that: its 16 px text drawn a little smaller than the terminal's.
const PX_PER_COLUMN = 10
// The rows a picture takes at most: three quarters of the terminal's
// height, between MIN_ROWS and MAX_ROWS, so a tall diagram is drawn tall
// enough to read; but never more than the window holds beside the frame, the
// prompt and the status line (RESERVED_ROWS), for a picture running past the
// window's edge may not be drawn at all. A taller one is narrowed to keep its
// shape.
const MIN_ROWS = 12
const MAX_ROWS = 48
const SCREEN_SHARE = 0.75
const RESERVED_ROWS = 8
// The smallest picture worth showing; one smaller is shown as its code.
export const MIN_PICTURE = { columns: 12, rows: 3 }
// How much smaller a diagram turned sideways may come out than drawn top-down
// and still be the one shown: the terminal is wider than it is tall.
const ACROSS_SHARE = 0.9

// A font merman both lays text out in and draws it with, so no label
// overflows its box: the first of these a system has, by its family name.
const FONTS = [
  { file: '/System/Library/Fonts/Supplemental/Arial.ttf', family: 'Arial' },
  { file: '/Library/Fonts/Arial.ttf', family: 'Arial' },
  { file: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', family: 'DejaVu Sans' },
  { file: '/usr/share/fonts/dejavu/DejaVuSans.ttf', family: 'DejaVu Sans' },
  { file: '/usr/share/fonts/TTF/DejaVuSans.ttf', family: 'DejaVu Sans' },
  { file: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', family: 'Liberation Sans' },
  { file: 'C:\\Windows\\Fonts\\arial.ttf', family: 'Arial' },
]
type Font = (typeof FONTS)[number]

// What merman's text form takes, in turn, while the last was too wide: its
// own layout, then tighter gaps, then its compact layout (flowcharts only).
const TIGHT = ['--ascii-graph-padding-x', '2', '--ascii-graph-padding-y', '1']
const TEXT_TRIES = [[], TIGHT, [...TIGHT, '--ascii-layout-profile', 'auto']]
// How long all of a diagram's box art tries may take together: no further
// try starts after it.
const TEXT_BUDGET_MS = 2 * TIMEOUT_MS
// What an Image's `png` holds at most: 2 MiB of bytes, as base64.
const MAX_PNG_LENGTH = Math.floor((2 * 1024 * 1024 * 4) / 3)

// Whether the person's Claude Code theme is dark or light, for the
// diagram's colors.
export type Look = 'dark' | 'light'
// The look a picture is drawn in, and the terminal's own background
// (`#1a1b26`) to draw it on where that is known and of the same look; the
// palette's `canvas` where not.
export type Shade = { look: Look; canvas?: string }

// A shade as it names files and state: `dark`, or `dark-1a1b26`.
export const shadeName = ({ look, canvas }: Shade) => (canvas === undefined ? look : `${look}-${canvas.slice(1)}`)

// A picture ready to draw: its PNG and its size in pixels. A diagram that
// can turn has two, as written and turned (turnedOf), the one shown picked as
// it is drawn (pictureFor). Or the diagram as lines of text. Or why there is
// neither, the diagram drawn as code instead.
export type Picture = { png: string; width: number; height: number }
export type Pictures = { pictures: Picture[] }
export type Drawing = { text: string }
// A failure is merman's own unless `isCutShort`: the render threw, cut short
// (the engine aborting a superseded render's command, a call that dropped),
// and is worth asking again.
export type Rendered = Pictures | Drawing | { failed: string; isCutShort?: true }

// A short name for a source, for its files and its state.
export function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k)
    h = Math.imul(h, 0x01000193)
  }

  return (h >>> 0).toString(16).padStart(8, '0')
}

// The diagram's kind from its first keyword, for its frame's header:
// `sequenceDiagram` is `sequence`, `xychart-beta` is `xychart`. A flowchart
// is left unnamed, as the commonest.
export function kindOf(source: string): string | undefined {
  const word =
    linesOf(source)[0]
      ?.trim()
      .split(/[\s:{;]/)[0] ?? ''
  if (word === '' || word === 'graph' || word === 'flowchart') return undefined

  return (
    word
      .replace(/-(beta|v\d)$/, '')
      .replace(/Diagram$/, '')
      .toLowerCase() || undefined
  )
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The first bytes base64 holds, decoded by hand: the module has no `atob`.
function bytesOf(base64: string, count: number): number[] {
  const bytes: number[] = []
  for (let k = 0; k + 3 < base64.length && bytes.length < count; k += 4) {
    const n = [0, 1, 2, 3].map(j => BASE64.indexOf(base64[k + j] ?? 'A'))
    const v =
      ((n[0] ?? 0) << 18) | ((n[1] ?? 0) << 12) | ((Math.max(0, n[2] ?? 0) & 63) << 6) | (Math.max(0, n[3] ?? 0) & 63)
    bytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255)
  }

  return bytes.slice(0, count)
}

// A PNG's width and height in pixels, from its header.
export function sizeOf(base64: string): [number, number] | undefined {
  const b = bytesOf(base64, 24)
  if (b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return undefined
  const word = (at: number) =>
    (((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)) >>> 0

  return [word(16), word(20)]
}

// The cells a picture takes: a column for PX_PER_COLUMN of its CSS pixels,
// at most `room` columns, and rows to keep its shape, a cell being twice as
// tall as it is wide. One taller than its share of the terminal's
// `screenRows` (MAX_ROWS) is narrowed to fit them.
export function cellsOf(
  { width, height }: { width: number; height: number },
  room: number,
  screenRows = 40,
): { columns: number; rows: number } {
  const ratio = height / width / 2
  const share = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(screenRows * SCREEN_SHARE)))
  const maxRows = Math.max(1, Math.min(share, screenRows - RESERVED_ROWS))
  let columns = Math.max(1, Math.min(room, 255, Math.round(width / SCALE / PX_PER_COLUMN)))
  let rows = Math.max(1, Math.round(columns * ratio))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.round(rows / ratio))
  }

  return { columns, rows }
}

// Of a diagram's pictures, the one to show in `room` columns of a terminal
// `screenRows` tall, and the cells it takes: the one drawn larger, but the
// one wider than it is tall while it comes out at least ACROSS_SHARE as large.
export function pictureFor(
  pictures: Picture[],
  room: number,
  screenRows?: number,
): { picture: Picture; columns: number; rows: number } | undefined {
  const sized = pictures.map(picture => {
    const cells = cellsOf(picture, room, screenRows)

    return { picture, ...cells, scale: cells.columns / picture.width }
  })
  const largest = sized.reduce<(typeof sized)[number] | undefined>(
    (best, one) => (best === undefined || one.scale > best.scale ? one : best),
    undefined,
  )
  const across = sized
    .filter(one => one.picture.width > one.picture.height)
    .find(one => largest !== undefined && one.scale >= largest.scale * ACROSS_SHARE)
  const shown = across ?? largest

  return shown === undefined ? undefined : { picture: shown.picture, columns: shown.columns, rows: shown.rows }
}

const DIRECTION = /^\s*direction\s+(TB|TD|BT|LR|RL)\s*$/

// The diagram turned the other way, or undefined for a kind that can't turn:
// a flowchart's direction swapped between top-down and left-right, and a
// state, class or ER diagram given `direction LR`. One that names its own
// direction keeps it, as a nested state's may be the one named.
export function turnedOf(source: string): string | undefined {
  const lines = source.split('\n')
  let at = 0
  if (/^\s*---\s*$/.test(lines[0] ?? '')) {
    at = lines.findIndex((line, k) => k > 0 && /^\s*---\s*$/.test(line)) + 1
    if (at === 0) return undefined
  }
  while (at < lines.length && ((lines[at] ?? '').trim() === '' || (lines[at] ?? '').trim().startsWith('%%'))) at++
  const header = lines[at] ?? ''
  const flow = /^(\s*(?:flowchart-elk|flowchart|graph))(?![\w-])(?:[ \t]+(TD|TB|BT|LR|RL))?(.*)$/.exec(header)
  if (flow !== null) {
    const isAcross = flow[2] === 'LR' || flow[2] === 'RL'
    lines[at] = `${flow[1]} ${isAcross ? 'TD' : 'LR'}${flow[3] ?? ''}`

    return lines.join('\n')
  }
  if (!/^\s*(stateDiagram|classDiagram|erDiagram)/.test(header)) return undefined
  if (lines.some(line => DIRECTION.test(line))) return undefined
  lines.splice(at + 1, 0, '    direction LR')

  return lines.join('\n')
}

// The folder the pictures, pages and theme files go in: the person's own,
// never one others can write to, for the files' names are known and a write
// follows a link planted there. TMPDIR where it is set (macOS gives each
// person one); else their cache folder, as Linux usually leaves it unset and
// /tmp is everyone's. /tmp only with no home to go to.
export async function folderOf($: EngineInterface): Promise<string> {
  const temp = await $.env.get('TMPDIR')
  if (temp !== undefined && temp !== '') return `${temp.replace(/\/+$/, '')}/cc-crisply`
  const cache = await $.env.get('XDG_CACHE_HOME')
  if (cache?.startsWith('/')) return `${cache.replace(/\/+$/, '')}/cc-crisply`
  const home = await $.env.get('HOME')
  if (home?.startsWith('/')) return `${home.replace(/\/+$/, '')}/.cache/cc-crisply`

  return '/tmp/cc-crisply'
}

// The first font of FONTS this system has, looked for once.
let font: Promise<Font | undefined> | undefined
async function findFont($: EngineInterface): Promise<Font | undefined> {
  for (const candidate of FONTS) {
    if (await $.fs.exists(candidate.file).catch(() => false)) return candidate
  }

  return undefined
}
function fontFor($: EngineInterface) {
  font ??= findFont($)

  return font
}

// The diagrams' colors, in Claude Code's: Claude's orange first, then blue,
// green, gold, purple, teal, red and pink, for each kind's series (a pie's
// slices, a git graph's branches, a mindmap's sections, a chart's bars).
// Nodes are warm and quiet, bordered in orange; lines and labels muted. The
// picture is drawn on `canvas`, near the terminal's own background.
const PALETTES = {
  dark: {
    series: ['#d97757', '#6a9bcc', '#8fb573', '#d4a85a', '#a58bc4', '#5fb3a8', '#c96a6a', '#c98ba8'],
    ink: '#1a1714',
    canvas: '#1f1d1b',
    text: '#ece6df',
    muted: '#a39c94',
    line: '#8f8982',
    fill: '#2b2622',
    fill2: '#24211e',
    fill3: '#332d28',
    edge: '#5a534d',
  },
  light: {
    // Dark enough for white labels on them to read (4.5:1 and over).
    series: ['#bc5736', '#4a77a3', '#577e3f', '#956d25', '#8666ad', '#387f76', '#b04f4f', '#a85b80'],
    ink: '#ffffff',
    canvas: '#fdfbf9',
    text: '#2b2622',
    muted: '#6b645d',
    line: '#8a837c',
    fill: '#fbf3ee',
    fill2: '#f6f1ec',
    fill3: '#f1e7df',
    edge: '#d6cec6',
  },
}

// Mermaid's theme variables for the shade, over its `base` theme, the one
// that takes them all.
function themeVariablesOf({ look, canvas = PALETTES[look].canvas }: Shade): Record<string, unknown> {
  const { series, ink, text, muted, line, fill, fill2, fill3, edge } = PALETTES[look]
  const [accent = '', blue = '', green = '', gold = '', , , red = ''] = series
  const variables: Record<string, unknown> = {
    background: canvas,
    fontSize: '15px',
    primaryColor: fill,
    primaryBorderColor: accent,
    primaryTextColor: text,
    secondaryColor: fill2,
    secondaryBorderColor: blue,
    secondaryTextColor: text,
    tertiaryColor: fill3,
    tertiaryBorderColor: green,
    tertiaryTextColor: text,
    mainBkg: fill,
    nodeBorder: accent,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: line,
    edgeLabelBackground: fill2,
    clusterBkg: fill2,
    clusterBorder: edge,
    noteBkgColor: fill3,
    noteTextColor: text,
    noteBorderColor: gold,
    actorBkg: fill,
    actorBorder: accent,
    actorTextColor: text,
    actorLineColor: edge,
    signalColor: muted,
    signalTextColor: text,
    labelBoxBkgColor: fill,
    labelBoxBorderColor: accent,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: fill3,
    activationBorderColor: accent,
    sequenceNumberColor: ink,
    attributeBackgroundColorOdd: fill3,
    attributeBackgroundColorEven: fill2,
    rowOdd: fill3,
    rowEven: fill2,
    pieTitleTextColor: text,
    pieSectionTextColor: ink,
    pieLegendTextColor: text,
    pieStrokeColor: fill2,
    pieOuterStrokeColor: edge,
    pieOpacity: '1',
    commitLabelColor: text,
    commitLabelBackground: fill,
    tagLabelColor: text,
    tagLabelBackground: fill3,
    tagLabelBorder: edge,
    sectionBkgColor: fill,
    altSectionBkgColor: fill2,
    sectionBkgColor2: fill3,
    taskBkgColor: blue,
    taskBorderColor: blue,
    taskTextColor: ink,
    taskTextLightColor: ink,
    taskTextDarkColor: ink,
    taskTextOutsideColor: text,
    taskTextClickableColor: blue,
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    doneTaskBkgColor: muted,
    doneTaskBorderColor: muted,
    critBkgColor: red,
    critBorderColor: red,
    gridColor: edge,
    todayLineColor: accent,
    excludeBkgColor: fill2,
    xyChart: {
      backgroundColor: canvas,
      titleColor: text,
      xAxisLabelColor: muted,
      xAxisTitleColor: text,
      xAxisTickColor: edge,
      xAxisLineColor: edge,
      yAxisLabelColor: muted,
      yAxisTitleColor: text,
      yAxisTickColor: edge,
      yAxisLineColor: edge,
      plotColorPalette: series.join(','),
    },
  }
  series.forEach((color, k) => {
    variables[`pie${k + 1}`] = color
    variables[`git${k}`] = color
    variables[`gitBranchLabel${k}`] = ink
    variables[`fillType${k}`] = color
  })
  for (let k = 0; k < 12; k++) {
    variables[`cScale${k}`] = series[k % series.length]
    variables[`cScaleLabel${k}`] = ink
  }

  return variables
}

// Tighter spacing than Mermaid's, which lays diagrams out for a page: less
// space between a flowchart's ranks, a sequence diagram's actors and
// messages (its actors drawn once, not again below), a class's or an ER
// entity's rows, and a chart drawn at the size it needs. A journey keeps
// Mermaid's, which overlaps tighter.
const LAYOUT = {
  flowchart: { nodeSpacing: 30, rankSpacing: 34, padding: 8, diagramPadding: 4 },
  sequence: {
    wrap: true,
    actorMargin: 30,
    messageMargin: 24,
    boxMargin: 6,
    noteMargin: 6,
    width: 130,
    height: 38,
    diagramMarginX: 4,
    diagramMarginY: 4,
    mirrorActors: false,
  },
  class: { padding: 6, nodeSpacing: 30, rankSpacing: 34 },
  state: { padding: 6, nodeSpacing: 30, rankSpacing: 34 },
  er: {
    entityPadding: 12,
    minEntityHeight: 44,
    minEntityWidth: 90,
    diagramPadding: 6,
    nodeSpacing: 30,
    rankSpacing: 34,
  },
  xyChart: { width: 440, height: 270 },
  gantt: { barHeight: 18, barGap: 4, topPadding: 32 },
  mindmap: { padding: 8 },
}

// The Mermaid configuration: the shade's colors, the font merman is given,
// tighter spacing (LAYOUT), and long labels wrapped, as a sequence diagram's
// notes and messages.
// Written to the folder, which writing it makes; returns the arguments that
// hand merman it and, for a picture or a page (`isDrawn`), the font: merman
// refuses a font file for box art.
// The configuration files written this session, each once: a render writing
// it while another merman reads it can hand that one an empty file. Their
// text, to write one again that is gone (merman).
const written = new Map<string, Promise<void>>()
const configs = new Map<string, string>()

function writeConfig($: EngineInterface, file: string, text: string): Promise<void> {
  let writing = written.get(file)
  if (writing === undefined) {
    writing = $.fs.write(file, text)
    written.set(file, writing)
    configs.set(file, text)
    // A failed write is tried again by the next render.
    writing.catch(() => written.delete(file))
  }

  return writing
}

async function setupOf($: EngineInterface, folder: string, shade: Shade, isDrawn = true): Promise<string[]> {
  const found = await fontFor($)
  const family = found === undefined ? {} : { fontFamily: found.family }
  const config = {
    theme: 'base',
    wrap: true,
    ...LAYOUT,
    ...family,
    themeVariables: { ...themeVariablesOf(shade), ...family },
  }
  const file = `${folder}/theme-${shadeName(shade)}.json`
  await writeConfig($, file, JSON.stringify(config))

  return ['--config-file', file, ...(found === undefined || !isDrawn ? [] : ['--font-file', found.file])]
}

// The first line of merman's error output, or how it exited.
const reasonOf = (run: { exitCode: number; stderr: string }) =>
  run.stderr.split('\n').find(l => l.trim() !== '') ?? `merman-cli exited ${run.exitCode}`

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Runs merman-cli on the source, set up by `setup` (setupOf). A run that
// fails with its configuration file gone, as a temp folder cleaned during a
// long session leaves it, writes the file again (and its folder with it) and
// runs once more; only a failure asks, so a render that draws asks nothing.
async function merman($: EngineInterface, source: string, setup: string[], args: string[]) {
  const run = () =>
    $.process.run(
      ['merman-cli', 'render', '-', ...args, ...setup, '--operation-timeout-ms', String(TIMEOUT_MS), '--quiet'],
      { stdin: source, timeoutMs: TIMEOUT_MS + 1000 },
    )
  const file = setup[setup.indexOf('--config-file') + 1] ?? ''
  const before = written.get(file)
  const first = await run()
  const text = configs.get(file)
  if (first.exitCode === 0 || text === undefined) return first
  if (await $.fs.exists(file).catch(() => true)) return first
  // Written again once, however many runs found it gone.
  if (written.get(file) === before) written.delete(file)
  await writeConfig($, file, text)

  return run()
}

// Draws the diagram as a PNG on the shade's background, the terminal's own
// or its palette's (`canvas`), not a clear one, so its text reads whatever the
// terminal's background is, a dark theme's in a light terminal included;
// reads it back, or says why it could not.
async function drawPng(
  $: EngineInterface,
  source: string,
  setup: string[],
  file: string,
  { look, canvas = PALETTES[look].canvas }: Shade,
): Promise<Picture | string> {
  const run = await merman($, source, setup, [
    '--format',
    'png',
    '--output',
    file,
    '--background',
    canvas,
    '--scale',
    String(SCALE),
  ])
  if (run.exitCode !== 0) return reasonOf(run)
  const read = await $.fs.read(file, { as: 'bytes' })
  const png = typeof read === 'string' ? '' : read.base64
  if (png.length > MAX_PNG_LENGTH) return 'the picture is over 2 MiB'
  const size = sizeOf(png)
  if (size === undefined) return 'merman-cli wrote no PNG'

  return { png, width: size[0], height: size[1] }
}

// Draws the diagram as a picture, and turned the other way where it can turn,
// or says why it could not; the turned one is dropped if it fails alone.
export async function renderPicture($: EngineInterface, source: string, shade: Shade): Promise<Rendered> {
  try {
    const folder = await folderOf($)
    const setup = await setupOf($, folder, shade)
    const name = `${folder}/${hashOf(source)}-${shadeName(shade)}`
    const turned = turnedOf(source)
    // Both at once: the turned one is not waited for in turn.
    const [written, across] = await Promise.all([
      drawPng($, source, setup, `${name}.png`, shade),
      turned === undefined ? undefined : drawPng($, turned, setup, `${name}-turned.png`, shade).catch(() => undefined),
    ])
    if (typeof written === 'string') return { failed: written }

    return { pictures: typeof across === 'object' ? [written, across] : [written] }
  } catch (error) {
    return { failed: messageOf(error), isCutShort: true }
  }
}

// What merman's text report says: its text, and whether that is a drawing
// (`diagrammatic`) or the diagram's model written out (`structured_text`),
// all merman has for a mindmap, a gantt chart or a git graph, which is no
// diagram to show; or why it drew nothing. On standard output, or on standard
// error for some failures.
type TextReport = {
  family?: string
  projection?: string
  text?: string
  error?: { code?: string; message?: string; details?: { diagram_type?: string } }
}

// Why a kind has no box art, said one way whether merman refuses it or
// writes its model out.
const noArtFor = (kind: string | undefined) => `merman-cli draws no box art for ${kind ?? 'this kind of'} diagrams`

// The line a diagram drawn as its code shows under its header: why it is
// not drawn and, where the preview can draw it (`canPreview`), that it does.
export function noteOf(failed: string, canPreview: boolean): string {
  const isDrawable = failed.startsWith('merman-cli draws no box art') || failed.startsWith('the box art is')

  return isDrawable && canPreview ? `${failed}; the preview draws it.` : `${failed}.`
}

function reportOf(run: { stdout: string; stderr: string }): TextReport | undefined {
  for (const out of [run.stdout, run.stderr]) {
    try {
      const value: unknown = JSON.parse(out.trim())
      if (typeof value === 'object' && value !== null) return value as TextReport
    } catch {}
  }

  return undefined
}

// Whether merman-cli writes a text report (`--ascii-report`): an older one
// takes no such option, and prints its box art as it is, failing when it is
// too wide (`--ascii-overflow error`). Found out once.
let isReporting = true

// An XY chart's box art opens with lines of its model (`values: … samples=[…]`)
// before the chart: dropped, but its title. Other kinds' art is left as drawn.
function chartOf(text: string, family: string | undefined): string {
  if (family !== 'xychart') return text

  return text
    .split('\n')
    .flatMap(line => {
      const title = /^titleDisplay: chart\(bytes=\d+\)="(.*)"$/.exec(line)
      if (title !== null) return [title[1] ?? '']

      return /^(titleDisplay|values|xDomain): /.test(line) ? [] : [line]
    })
    .join('\n')
}

// Draws the diagram as Unicode box art at most `room` columns wide, tighter
// while it is too wide, then turned the other way (turnedOf), the tries
// within TEXT_BUDGET_MS; for a kind merman draws no box art for, the plugin's
// own (artOf) where it has one. Or says why it could not: no box art for the
// kind, or too wide however drawn.
export async function renderText($: EngineInterface, source: string, room: number, look: Look): Promise<Rendered> {
  try {
    const setup = await setupOf($, await folderOf($), { look }, false)
    const turned = turnedOf(source)
    const deadline = (await $.clock.now()) + TEXT_BUDGET_MS
    // The plugin's own art, or why there is none: a kind it draws too wide
    // for the room, or one it does not draw (`failed`).
    const own = (failed: string): Rendered => {
      const art = artOf(source, room)
      if (art === undefined) return { failed }

      return 'text' in art ? art : { failed: `the box art is wider than ${room} columns` }
    }
    const isReported = isReporting
    let failed: string | undefined
    for (const form of turned === undefined ? [source] : [source, turned]) {
      for (const [k, tighter] of TEXT_TRIES.entries()) {
        if ((await $.clock.now()) > deadline) return { failed: failed ?? 'merman-cli took too long over the box art' }
        const run = await merman($, form, setup, [
          '--format',
          'unicode',
          '--output',
          '-',
          ...(isReported ? ['--ascii-report'] : ['--ascii-overflow', 'error']),
          '--ascii-max-width',
          String(room),
          '--ascii-trim-trailing-spaces',
          '--ascii-color',
          'plain',
          ...tighter,
        ])
        const report: TextReport | undefined = isReported
          ? reportOf(run)
          : run.exitCode === 0
            ? { projection: 'diagrammatic', text: run.stdout }
            : undefined
        if (isReported && report === undefined && /--ascii-report/.test(reasonOf(run))) {
          // An older merman-cli: drawn again without the report.
          isReporting = false

          return renderText($, source, room, look)
        }
        if (report?.error?.code === 'merman.ascii.unsupported_diagram') {
          return own(noArtFor(report.error.details?.diagram_type))
        }
        if (run.exitCode !== 0 || report?.text === undefined) {
          const reason = report?.error?.message ?? reasonOf(run)
          // The first reason is the one to tell: a later try's option may
          // only be one this kind does not take.
          failed ??= reason
          if (/not admitted|exceeds requested width/.test(reason)) continue
          // The source as written, drawn plainly, is merman's to refuse; a
          // tighter try or the turned form refused moves on to the next form.
          if (k === 0 && form === source) return own(failed)
          break
        }
        if (report.projection !== 'diagrammatic') return own(noArtFor(report.family))
        const text = chartOf(report.text, report.family).replace(/\n+$/, '')
        if (text.trim() === '') return { failed: 'merman-cli drew no text' }
        const width = Math.max(...text.split('\n').map(textWidth))
        if (width <= room) return { text }
        failed ??= `the box art is ${width} columns wide, over ${room}`
      }
    }

    return { failed: failed ?? 'merman-cli drew no text' }
  } catch (error) {
    return { failed: messageOf(error), isCutShort: true }
  }
}

// The diagram as merman's SVG, as written, on its palette's background so it
// reads wherever it is pasted; or why not, `isCutShort` as Rendered's.
export async function svgOf(
  $: EngineInterface,
  source: string,
  look: Look,
): Promise<string | { failed: string; isCutShort?: true }> {
  try {
    const setup = await setupOf($, await folderOf($), { look })
    const run = await merman($, source, setup, [
      '--format',
      'svg',
      '--output',
      '-',
      '--background',
      PALETTES[look].canvas,
    ])
    if (run.exitCode !== 0 || !run.stdout.includes('<svg')) return { failed: reasonOf(run) }

    return run.stdout
  } catch (error) {
    return { failed: messageOf(error), isCutShort: true }
  }
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// How many characters a line of a failure's preview holds.
const NOTE_COLUMNS = 72

// The preview shown when merman-cli could not draw the diagram: why, on the
// palette's background, a line a row.
export function failedSvgOf(look: Look, reason: string): string {
  const { canvas, text, muted } = PALETTES[look]
  const lines = wrap(reason, NOTE_COLUMNS)
  const height = 64 + lines.length * 20

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}">`,
    `<rect width="100%" height="100%" fill="${canvas}"/>`,
    `<text x="24" y="36" fill="${text}" font-family="system-ui, sans-serif" font-size="18">merman-cli could not draw this diagram</text>`,
    ...lines.map(
      (line, k) =>
        `<text x="24" y="${64 + k * 20}" fill="${muted}" font-family="ui-monospace, monospace" font-size="13">${escapeXml(line)}</text>`,
    ),
    '</svg>',
  ].join('\n')
}

// A path as a `file:` URL, its parentheses escaped too so a markdown link
// can hold it.
export const fileUrl = (path: string) =>
  `file://${path
    .split('/')
    .map(part => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/')}`

// Styles and pictures inline, nothing else: no script, no network, so no
// label merman passes into its SVG can run or fetch anything.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

// The preview's page, for the browser: the SVG centered on its palette's
// background, under CSP.
export function previewPageOf(title: string, look: Look, svg: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeXml(title)}</title>`,
    '<style>',
    `html { color-scheme: ${look}; }`,
    `body { margin: 0; padding: 32px; background: ${PALETTES[look].canvas}; display: flex; justify-content: center; }`,
    'body > svg { max-width: 100%; height: auto; }',
    '</style>',
    '</head>',
    '<body>',
    svg.replace(/^\s*<\?xml[^>]*>\s*/, '').replace(/^<!doctype[^>]*>\s*/i, ''),
    '</body>',
    '</html>',
  ].join('\n')
}

// Where the diagram's preview is written: what a link to it names before it
// is there.
export const previewPathOf = (folder: string, source: string, look: Look) => `${folder}/${hashOf(source)}-${look}.html`

// Writes the diagram's preview and returns its path: a page of merman's SVG,
// or of one that says why merman-cli could not draw it. A drawing cut short
// is no answer: it throws, so the next try draws it again.
export async function writePreview($: EngineInterface, source: string, look: Look): Promise<string> {
  const svg = await svgOf($, source, look)
  if (typeof svg !== 'string' && svg.isCutShort === true) throw new Error(svg.failed)
  const file = previewPathOf(await folderOf($), source, look)
  const title = `Mermaid ${kindOf(source) ?? 'flowchart'}`
  await $.fs.write(file, previewPageOf(title, look, typeof svg === 'string' ? svg : failedSvgOf(look, svg.failed)))

  return file
}

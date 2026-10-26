import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cellsOf, failedSvgOf, fileUrl, hashOf, kindOf, noteOf, pictureFor, sizeOf, turnedOf } from '../hooks/merman'
import { artOf, mindmapArtOf, pieArtOf } from '../hooks/textart'

// A 707 × 454 grey PNG, as merman-cli might write one.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAsMAAAHGCAAAAAC0wtmwAAADW0lEQVR42u3SMQ0AAAzDsEIv9DLYP8mGECWF3yIBHgYPg4fxMHgYPAwexsPgYfAweBgPg4fBw+BhPAweBg+Dh/EweBg8DB7Gw+Bh8DB4GA+Dh8HD4GE8DB4GD4OH8TB4GDwMHsbD4GHwMB6WAA+Dh8HDeBg8DB4GD+Nh8DB4GDyMh8HD4GHwMB4GD4OHwcN4GDwMHgYP42HwMHgYPIyHwcPgYfAwHgYPg4fBw3gYPAweBg/jYfAweBgPS4CHwcPgYTwMHgYPg4fxMHgYPAwexsPgYfAweBgPg4fBw+BhPAweBg+Dh/EweBg8DB7Gw+Bh8DB4GA+Dh8HD4GE8DB4GD4OH8TB4GDyMhyXAw+Bh8DAeBg+Dh8HDeBg8DB4GD+Nh8DB4GDyMh8HD4GHwMB4GD4OHwcN4GDwMHgYP42HwMHgYPIyHwcPgYfAwHgYPg4fBw3gYPAwexsMS4GHwMHgYD4OHwcPgYTwMHgYPg4fxMHgYPAwexsPgYfAweBgPg4fBw+BhPAweBg+Dh/EweBg8DB7Gw+Bh8DB4GA+Dh8HD4GE8DB4GD+NhCfAweBg8jIfBw+Bh8DAeBg+Dh8HDeBg8DB4GD+Nh8DB4GDyMh8HD4GHwMB4GD4OHwcN4GDwMHgYP42HwMHgYPIyHwcPgYfAwHgYPg4fxsAR4GDwMHsbD4GHwMHgYD4OHwcPgYTwMHgYPg4fxMHgYPAwexsPgYfAweBgPg4fBw+BhPAweBg+Dh/EweBg8DB7Gw+Bh8DB4GA+Dh8HDeFgCPAweBg/jYfAweBg8jIfBw+Bh8DAeBg+Dh8HDeBg8DB4GD+Nh8DB4GDyMh8HD4GHwMB4GD4OHwcN4GDwMHgYP42HwMHgYPIyHwcPgYTwsAR4GD4OH8TB4GDwMHsbD4GHwMHgYD4OHwcPgYTwMHgYPg4fxMHgYPAwexsPgYfAweBgPg4fBw+BhPAweBg+Dh/EweBg8DB7Gw+Bh8DAelgAPg4fBw3gYPAweBg/jYfAweBg8jIfBw+Bh8DAeBg+Dh8HDeBg8DB4GD+Nh8DB4GDyMh8HD4GHwMB4GD4OHwcN4GDwMHgYP42HwMHgYD0uAh8HD4GE8DB4GD4OH8TB4GDwMHsbD4GHwMHgYD4OHwcPgYTwMHgYPw2m67Q2+Po2YiAAAAABJRU5ErkJggg=='

const FENCE = '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```'

// The box art merman-cli might draw for it.
const BOX_ART = '┌───────┐   ┌─────┐\n│ Alice │   │ Bob │\n└───┬───┘   └──┬──┘\n'

// An XY chart's box art as merman draws it, its model's lines first.
const CHART_ART = [
  'titleDisplay: chart(bytes=5)="Sales"',
  'values: █ series=0 type=bar title=none samples=[{index=0 x(bytes=1)="a" value=1}]',
  '1 ┼─┬─',
  '    a',
].join('\n')

// merman's text report for a source: box art, 82 columns of it while it
// is too wide; a mindmap's or a gantt chart's model written out; or a pie
// chart refused.
const reportOf = (source: string, isTooWide: boolean) => {
  const head = source.trimStart()
  const family = /^(mindmap|gantt)/.exec(head)?.[1]
  if (family !== undefined) {
    return JSON.stringify({ family, projection: 'structured_text', text: 'node(bytes=4)="Root"\n' })
  }
  if (head.startsWith('pie')) {
    return JSON.stringify({
      kind: 'ascii_error',
      error: { code: 'merman.ascii.unsupported_diagram', message: 'nope', details: { diagram_type: 'pie' } },
    })
  }
  const isChart = head.startsWith('xychart')
  const text = isTooWide ? '─'.repeat(82) : isChart ? CHART_ART : BOX_ART

  return JSON.stringify({ family: isChart ? 'xychart' : 'sequence', projection: 'diagrammatic', text })
}

// A reply in the fullscreen layout, or with `isFullscreen` false on the main
// screen.
const message = (text: string, requestId = 'msg-1', isFullscreen = true) =>
  ({
    plugin: 'cc-crisply',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
    viewport: { columns: 80, rows: 40, isFullscreen },
  }) as const

type Host = {
  // The environment, over a temp folder of `/tmp/`.
  env?: Record<string, string>
  // Whether the terminal is one known to draw pictures (Ghostty).
  images?: boolean
  // Whether merman-cli is installed, and how its renders exit; how many box
  // art tries are too wide before one fits.
  hasMerman?: boolean
  mermanExit?: number
  tooWide?: number
  // How many picture renders the engine aborts first, as it does a
  // superseded render's commands.
  abortFirst?: number
  // How many SVG renders the engine aborts first.
  svgAbortFirst?: number
  // Whether merman-cli is an older one, which takes no `--ascii-report` and
  // prints its box art as it is.
  isOldMerman?: boolean
  // Ghostty's configured background, as `ghostty +show-config` prints it;
  // none printed unless given.
  ghosttyBackground?: string
  // How many times Ghostty answers before it can't be asked.
  ghosttyAnswers?: number
  // kitty's configured background, as its config loader prints it.
  kittyBackground?: string
  // Claude Code's theme, and for `auto` whether macOS is in dark mode.
  theme?: string
  isSystemDark?: boolean
}

// The font a Mac has, which merman is given.
const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf'

// Stands for the host: its environment, Ghostty's unless `images` is false,
// merman-cli answering as `host` says (an SVG or box art on standard output, a
// PNG to its file), and the files written. Each command run is kept, and each
// toast and debug line.
function host(
  on: On,
  {
    env = {},
    images = true,
    hasMerman = true,
    mermanExit = 0,
    tooWide = 0,
    theme = 'dark',
    isSystemDark = true,
    abortFirst = 0,
    svgAbortFirst = 0,
    isOldMerman = false,
    ghosttyBackground,
    ghosttyAnswers = Number.POSITIVE_INFINITY,
    kittyBackground,
  }: Host = {},
) {
  let aborts = 0
  let svgAborts = 0
  let ghosttyAsked = 0
  let textTries = 0
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  const written = new Map<string, string>()
  // Every write, in order, a path written twice twice.
  const writes: string[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  // A terminal known to draw pictures, Ghostty, unless `images` is false.
  const vars: Record<string, string> = { TMPDIR: '/tmp/', ...(images ? { TERM_PROGRAM: 'ghostty' } : {}), ...env }
  on('env.get', (_, e) => ({ value: vars[e.name] }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.argv[0] === 'merman-cli' && !hasMerman) throw new Error('spawn merman-cli ENOENT')
    if (String(e.argv[0]).endsWith('ghostty') && e.argv[1] === '+show-config') {
      ghosttyAsked += 1
      if (ghosttyAsked > ghosttyAnswers) throw new Error('ghostty +show-config timed out')
      return {
        value: {
          exitCode: 0,
          stdout: `font-size = 13\n${ghosttyBackground === undefined ? '' : `background = ${ghosttyBackground}\n`}foreground = #ffffff\n`,
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (e.argv[0] === 'kitty' && e.argv[1] === '+runpy') {
      return {
        value: {
          exitCode: 0,
          stdout: `${kittyBackground ?? '#000000'}\n`,
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (e.argv[0] === 'defaults') {
      return {
        value: {
          exitCode: isSystemDark ? 0 : 1,
          stdout: isSystemDark ? 'Dark\n' : '',
          stderr: isSystemDark ? '' : 'The domain/default pair does not exist',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    const isRender = e.argv[0] === 'merman-cli' && e.argv[1] === 'render'
    const config = e.argv[e.argv.indexOf('--config-file') + 1] ?? ''
    if (isRender && !written.has(config)) {
      return {
        value: {
          exitCode: 2,
          stdout: '',
          stderr: `error: config file not found: ${config}`,
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (isRender && e.argv.includes('png') && aborts < abortFirst) {
      aborts += 1
      throw new Error('cc-crisply: $.process.run(merman-cli) aborted')
    }
    if (isRender && e.argv.includes('svg') && svgAborts < svgAbortFirst) {
      svgAborts += 1
      throw new Error('cc-crisply: $.process.run(merman-cli) aborted')
    }
    const isText = isRender && e.argv.includes('unicode')
    if (isText && isOldMerman) {
      const isReport = e.argv.includes('--ascii-report')
      if (!isReport) textTries += 1
      const isTooWide = !isReport && textTries <= tooWide
      const stderr = isReport
        ? "error: unexpected argument '--ascii-report' found"
        : isTooWide
          ? 'error: diagram exceeds requested width'
          : ''

      return {
        value: {
          exitCode: stderr === '' ? 0 : 2,
          stdout: stderr === '' ? BOX_ART : '',
          stderr,
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (isText) textTries += 1
    const isTooWide = isText && textTries <= tooWide
    const failed = isRender && mermanExit !== 0
    const format = isRender && !failed ? e.argv[e.argv.indexOf('--format') + 1] : undefined
    const stdout =
      format === 'svg'
        ? '<svg id="merman"><text>Alice</text></svg>'
        : format === 'unicode'
          ? reportOf(e.init?.stdin ?? '', isTooWide)
          : e.argv[0] === 'uname'
            ? 'Darwin\n'
            : ''

    return {
      value: {
        exitCode: failed ? mermanExit : 0,
        stdout,
        stderr: failed ? 'Diagram parse error (sequence): bad arrow' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('config.list', () => ({
    value: [
      {
        key: 'theme',
        label: 'Theme',
        kind: 'choice',
        value: theme,
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: false,
      },
    ],
  }))
  on('fs.read', () => ({ value: { base64: PNG } }))
  on('fs.exists', (_, e) => ({ value: e.path === ARIAL || written.has(e.path) }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    writes.push(e.path)

    return { value: undefined }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  // What each copy took.
  const copies: string[] = []
  on('ui.copy', (_, e) => {
    copies.push(e.text)

    return { value: { isCopied: true } }
  })
  // The debug lines the mod logs.
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(String(e.text))

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })

  return { runs, written, writes, toasts, logs, copies }
}

const renders = (runs: { argv: readonly string[]; stdin?: string }[], format: string) =>
  runs.filter(r => r.argv[0] === 'merman-cli' && r.argv[1] === 'render' && r.argv.includes(format))

// The page written for the diagram, by its path.
const previewIn = (written: Map<string, string>) => [...written].find(([path]) => path.endsWith('.html'))

test("a diagram's kind is named from its first keyword, a flowchart's not at all", () => {
  expect(kindOf('sequenceDiagram\n  A->>B: hi')).toBe('sequence')
  expect(kindOf('%% a note\nstateDiagram-v2\n  [*] --> A')).toBe('state')
  expect(kindOf('---\ntitle: Sales\n---\nxychart-beta\n  bar [1, 2]')).toBe('xychart')
  expect(kindOf('graph TD\n  A --> B')).toBeUndefined()
  expect(kindOf('flowchart LR\n  A --> B')).toBeUndefined()
  expect(hashOf('a')).toBe(hashOf('a'))
  expect(hashOf('a')).not.toBe(hashOf('b'))
})

test("a picture's size comes from its PNG header, and its cells keep its shape within the terminal", () => {
  expect(sizeOf(PNG)).toEqual([707, 454])
  expect(sizeOf('bm90IGEgcG5n')).toBeUndefined()
  // 707 px at twice the CSS size is 353 CSS px, thirty-five columns at ten
  // each; rows keep the shape with cells twice as tall as wide.
  expect(cellsOf({ width: 707, height: 454 }, 76)).toEqual({ columns: 35, rows: 11 })
  expect(cellsOf({ width: 8000, height: 800 }, 76)).toEqual({ columns: 76, rows: 4 })
  // A tall one is held to three quarters of the terminal's rows, narrowed to
  // keep its shape: 30 of 40, 48 at most.
  expect(cellsOf({ width: 800, height: 4000 }, 76, 40)).toEqual({ columns: 12, rows: 30 })
  // Never taller than the window holds beside the frame and prompt: 2 of 10.
  expect(cellsOf({ width: 800, height: 4000 }, 76, 10)).toEqual({ columns: 1, rows: 2 })
  expect(cellsOf({ width: 1600, height: 4000 }, 76, 100)).toEqual({ columns: 38, rows: 48 })
})

test('a flowchart turns between top-down and left-right; a state, class or ER diagram is given a direction', () => {
  expect(turnedOf('flowchart TD\n  A --> B')).toBe('flowchart LR\n  A --> B')
  expect(turnedOf('graph\n  A --> B')).toBe('graph LR\n  A --> B')
  expect(turnedOf('flowchart LR;\n  A --> B')).toBe('flowchart TD;\n  A --> B')
  expect(turnedOf('---\ntitle: x\n---\n%% note\nflowchart BT\n  A --> B')).toBe(
    '---\ntitle: x\n---\n%% note\nflowchart LR\n  A --> B',
  )
  expect(turnedOf('stateDiagram-v2\n  [*] --> A')).toBe('stateDiagram-v2\n    direction LR\n  [*] --> A')
  expect(turnedOf('erDiagram\n  A ||--o{ B : has')).toBe('erDiagram\n    direction LR\n  A ||--o{ B : has')
  // One that names its direction keeps it; a kind with none can't turn.
  expect(turnedOf('classDiagram\n  direction RL\n  A <|-- B')).toBeUndefined()
  expect(turnedOf('sequenceDiagram\n  A->>B: hi')).toBeUndefined()
  // An ELK flowchart keeps its renderer; no other word starting `graph` turns.
  expect(turnedOf('flowchart-elk TD\n  A --> B')).toBe('flowchart-elk LR\n  A --> B')
  expect(turnedOf('graphs TD\n  A --> B')).toBeUndefined()
  expect(turnedOf('pie\n  "a": 1')).toBeUndefined()
})

test('of a diagram drawn both ways, the one larger here is shown, sideways while about as large', () => {
  const tall = { png: 'tall', width: 696, height: 1232 }
  const wide = { png: 'wide', width: 1998, height: 368 }
  // In 74 columns sideways is three quarters the size: top-down is shown.
  expect(pictureFor([tall, wide], 74, 40)).toEqual({ picture: tall, columns: 34, rows: 30 })
  // In 114, both are drawn at their own size: sideways is shown.
  expect(pictureFor([tall, wide], 114, 50)).toEqual({ picture: wide, columns: 100, rows: 9 })
  expect(pictureFor([tall], 74, 40)?.picture).toBe(tall)
  expect(pictureFor([], 74, 40)).toBeUndefined()
})

test("a failure's preview says why, escaped and wrapped, on the palette's background", () => {
  const svg = failedSvgOf('dark', `parse error <here> ${'word '.repeat(20)}`)
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  expect(svg).toContain('<rect width="100%" height="100%" fill="#1f1d1b"/>')
  expect(svg).toContain('>merman-cli could not draw this diagram</text>')
  expect(svg).toContain('parse error &lt;here&gt;')
  expect(svg.match(/font-size="13"/g)).toHaveLength(2)
  expect(fileUrl('/tmp/a b/c#1 (2).svg')).toBe('file:///tmp/a%20b/c%231%20%282%29.svg')
})

test('a diagram drawn as code says why, and that the preview draws it where it can', () => {
  expect(noteOf('merman-cli draws no box art for gantt diagrams', true)).toBe(
    'merman-cli draws no box art for gantt diagrams; the preview draws it.',
  )
  expect(noteOf('the box art is 90 columns wide, over 74', false)).toBe('the box art is 90 columns wide, over 74.')
  expect(noteOf('Diagram parse error (sequence): bad arrow', true)).toBe('Diagram parse error (sequence): bad arrow.')
})

test('a pie chart is drawn as bars, the largest slice full width', () => {
  const art = pieArtOf('pie showData title Pets\n  "Dogs" : 386\n  "Cats" : 85\n  "Rats" : 15', 40)
  expect(art?.split('\n')).toEqual([
    'Pets',
    `Dogs ${'█'.repeat(23)} 79.4% (386)`,
    `Cats █████▏${' '.repeat(17)}  17.5% (85)`,
    `Rats ▉${' '.repeat(22)}   3.1% (15)`,
  ])
  expect(pieArtOf('pie\n  "A" : 1', 6)).toBeUndefined()
  expect(pieArtOf('graph TD\n  A --> B', 40)).toBeUndefined()
})

test('a mindmap is drawn as a tree, its shapes taken off and long labels wrapped', () => {
  const source = [
    'mindmap',
    '  root((Plans))',
    '    a[Work]',
    '      b(Ship the release notes on time)',
    '      ::icon(fa fa-book)',
    '    c{{Home}}',
  ].join('\n')
  expect(mindmapArtOf(source, 24)?.split('\n')).toEqual([
    'Plans',
    '├── Work',
    '│   └── Ship the release',
    '│       notes on time',
    '└── Home',
  ])
  expect(mindmapArtOf(source, 10)).toBeUndefined()
})

test('where the engine draws pictures, a diagram is code till merman draws it, then the picture', async ($, on) => {
  const { runs, written } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE))
  expect(JSON.stringify(await ui.drawn())).toContain('Alice->>Bob')
  await clock.advance(0)
  const png = renders(runs, 'png')
  expect(png).toHaveLength(1)
  expect(png[0]?.argv).toEqual([
    'merman-cli',
    'render',
    '-',
    '--format',
    'png',
    '--output',
    expect.stringMatching(/^\/tmp\/cc-crisply\/[0-9a-f]{8}-dark\.png$/),
    '--background',
    '#1f1d1b',
    '--scale',
    '2',
    '--config-file',
    '/tmp/cc-crisply/theme-dark.json',
    '--font-file',
    ARIAL,
    '--operation-timeout-ms',
    '5000',
    '--quiet',
  ])
  expect(png[0]?.stdin).toBe('sequenceDiagram\n  Alice->>Bob: Hello')
  // Laid out and drawn in the one font, its labels wrapped, in Claude Code's
  // colors over Mermaid's base theme.
  expect(JSON.parse(written.get('/tmp/cc-crisply/theme-dark.json') ?? '{}')).toMatchObject({
    theme: 'base',
    wrap: true,
    fontFamily: 'Arial',
    themeVariables: { fontFamily: 'Arial', primaryBorderColor: '#d97757', pie1: '#d97757', git1: '#6a9bcc' },
    sequence: { mirrorActors: false },
    flowchart: { rankSpacing: 34 },
  })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { png: PNG }, columns: 35, rows: 11, alt: 'sequence diagram' })
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toMatch(/"borderStyle":"round".*"mermaid · sequence".*"preview-1".*"copy-1"/)
  expect(tree).not.toContain('Alice->>Bob')
  await ui.unmount()
})

test("without TMPDIR, as Linux leaves it, the files go in the person's cache, not the shared /tmp", async ($, on) => {
  const { written } = host(on, { env: { TMPDIR: '', HOME: '/home/me/' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-home'))
  await clock.advance(0)
  expect([...written.keys()]).toEqual(['/home/me/.cache/cc-crisply/theme-dark.json'])
  await ui.unmount()
})

test('XDG_CACHE_HOME, where it is set, is the cache the files go in', async ($, on) => {
  const { written } = host(on, { env: { TMPDIR: '', XDG_CACHE_HOME: '/home/me/.xdg', HOME: '/home/me' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-xdg'))
  await clock.advance(0)
  expect([...written.keys()]).toEqual(['/home/me/.xdg/cc-crisply/theme-dark.json'])
  await ui.unmount()
})

test('a flowchart is drawn both ways, and the one larger in the terminal shown', async ($, on) => {
  const { runs } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message('```mermaid\nflowchart TD\n  A --> B\n```', 'msg-turn'))
  await clock.advance(0)
  const png = renders(runs, 'png')
  expect(png.map(r => r.stdin)).toEqual(['flowchart TD\n  A --> B', 'flowchart LR\n  A --> B'])
  expect(png[1]?.argv).toContainEqual(expect.stringMatching(/^\/tmp\/cc-crisply\/[0-9a-f]{8}-dark-turned\.png$/))
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('a picture drawn at another width is a new Image, sized to the new room, so the terminal draws it anew', async ($, on) => {
  host(on)
  const clock = mock.clock(on)
  const at = (columns: number) => ({
    ...message(FENCE, 'msg-resize'),
    viewport: { columns, rows: 40, isFullscreen: true },
  })
  const wide = await $.ui.mount(at(120))
  await clock.advance(0)
  const before = await wide.find({ type: 'Image' })
  await wide.unmount()
  const narrow = await $.ui.mount(at(40))
  const after = await narrow.find({ type: 'Image' })
  await narrow.unmount()
  expect(before?.props).toMatchObject({ columns: 35, rows: 11 })
  // 40 columns, less the gutter and the frame: 34 for the picture.
  expect(after?.props).toMatchObject({ columns: 34, rows: 11 })
  expect(before?.key).toBe('figure-1-35x11')
  expect(after?.key).toBe('figure-1-34x11')
})

test("diagrams take the theme's look: light, dark, and for auto the terminal's or the system's", async ($, on) => {
  const looks: string[] = []
  // kitty draws pictures but says nothing of its background: macOS decides.
  const { runs } = host(on, {
    images: false,
    theme: 'auto',
    isSystemDark: false,
    env: { COLORFGBG: '', TERM: 'xterm-kitty' },
  })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-auto'))
  await clock.advance(0)
  for (const run of renders(runs, 'png')) looks.push(String(run.argv.find(a => a.endsWith('.png'))))
  await ui.unmount()
  // macOS in light mode, and no word from the terminal: light.
  expect(looks).toEqual([expect.stringMatching(/-light\.png$/)])
  expect(runs.some(r => r.argv.join(' ') === 'defaults read -g AppleInterfaceStyle')).toBe(true)
})

test('a terminal that names its background is believed over the system', async ($, on) => {
  const { runs } = host(on, { theme: 'auto', isSystemDark: true, env: { COLORFGBG: '0;15' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-fgbg'))
  await clock.advance(0)
  await ui.unmount()
  expect(renders(runs, 'png')[0]?.argv).toContainEqual(expect.stringMatching(/-light\.png$/))
  expect(runs.some(r => r.argv[0] === 'defaults')).toBe(false)
})

test('a light theme draws in the light palette, its labels dark enough for white text', async ($, on) => {
  const { written } = host(on, { theme: 'light-daltonized' })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-light'))
  await clock.advance(0)
  await ui.unmount()
  const config = JSON.parse(written.get('/tmp/cc-crisply/theme-light.json') ?? '{}')
  expect(config.themeVariables).toMatchObject({
    primaryTextColor: '#2b2622',
    pie4: '#956d25',
    pieSectionTextColor: '#ffffff',
  })
})

test('a picture always fits the window, and in one too small to read it is shown as code', async ($, on) => {
  host(on)
  const clock = mock.clock(on)
  const sized = async (columns: number, rows: number) => {
    const ui = await $.ui.mount({
      ...message(FENCE, `msg-small-${columns}x${rows}`),
      viewport: { columns, rows, isFullscreen: true },
    })
    await clock.advance(0)
    await clock.advance(0)
    const image = await ui.find({ type: 'Image' })
    const tree = JSON.stringify(await ui.drawn())
    await ui.unmount()

    return image === undefined
      ? tree.includes('Alice->>Bob')
        ? 'code'
        : 'nothing'
      : [image.props.columns, image.props.rows]
  }
  expect(await sized(80, 40)).toEqual([35, 11])
  // 40 wide: 34 for the picture; 20 tall: 12 rows beside frame and prompt.
  expect(await sized(40, 20)).toEqual([34, 11])
  // 30 by 14: six rows, narrowed to keep the shape.
  expect(await sized(30, 14)).toEqual([19, 6])
  // 16 wide: the frame's 20 would run off it; 10 for the picture is too few.
  expect(await sized(16, 30)).toBe('code')
  expect(await sized(60, 10)).toBe('code')
})

test("a diagram's svg button copies merman's SVG, on its background; its mermaid button, the source", async ($, on) => {
  const { runs, copies } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-svg'))
  await clock.advance(0)
  expect((await ui.find({ key: 'copy-1-svg' }))?.text).toBe('[ ⧉ svg ]')
  expect((await ui.find({ key: 'copy-1' }))?.text).toBe('[ ⧉ mermaid ]')
  await ui.press({ key: 'copy-1-svg' })
  expect(copies).toEqual(['<svg id="merman"><text>Alice</text></svg>'])
  expect(runs.at(-1)?.argv).toEqual(expect.arrayContaining(['--format', 'svg', '--background', '#1f1d1b']))
  expect((await ui.find({ key: 'copy-1-svg' }))?.text).toBe('[ ✓ copied ]')
  await ui.press({ key: 'copy-1' })
  expect(copies.at(-1)).toBe('sequenceDiagram\n  Alice->>Bob: Hello')
  expect((await ui.find({ key: 'copy-1' }))?.text).toBe('[ ✓ copied ]')
  expect((await ui.find({ key: 'copy-1-svg' }))?.text).toBe('[ ⧉ svg ]')
  await ui.unmount()
})

test("without merman-cli a diagram has no svg button; one merman can't draw says why", async ($, on) => {
  host(on, { hasMerman: false })
  const ui = await $.ui.mount(message(FENCE, 'msg-no-svg'))
  expect(await ui.find({ key: 'copy-1-svg' })).toBeUndefined()
  expect((await ui.find({ key: 'copy-1' }))?.text).toBe('[ ⧉ mermaid ]')
  await ui.unmount()
})

test("an SVG merman can't draw is not copied, and a toast says why", async ($, on) => {
  const { copies, toasts } = host(on, { mermanExit: 1 })
  const ui = await $.ui.mount(message(FENCE, 'msg-svg-fail'))
  await ui.press({ key: 'copy-1-svg' })
  expect(copies).toEqual([])
  expect(toasts).toEqual(['Could not draw the SVG: Diagram parse error (sequence): bad arrow'])
  await ui.unmount()
})

test('a diagram merman cannot draw stays code, and is not tried again', async ($, on) => {
  const { runs } = host(on, { mermanExit: 1 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-fail'))
  await clock.advance(0)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('Alice->>Bob')
  await ui.unmount()
  const again = await $.ui.mount(message(FENCE, 'msg-fail-2'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toHaveLength(1)
  await again.unmount()
})

test("where the engine draws a picture's alt, merman's box art", async ($, on) => {
  const { runs } = host(on, { images: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-plain'))
  await clock.advance(0)
  const text = renders(runs, 'unicode')
  expect(text).toHaveLength(1)
  expect(text[0]?.argv).toEqual(
    expect.arrayContaining(['--ascii-report', '--ascii-max-width', '74', '--ascii-color', 'plain']),
  )
  // merman refuses a font file for box art.
  expect(text[0]?.argv).not.toContain('--font-file')
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"│ Alice │   │ Bob │"')
  expect(tree).not.toContain('Alice->>Bob')
  expect(tree).not.toContain('"type":"Image"')
  await ui.unmount()
})

test('box art too wide is drawn again tighter', async ($, on) => {
  const { runs } = host(on, { images: false, tooWide: 2 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-tight'))
  await clock.advance(0)
  const tries = renders(runs, 'unicode').map(r =>
    r.argv.slice(r.argv.indexOf('plain') + 1, r.argv.indexOf('--config-file')),
  )
  expect(tries).toEqual([
    [],
    ['--ascii-graph-padding-x', '2', '--ascii-graph-padding-y', '1'],
    ['--ascii-graph-padding-x', '2', '--ascii-graph-padding-y', '1', '--ascii-layout-profile', 'auto'],
  ])
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test('box art too wide however tight stays code, after three tries', async ($, on) => {
  const { runs } = host(on, { images: false, tooWide: 99 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-never'))
  await clock.advance(0)
  expect(renders(runs, 'unicode')).toHaveLength(3)
  expect(JSON.stringify(await ui.drawn())).toContain('Alice->>Bob')
  await ui.unmount()
})

test('a kind merman writes out as its model, not box art, stays code after one try, saying why', async ($, on) => {
  const { runs } = host(on, { images: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message('```mermaid\ngantt\n  title Plan\n```', 'msg-model'))
  await clock.advance(0)
  expect(renders(runs, 'unicode')).toHaveLength(1)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('title Plan')
  expect(tree).not.toContain('bytes=')
  expect(tree).toContain('"merman-cli draws no box art for gantt diagrams; the preview draws it."')
  await ui.unmount()
})

test("a mindmap or pie chart merman draws no box art for is drawn by the plugin's own", async ($, on) => {
  host(on, { images: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(
    message('```mermaid\nmindmap\n  root((Root))\n    A\n```\n\n```mermaid\npie\n  "Dogs" : 3\n```', 'msg-own'),
  )
  await clock.advance(0)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"└── A"')
  expect(tree).toContain(`"Dogs ${'█'.repeat(62)} 100.0%"`)
  expect(tree).not.toContain('no box art')
  await ui.unmount()
})

test('a flowchart too wide however tight is drawn turned top-down', async ($, on) => {
  const { runs } = host(on, { images: false, tooWide: 3 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message('```mermaid\nflowchart LR\n  A --> B\n```', 'msg-turn'))
  await clock.advance(0)
  const tries = renders(runs, 'unicode')
  expect(tries).toHaveLength(4)
  expect(tries[3]?.stdin).toContain('flowchart TD')
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test("an XY chart's box art drops its model's lines, keeping its title", async ($, on) => {
  host(on, { images: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message('```mermaid\nxychart-beta\n  bar [1]\n```', 'msg-chart'))
  await clock.advance(0)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"Sales"')
  expect(tree).toContain('"1 ┼─┬─"')
  expect(tree).not.toContain('samples=')
  await ui.unmount()
})

test('the theme file is written once, so no render reads it half-written', async ($, on) => {
  const { runs, writes } = host(on, { images: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(`${FENCE}\n\n${FENCE.replace('Hello', 'Bye')}`, 'msg-once'))
  await clock.advance(0)
  await ui.unmount()
  // Two renders, one a diagram, and the theme written once.
  expect(renders(runs, 'unicode')).toHaveLength(2)
  expect(writes.filter(path => path.endsWith('theme-dark.json'))).toHaveLength(1)
})

test('a theme file cleaned away during a long session is written again, and the diagram still drawn', async ($, on) => {
  const { runs, written, writes } = host(on, { images: false })
  const clock = mock.clock(on)
  const first = await $.ui.mount(message(FENCE, 'msg-gone-1'))
  await clock.advance(0)
  await first.unmount()
  written.delete('/tmp/cc-crisply/theme-dark.json')
  const later = await $.ui.mount(message(FENCE.replace('Hello', 'Bye'), 'msg-gone-2'))
  await clock.advance(0)
  expect(writes.filter(path => path.endsWith('theme-dark.json'))).toHaveLength(2)
  // The first diagram's render, then the second's that failed and its rerun.
  expect(renders(runs, 'unicode')).toHaveLength(3)
  const tree = JSON.stringify(await later.drawn())
  expect(tree).toContain('│ Alice │')
  expect(tree).not.toContain('not found')
  await later.unmount()
})

test('the debug log tells each render and what each diagram is drawn as, once a change', async ($, on) => {
  const { logs } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-log'))
  await clock.advance(100)
  await clock.advance(0)
  await ui.unmount()
  expect(logs).toEqual([
    'cc-crisply: diagram msg-log#1 drawn as code (waiting for merman)',
    expect.stringMatching(/^cc-crisply: picture [0-9a-f]{8}:dark:pic: drawn$/),
    'cc-crisply: diagram msg-log#1 drawn as picture figure-1-35x11',
  ])
})

test("once the session starts, a worker on the session's own $ draws the diagrams", async ($, on) => {
  const { runs } = host(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(message(FENCE, 'msg-worker'))
  await clock.advance(100)
  await clock.advance(0)
  expect(renders(runs, 'png')).toHaveLength(1)
  expect(await ui.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  await ui.unmount()
})

test("a new session's worker takes over from the last's, and each diagram is drawn once", async ($, on) => {
  const { runs } = host(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(message(FENCE, 'msg-worker-2'))
  await clock.advance(100)
  await clock.advance(0)
  expect(renders(runs, 'png')).toHaveLength(1)
  expect(await ui.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  await ui.unmount()
})

test('a render cut short is not stored as failed, so the next drawing asks again', async ($, on) => {
  const { runs, logs } = host(on, { abortFirst: 1 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-cut'))
  await clock.advance(0)
  // The picture's render was aborted and left unstored: code for now.
  expect(logs.filter(line => /^cc-crisply: picture .*: failed: /.test(line))).toHaveLength(1)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
  // The next drawing asks again, and that one draws.
  const again = await $.ui.mount(message(FENCE, 'msg-cut-2'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toHaveLength(2)
  expect(await again.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  await again.unmount()
})

test('Ghostty gets pictures; a terminal not known to draw them gets box art', async ($, on) => {
  const { runs } = host(on, { images: false, env: { TERM: 'xterm-ghostty' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-known'))
  await clock.advance(0)
  expect(await ui.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  expect(renders(runs, 'unicode')).toEqual([])
  await ui.unmount()
})

test('a terminal not known to draw pictures gets box art, nothing tried in its place', async ($, on) => {
  const { runs } = host(on, { images: false, env: { TERM_PROGRAM: 'WezTerm' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-unknown'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test('kitty gets pictures', async ($, on) => {
  host(on, { images: false, env: { TERM: 'xterm-kitty' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-kitty'))
  await clock.advance(0)
  expect(await ui.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  await ui.unmount()
})

test('iTerm2 3.5 gets pictures in the fullscreen layout, box art on the main screen', async ($, on) => {
  const { runs } = host(on, { images: false, env: { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.4' } })
  const clock = mock.clock(on)
  const full = await $.ui.mount(message(FENCE, 'msg-iterm'))
  await clock.advance(0)
  expect(await full.find({ type: 'Image', key: 'figure-1-35x11' })).toBeDefined()
  await full.unmount()
  const main = await $.ui.mount(message(FENCE, 'msg-iterm-main', false))
  await clock.advance(0)
  expect(await main.find({ type: 'Image' })).toBeUndefined()
  expect(renders(runs, 'unicode')).toHaveLength(1)
  await main.unmount()
})

test("with the auto theme in Ghostty, Ghostty's own background wins over macOS's appearance", async ($, on) => {
  const { runs } = host(on, {
    theme: 'auto',
    isSystemDark: false,
    ghosttyBackground: '#1f1f1f',
    env: { TERM_PROGRAM: 'ghostty', GHOSTTY_BIN_DIR: '/Applications/Ghostty.app/Contents/MacOS' },
  })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-ghostty-dark'))
  await clock.advance(0)
  await ui.unmount()
  expect(runs.some(r => r.argv.join(' ') === '/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config')).toBe(
    true,
  )
  expect(runs.some(r => r.argv[0] === 'defaults')).toBe(false)
  // Drawn on Ghostty's own background, not the palette's.
  expect(renders(runs, 'png')[0]?.argv).toEqual(
    expect.arrayContaining([expect.stringMatching(/-dark-1f1f1f\.png$/), '--background', '#1f1f1f']),
  )
})

test("with the auto theme in kitty, kitty's own background wins over macOS's appearance", async ($, on) => {
  const { runs } = host(on, {
    images: false,
    theme: 'auto',
    isSystemDark: false,
    kittyBackground: '#1a1b26',
    env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' },
  })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-kitty-dark'))
  await clock.advance(0)
  await ui.unmount()
  expect(runs.some(r => r.argv[0] === 'kitty' && r.argv[1] === '+runpy')).toBe(true)
  expect(runs.some(r => r.argv[0] === 'defaults')).toBe(false)
  // Drawn on kitty's own background, its theme file colored to match.
  expect(renders(runs, 'png')[0]?.argv).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/-dark-1a1b26\.png$/),
      '--background',
      '#1a1b26',
      '/tmp/cc-crisply/theme-dark-1a1b26.json',
    ]),
  )
})

test("a terminal's background of the other look is left alone: a dark picture on a light terminal keeps its own", async ($, on) => {
  const { runs } = host(on, { theme: 'dark', ghosttyBackground: '#ffffff' })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-ghostty-light'))
  await clock.advance(0)
  await ui.unmount()
  expect(renders(runs, 'png')[0]?.argv).toEqual(
    expect.arrayContaining([expect.stringMatching(/[0-9a-f]{8}-dark\.png$/), '--background', '#1f1d1b']),
  )
})

test('the install hint says what to install, with no link', async ($, on) => {
  const { toasts } = host(on, { hasMerman: false })
  const ui = await $.ui.mount(message(FENCE, 'msg-guide'))
  await ui.unmount()
  expect(toasts).toEqual(['Install merman-cli to see Mermaid diagrams drawn'])
})

test('Ghostty inside tmux, zellij or screen gets box art: they hold pictures back', async ($, on) => {
  const { runs } = host(on, { env: { TMUX: '/tmp/tmux-501/default,1,0' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-tmux'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test('zellij and screen hold pictures back too', async ($, on) => {
  const { runs } = host(on, { env: { ZELLIJ: '0', STY: '123.pts-0' } })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-zellij'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toEqual([])
  await ui.unmount()
})

test('display set to text, even Ghostty gets box art', { options: { diagramDisplay: 'text' } }, async ($, on) => {
  const { runs } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-text'))
  await clock.advance(0)
  expect(renders(runs, 'png')).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test(
  'display set to code, a diagram stays code with its buttons, merman never run',
  { options: { diagramDisplay: 'code' } },
  async ($, on) => {
    const { runs, toasts } = host(on)
    const clock = mock.clock(on)
    const ui = await $.ui.mount(message(FENCE, 'msg-code'))
    await clock.advance(0)
    expect(runs.filter(r => r.argv[0] === 'merman-cli' && r.argv[1] === 'render')).toEqual([])
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).toContain('Alice->>Bob')
    expect(await ui.find({ key: 'preview-1' })).toBeUndefined()
    expect(await ui.find({ key: 'copy-1' })).toBeDefined()
    expect(toasts).toEqual([])
    await ui.unmount()
  },
)

test(
  'display set to code without merman-cli, no install hint',
  { options: { diagramDisplay: 'code' } },
  async ($, on) => {
    const { toasts } = host(on, { hasMerman: false })
    const ui = await $.ui.mount(message(FENCE, 'msg-code-hint'))
    await ui.unmount()
    expect(toasts).toEqual([])
  },
)

test(
  'theme set to light draws light under a dark Claude Code theme',
  { options: { diagramTheme: 'light' } },
  async ($, on) => {
    const { runs } = host(on, { theme: 'dark' })
    const clock = mock.clock(on)
    const ui = await $.ui.mount(message(FENCE, 'msg-theme-light'))
    await clock.advance(0)
    await ui.unmount()
    expect(renders(runs, 'png')[0]?.argv).toContainEqual(expect.stringMatching(/-light\.png$/))
  },
)

test(
  'theme set to dark draws dark on a light system, the system never asked',
  { options: { diagramTheme: 'dark' } },
  async ($, on) => {
    const { runs } = host(on, { theme: 'auto', isSystemDark: false })
    const clock = mock.clock(on)
    const ui = await $.ui.mount(message(FENCE, 'msg-theme-dark'))
    await clock.advance(0)
    await ui.unmount()
    expect(renders(runs, 'png')[0]?.argv).toContainEqual(expect.stringMatching(/-dark\.png$/))
    expect(runs.some(r => r.argv[0] === 'defaults')).toBe(false)
  },
)

test("in the fullscreen layout the preview is a button that writes a page of merman's SVG and opens it in the browser", async ($, on) => {
  const { runs, written } = host(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-button'))
  const preview = await ui.find({ key: 'preview-1' })
  expect(preview?.text).toBe('[ ↗ preview ]')
  expect(previewIn(written)).toBeUndefined()
  await ui.press({ key: 'preview-1' })
  const page = previewIn(written)
  expect(page?.[0]).toMatch(/^\/tmp\/cc-crisply\/[0-9a-f]{8}-dark\.html$/)
  expect(page?.[1]).toContain('<svg id="merman"><text>Alice</text></svg>')
  // Under a policy that lets no label in it run a script or fetch anything.
  expect(page?.[1]).toContain(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
  )
  expect(page?.[1]).toContain('<title>Mermaid sequence</title>')
  expect(runs.at(-1)?.argv).toEqual(['open', page?.[0]])
  await ui.unmount()
})

test('on the main screen the preview is a link to its page, written ahead, that a click opens', async ($, on) => {
  const { runs, written } = host(on)
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-link', false))
  await clock.advance(0)
  const preview = await ui.find({ key: 'preview-1' })
  const page = previewIn(written)
  expect(page?.[0]).toMatch(/^\/tmp\/cc-crisply\/[0-9a-f]{8}-dark\.html$/)
  const href = `file://${page?.[0]}`
  expect(preview?.props).toMatchObject({ text: `[\\[ ↗ preview \\]](${href})`, pressableLinks: [href] })
  await ui.press({ key: 'preview-1', link: { href } })
  expect(runs.at(-1)?.argv).toEqual(['open', page?.[0]])
  await ui.unmount()
})

test('a preview merman cannot draw says why, as does the code under its header', async ($, on) => {
  const { written } = host(on, { images: false, mermanExit: 1 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-wide'))
  await clock.advance(0)
  expect(JSON.stringify(await ui.drawn())).toContain('"Diagram parse error (sequence): bad arrow."')
  await ui.press({ key: 'preview-1' })
  const page = previewIn(written)?.[1]
  expect(page).toContain('>merman-cli could not draw this diagram</text>')
  expect(page).toContain('Diagram parse error (sequence): bad arrow')
  await ui.unmount()
})

test('without merman-cli, a diagram is code with no preview, and a hint, once', async ($, on) => {
  const { runs, written, toasts } = host(on, { hasMerman: false })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-none'))
  await clock.advance(0)
  expect(runs.filter(r => r.argv[1] === 'render')).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toContain('Alice->>Bob')
  expect(await ui.find({ key: 'preview-1' })).toBeUndefined()
  expect(previewIn(written)).toBeUndefined()
  await ui.unmount()
  const again = await $.ui.mount(message(FENCE, 'msg-none-2'))
  await again.unmount()
  expect(toasts.filter(t => t.includes('merman-cli'))).toHaveLength(1)
})

test("in a narrow terminal the header drops the kind, then the preview button's word, to stay on one row", async ($, on) => {
  host(on)
  const at = (columns: number, requestId: string) => ({
    ...message(FENCE, requestId),
    viewport: { columns, rows: 40, isFullscreen: true },
  })
  const header = async (columns: number) => {
    const ui = await $.ui.mount(at(columns, `msg-narrow-${columns}`))
    const tree = JSON.stringify(await ui.drawn())
    const preview = (await ui.find({ key: 'preview-1' }))?.text
    await ui.unmount()

    return [/mermaid · sequence/.test(tree), preview]
  }
  expect(await header(80)).toEqual([true, '[ ↗ preview ]'])
  expect(await header(60)).toEqual([false, '[ ↗ preview ]'])
  expect(await header(50)).toEqual([false, '[ ↗ ]'])
})

test('a diagram still streaming, or one over SSH, has no preview', async ($, on) => {
  const { written } = host(on, { env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' } })
  const open = await $.ui.mount(message('```mermaid\ngraph TD\n  A --> B', 'msg-open'))
  expect(await open.find({ key: 'preview-1' })).toBeUndefined()
  expect(await open.find({ key: 'copy-1' })).toBeDefined()
  await open.unmount()
  const ssh = await $.ui.mount(message(FENCE, 'msg-ssh'))
  expect(await ssh.find({ key: 'preview-1' })).toBeUndefined()
  expect(previewIn(written)).toBeUndefined()
  await ssh.unmount()
})

test('an older merman-cli with no text report still draws box art, tighter while too wide', async ($, on) => {
  const { runs } = host(on, { images: false, isOldMerman: true, tooWide: 1 })
  const clock = mock.clock(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-old'))
  await clock.advance(0)
  const tries = renders(runs, 'unicode')
  expect(tries[0]?.argv).toContain('--ascii-report')
  expect(tries.slice(1).map(r => r.argv.includes('--ascii-report'))).toEqual([false, false])
  expect(tries[1]?.argv).toEqual(expect.arrayContaining(['--ascii-overflow', 'error']))
  expect(JSON.stringify(await ui.drawn())).toContain('"│ Alice │   │ Bob │"')
  await ui.unmount()
})

test("a kind the plugin draws, in too narrow a room, says it doesn't fit, not that there is no art", async ($, on) => {
  host(on, { images: false })
  const deep = 'mindmap\n  Root\n    A\n      B\n        C'
  expect(artOf(deep, 16)).toEqual({ isTooNarrow: true })
  expect(artOf('graph TD\n  A --> B', 16)).toBeUndefined()
  const clock = mock.clock(on)
  const ui = await $.ui.mount({
    ...message(`\`\`\`mermaid\n${deep}\n\`\`\``, 'msg-deep'),
    viewport: { columns: 20, rows: 40, isFullscreen: true },
  })
  await clock.advance(0)
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('"wider than 16"')
  expect(tree).not.toContain('no box art')
  await ui.unmount()
  expect(noteOf('the box art is wider than 16 columns', true)).toBe(
    'the box art is wider than 16 columns; the preview draws it.',
  )
})

test('a preview page cleaned away is written again before it is opened', async ($, on) => {
  const { runs, written } = host(on)
  const ui = await $.ui.mount(message(FENCE, 'msg-page-gone'))
  await ui.press({ key: 'preview-1' })
  const path = previewIn(written)?.[0] ?? ''
  written.delete(path)
  await ui.press({ key: 'preview-1' })
  expect(written.has(path)).toBe(true)
  expect(renders(runs, 'svg')).toHaveLength(2)
  expect(runs.at(-1)?.argv).toEqual(['open', path])
  await ui.unmount()
})

test('a preview cut short is drawn again at the next click, not kept as a failure', async ($, on) => {
  const { written, toasts } = host(on, { svgAbortFirst: 1 })
  const ui = await $.ui.mount(message(FENCE, 'msg-cut'))
  await ui.press({ key: 'preview-1' })
  expect(toasts.some(t => t.startsWith('Could not open the diagram'))).toBe(true)
  await ui.press({ key: 'preview-1' })
  const page = previewIn(written)?.[1]
  expect(page).toContain('<svg id="merman">')
  expect(page).not.toContain('could not draw')
  await ui.unmount()
})

test("a background read that fails keeps the one last read, so the picture's shade doesn't change", async ($, on) => {
  const { runs } = host(on, { theme: 'dark', ghosttyBackground: '#1f1f1f', ghosttyAnswers: 1 })
  const clock = mock.clock(on)
  const first = await $.ui.mount(message(FENCE, 'msg-bg-1'))
  await clock.advance(0)
  await first.unmount()
  await clock.advance(11_000)
  const second = await $.ui.mount(message(FENCE.replace('Hello', 'Bye'), 'msg-bg-2'))
  await clock.advance(0)
  await second.unmount()
  expect(runs.filter(r => r.argv[1] === '+show-config')).toHaveLength(2)
  const pngs = renders(runs, 'png')
  expect(pngs.length).toBeGreaterThanOrEqual(2)
  for (const png of pngs) expect(png.argv).toContainEqual(expect.stringMatching(/-dark-1f1f1f(-turned)?\.png$/))
})

test("without merman-cli the terminal's background is never read", async ($, on) => {
  const { runs } = host(on, { hasMerman: false, ghosttyBackground: '#1f1f1f' })
  const ui = await $.ui.mount(message(FENCE, 'msg-bg-none'))
  await ui.unmount()
  expect(runs.some(r => r.argv[1] === '+show-config')).toBe(false)
})

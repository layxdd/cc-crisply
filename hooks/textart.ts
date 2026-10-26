// Box art for the kinds merman-cli draws none for, from the diagram's own
// source: a pie chart as bars, a mindmap as a tree.

import { textWidth, wrap } from './layout'

// A bar's last cell, in eighths of a cell.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
// The narrowest bar or tree label worth drawing; narrower is left to code.
const MIN_BAR = 4
const MIN_LABEL = 8
// What share of the room a pie's labels take at most.
const LABEL_SHARE = 0.35

// The source's lines after its front matter, without comments or blank lines.
export function linesOf(source: string): string[] {
  return source
    .replace(/^\s*---\n[\s\S]*?\n---[ \t]*\n/, '')
    .split('\n')
    .filter(line => line.trim() !== '' && !line.trim().startsWith('%%'))
}

// `text` cut to `width` cells, an ellipsis ending one that was cut.
function fit(text: string, width: number): string {
  if (textWidth(text) <= width) return text
  let cut = ''
  for (const c of Array.from(text)) {
    if (textWidth(`${cut}${c}…`) > width) break
    cut += c
  }

  return `${cut}…`
}

// A number as a pie's legend shows it: no more than two decimals.
const shown = (n: number) => String(Math.round(n * 100) / 100)

// A pie chart as one bar a slice, in its order, the largest the bar's full
// width, each with its share (and its value, for `showData`), under its title.
export function pieArtOf(source: string, room: number): string | undefined {
  const [header = '', ...body] = linesOf(source)
  const head = /^\s*pie\b(\s+showData\b)?(?:\s+title\s+(.*))?\s*$/.exec(header)
  if (head === null) return undefined
  const isShowData = head[1] !== undefined
  let title = head[2]?.trim()
  const slices: { label: string; value: number }[] = []
  let isDescribing = false
  for (const line of body) {
    const text = line.trim()
    // A multi-line `accDescr { … }`, skipped.
    if (isDescribing || /^accDescr\s*\{/.test(text)) {
      isDescribing = !text.includes('}')
      continue
    }
    if (/^acc(Title|Descr)\s*:/.test(text)) continue
    const named = /^title\s+(.*)$/.exec(text)
    if (named !== null) {
      title = named[1]?.trim()
      continue
    }
    const slice = /^"([^"]*)"\s*:\s*(\d+(?:\.\d+)?)$/.exec(text)
    if (slice === null) return undefined
    slices.push({ label: slice[1] ?? '', value: Number(slice[2]) })
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  const largest = Math.max(0, ...slices.map(s => s.value))
  if (slices.length === 0 || total === 0) return undefined

  const tails = slices.map(s => {
    const share = `${((s.value / total) * 100).toFixed(1)}%`

    return isShowData ? `${share} (${shown(s.value)})` : share
  })
  const tailWidth = Math.max(...tails.map(textWidth))
  const labelWidth = Math.min(Math.max(...slices.map(s => textWidth(s.label))), Math.floor(room * LABEL_SHARE))
  const barWidth = room - labelWidth - tailWidth - 2
  if (barWidth < MIN_BAR) return undefined
  const rows = slices.map((s, k) => {
    const label = fit(s.label, labelWidth)
    const eighths = Math.round((s.value / largest) * barWidth * 8)
    const bar = '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '')
    const tail = tails[k] ?? ''

    return [
      label + ' '.repeat(labelWidth - textWidth(label)),
      bar + ' '.repeat(barWidth - textWidth(bar)),
      ' '.repeat(tailWidth - textWidth(tail)) + tail,
    ].join(' ')
  })

  return [...(title === undefined || title === '' ? [] : [fit(title, room)]), ...rows].join('\n')
}

// The shapes a mindmap node's text is written in, outermost first, after an
// optional id: `((x))`, `))x((`, `{{x}}`, `)x(`, `(x)` and `[x]`.
const SHAPES = [
  /^[^\s()[\]{}]*\(\((.*)\)\)$/,
  /^[^\s()[\]{}]*\)\)(.*)\(\($/,
  /^[^\s()[\]{}]*\{\{(.*)\}\}$/,
  /^[^\s()[\]{}]*\)(.*)\($/,
  /^[^\s()[\]{}]*\((.*)\)$/,
  /^[^\s()[\]{}]*\[(.*)\]$/,
]

// A mindmap node's label: its text out of its shape, its class, its quotes
// and backticks and markdown marks, `<br>` a space.
function labelOf(text: string): string {
  const bare = text.replace(/:::.*$/, '').trim()
  const inner = SHAPES.map(shape => shape.exec(bare)?.[1]).find(found => found !== undefined) ?? bare

  return inner
    .trim()
    .replace(/^"`?|`?"$/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*|__/g, '')
    .trim()
}

type Node = { label: string; children: Node[] }

// A mindmap as a tree, `├──` and `└──` its branches by their indent, each
// label wrapped to the room beside its branches.
export function mindmapArtOf(source: string, room: number): string | undefined {
  const [header = '', ...body] = linesOf(source)
  if (!/^\s*mindmap\s*$/.test(header)) return undefined
  let root: Node | undefined
  const stack: { indent: number; node: Node }[] = []
  for (const line of body) {
    const text = line.trim()
    // An icon or a class, for the node above it.
    if (text.startsWith('::icon(') || text.startsWith(':::')) continue
    const indent = line.length - line.trimStart().length
    const node: Node = { label: labelOf(text), children: [] }
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.node ?? root
    if (parent === undefined) root = node
    else parent.children.push(node)
    stack.push({ indent, node })
  }
  if (root === undefined) return undefined

  const lines: string[] = []
  // A node's label beside `branch`, its later lines beside `after`, then its
  // children beside `under`; false where a label has too little room.
  const draw = (node: Node, branch: string, after: string, under: string): boolean => {
    const space = room - textWidth(branch)
    if (space < MIN_LABEL) return false
    wrap(node.label || ' ', space).forEach((part, k) => {
      lines.push(`${k === 0 ? branch : after}${part}`)
    })

    return node.children.every((child, k) => {
      const isLast = k === node.children.length - 1
      const gap = `${under}${isLast ? '    ' : '│   '}`

      return draw(child, `${under}${isLast ? '└── ' : '├── '}`, gap, gap)
    })
  }

  return draw(root, '', '', '') ? lines.map(line => line.trimEnd()).join('\n') : undefined
}

// A room wider than any terminal, to tell a kind the plugin draws from one
// it doesn't.
const WIDE_ROOM = 1000

// The plugin's own box art for a kind merman-cli draws none for, at most
// `room` columns wide, or `isTooNarrow` where the room is too narrow for it;
// undefined for any other kind.
export function artOf(source: string, room: number): { text: string } | { isTooNarrow: true } | undefined {
  const [header = ''] = linesOf(source)
  const draw = /^\s*pie\b/.test(header) ? pieArtOf : /^\s*mindmap\s*$/.test(header) ? mindmapArtOf : undefined
  if (draw === undefined) return undefined
  const art = draw(source, room)
  if (art !== undefined) return { text: art }

  return draw(source, WIDE_ROOM) === undefined ? undefined : { isTooNarrow: true }
}

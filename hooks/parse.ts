// Splits a reply's markdown into the parts drawn differently: prose (left to
// the engine's own Markdown), fenced code, and GFM tables, those in a block
// quote included.

export type Align = 'left' | 'right' | 'center'

export type Prose = { kind: 'prose'; text: string }
export type CodeBlock = {
  kind: 'code'
  language: string
  source: string
  // True while the closing fence has not streamed in yet.
  isOpen: boolean
}
export type Table = {
  kind: 'table'
  header: string[]
  align: Align[]
  rows: string[][]
  raw: string
}
// A block quote that holds code or a table: its parts, quotes of its own
// among them, drawn behind one bar.
export type Quote = { kind: 'quote'; parts: Segment[] }
export type Segment = Prose | CodeBlock | Table | Quote

// The segments with every fence in them closed, quotes' included.
const closeFences = (segments: Segment[]): Segment[] =>
  segments.map(seg =>
    seg.kind === 'code'
      ? { ...seg, isOpen: false }
      : seg.kind === 'quote'
        ? { ...seg, parts: closeFences(seg.parts) }
        : seg,
  )

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const QUOTE = /^ {0,3}>/
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)

  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && (body[i + 1] === '|' || body[i + 1] === '`')) {
      // An escaped backtick is a literal one and opens no code span.
      cell += body[i + 1] === '|' ? '|' : '\\`'
      i++
    } else if (ch === '`') {
      // A code span closes on a run of exactly as many backticks; one that
      // never closes is literal backticks. Pipes inside a span stay in it.
      let run = 1
      while (body[i + run] === '`') run++
      const end = closingRun(body, i + run, run)
      const span = body.slice(i, end === -1 ? i + run : end + run)
      cell += span.replace(/\\\|/g, '|')
      i += span.length - 1
    } else if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())

  return cells
}

// Where a run of exactly `run` backticks starts at or after `from`, or -1.
function closingRun(text: string, from: number, run: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '`') continue
    let length = 1
    while (text[i + length] === '`') length++
    if (length === run) return i
    i += length - 1
  }

  return -1
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'

  return 'left'
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i]
  const delim = lines[i + 1]
  if (head === undefined || delim === undefined) return false
  if (!head.includes('|') || !DELIMITER.test(delim) || !delim.includes('-')) {
    return false
  }
  const columns = splitRow(head).length
  if (columns !== splitRow(delim).length) return false
  // One column needs an outer pipe on both lines, or `text` over `---` is a
  // setext heading whose pipe sat inside a code span.
  const isPiped = (l: string) => /^\s*\||\|\s*$/.test(l)

  return columns > 1 || (isPiped(head) && isPiped(delim))
}

export function splitMarkdown(text: string): Segment[] {
  const lines = text.split('\n')
  const out: Segment[] = []
  let prose: string[] = []

  const flushProse = () => {
    const body = prose.join('\n')
    if (body.trim() !== '') out.push({ kind: 'prose', text: body.replace(/^\n+|\n+$/g, '') })
    prose = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (QUOTE.test(line)) {
      // A block quote's lines, one level of `>` off each. One that holds code
      // or a table is split into its parts, to draw behind one bar; any other
      // is prose, for Claude Code to draw.
      let j = i
      while (j < lines.length && QUOTE.test(lines[j] ?? '')) j++
      const inner = splitMarkdown(
        lines
          .slice(i, j)
          .map(l => l.replace(/^ {0,3}> ?/, ''))
          .join('\n'),
      )
      if (inner.every(seg => seg.kind === 'prose')) {
        prose.push(...lines.slice(i, j))
        i = j
        continue
      }
      flushProse()
      // The quote's end closes a fence still open in it, unless the reply
      // ends there and may yet stream more.
      out.push({ kind: 'quote', parts: j === lines.length ? inner : closeFences(inner) })
      i = j
      continue
    }

    const fence = FENCE.exec(line)

    if (fence) {
      const indent = (fence[1] ?? '').length
      const marker = fence[2] ?? '```'
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
      const body: string[] = []
      let j = i + 1
      let isOpen = true
      while (j < lines.length) {
        if (close.test(lines[j] ?? '')) {
          isOpen = false
          break
        }
        // CommonMark takes the fence's own indent off each line inside it.
        body.push((lines[j] ?? '').replace(new RegExp(`^ {0,${indent}}`), ''))
        j++
      }
      flushProse()
      out.push({ kind: 'code', language: (fence[3] ?? '').toLowerCase(), source: body.join('\n'), isOpen })
      i = j + 1
      continue
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1] ?? '').map(alignOf)
      const rows: string[][] = []
      let j = i + 2
      // A row is any line with a pipe, up to a blank line or another block's
      // start: a quote or a fence.
      const isRow = (l: string) => l.includes('|') && l.trim() !== '' && !QUOTE.test(l) && !FENCE.test(l)
      while (j < lines.length && isRow(lines[j] ?? '')) {
        const cells = splitRow(lines[j] ?? '')
        // GFM pads short rows and drops cells past the header's count.
        rows.push(header.map((_, k) => cells[k] ?? ''))
        j++
      }
      flushProse()
      out.push({ kind: 'table', header, align, rows, raw: lines.slice(i, j).join('\n') })
      i = j
      continue
    }

    prose.push(line)
    i++
  }
  flushProse()

  return out
}

// Prose with each ATX heading's marks kept in its text (`## Title` reads
// `## \#\# Title`), so the heading still draws in the heading style and
// shows the marks the renderer would drop. Prose holds no fences, which
// splitMarkdown takes out as code.
export function showHeadingMarks(prose: string): string {
  return prose.replace(
    /^( {0,3})(#{1,6})([ \t]+)(?=\S)/gm,
    (_, indent: string, marks: string, gap: string) => `${indent}${marks}${gap}${marks.replace(/#/g, '\\#')} `,
  )
}

// Prose with each code span's backticks kept in its text (`x` reads
// `` `x` ``), so Claude Code draws them, in the code color, around the code
// it would draw bare. A span is closed on its line; a line four spaces in
// that opens no list item is left as written, and so is indented code: a
// block four spaces in after a blank line, outside a list, even one that
// reads like a list item.
export function showCodeTicks(prose: string): string {
  const show = (line: string) => {
    let out = ''
    for (let i = 0; i < line.length; ) {
      const ch = line[i] ?? ''
      if (ch === '\\') {
        out += line.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch !== '`') {
        out += ch
        i++
        continue
      }
      let run = 1
      while (line[i + run] === '`') run++
      const end = closingRun(line, i + run, run)
      if (end === -1) {
        out += '`'.repeat(run)
        i += run
        continue
      }
      const raw = line.slice(i + run, end)
      const shown = `\`${/^ .* $/.test(raw) && raw.trim() !== '' ? raw.slice(1, -1) : raw}\``
      // A run longer than any inside, padded so the code's own ticks show.
      const ticks = '`'.repeat(Math.max(...(shown.match(/`+/g) ?? []).map(r => r.length)) + 1)
      out += `${ticks} ${shown} ${ticks}`
      i = end + run
    }

    return out
  }

  // Whether the line before was blank (or there is none), the last line in a
  // list, and the last in indented code.
  let wasBlank = true
  let inList = false
  let isCode = false

  return prose
    .split('\n')
    .map(line => {
      if (line.trim() === '') {
        wasBlank = true
        return line
      }
      const tabbed = line.replace(/^\t/, '    ')
      const isIndented = /^ {4}/.test(tabbed)
      const isItem = LIST_ITEM.test(tabbed)
      const isBlankBefore = wasBlank
      wasBlank = false
      isCode = isIndented && (isCode || (isBlankBefore && !inList))
      if (isCode) return line
      if (isItem) inList = true
      else if (!isIndented && isBlankBefore) inList = false

      return isIndented && !isItem ? line : show(line)
    })
    .join('\n')
}

// Inline markdown as the plugin draws it: text, code spans, emphasis, links.
export type Inline =
  | string
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

// A run of `*`, `_` or `~` waiting to be paired, CommonMark's delimiter.
type Delimiter = { kind: 'delimiter'; char: string; count: number; length: number; canOpen: boolean; canClose: boolean }
type Node = Inline | Delimiter

const LINK = /^!?\[([^\]]+)\]\(([^)\s]+)\)/
const isSpace = (ch: string | undefined) => ch === undefined || /\s/u.test(ch)
const isPunct = (ch: string | undefined) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch)

// Parses inline markdown as CommonMark does: code spans, escapes and links
// first, then `*`/`_` emphasis and GFM `~~` strikethrough paired by their
// delimiter runs, so `***both***`, `*a **b** c*` and `snake_case` come out
// right.
export function parseInline(text: string): Inline[] {
  const nodes: Node[] = []
  const pushText = (part: string) => {
    const last = nodes[nodes.length - 1]
    if (typeof last === 'string') nodes[nodes.length - 1] = last + part
    else if (part !== '') nodes.push(part)
  }

  for (let i = 0; i < text.length; ) {
    const ch = text[i] ?? ''
    if (ch === '\\' && isPunct(text[i + 1])) {
      pushText(text[i + 1] ?? '')
      i += 2
    } else if (ch === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const end = closingRun(text, i + run, run)
      if (end === -1) {
        pushText('`'.repeat(run))
      } else {
        const code = text.slice(i + run, end)
        nodes.push({ kind: 'code', text: /^ .* $/.test(code) && code.trim() !== '' ? code.slice(1, -1) : code })
      }
      i = end === -1 ? i + run : end + run
    } else if ((ch === '[' || (ch === '!' && text[i + 1] === '[')) && LINK.test(text.slice(i))) {
      const [whole = '', label = '', href = ''] = LINK.exec(text.slice(i)) ?? []
      nodes.push({ kind: 'link', href, children: parseInline(label) })
      i += whole.length
    } else if (ch === '*' || ch === '_' || ch === '~') {
      let length = 1
      while (text[i + length] === ch) length++
      const before = text[i - 1]
      const after = text[i + length]
      // CommonMark's flanking rules: which runs may open, which may close.
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before))
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after))
      const canOpen = ch === '_' ? left && (!right || isPunct(before)) : left
      const canClose = ch === '_' ? right && (!left || isPunct(after)) : right
      if (ch === '~' && length !== 2) pushText('~'.repeat(length))
      else nodes.push({ kind: 'delimiter', char: ch, count: length, length, canOpen, canClose })
      i += length
    } else {
      pushText(ch)
      i++
    }
  }

  return finish(pairDelimiters(nodes))
}

// CommonMark's "process emphasis": each closer takes the nearest opener of
// its kind before it, two from each for strong when both have two, and
// wraps what lies between.
function pairDelimiters(nodes: Node[]): Node[] {
  const isDelimiter = (n: Node | undefined): n is Delimiter => typeof n === 'object' && n.kind === 'delimiter'
  for (let i = 0; i < nodes.length; ) {
    const closer = nodes[i]
    if (!isDelimiter(closer) || !closer.canClose || closer.count === 0) {
      i++
      continue
    }
    let j = i - 1
    for (; j >= 0; j--) {
      const opener = nodes[j]
      if (!isDelimiter(opener) || !opener.canOpen || opener.count === 0 || opener.char !== closer.char) continue
      if (closer.char === '~') {
        if (opener.count === closer.count) break
        continue
      }
      // The rule of three: a run that can both open and close does not pair
      // when the two lengths add up to a multiple of three, unless both are.
      const isBoth = opener.canClose || closer.canOpen
      const sum = opener.length + closer.length
      if (isBoth && sum % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0)) continue
      break
    }
    const opener = nodes[j]
    if (j < 0 || !isDelimiter(opener)) {
      i++
      continue
    }
    const use = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1
    const kind = closer.char === '~' ? 'strike' : use === 2 ? 'strong' : 'em'
    opener.count -= use
    closer.count -= use
    nodes.splice(j + 1, i - j - 1, { kind, children: finish(nodes.slice(j + 1, i)) })
    // The closer now sits right after the new node; one with some of its run
    // left looks for another opener.
    i = closer.count > 0 ? j + 2 : j + 3
  }

  return nodes
}

// What is left of unpaired delimiters is text; neighbouring text is joined.
function finish(nodes: Node[]): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    const part: Inline = typeof n === 'object' && n.kind === 'delimiter' ? n.char.repeat(n.count) : n
    const last = out[out.length - 1]
    if (typeof part === 'string' && typeof last === 'string') out[out.length - 1] = last + part
    else if (part !== '') out.push(part)
  }

  return out
}

// Parsed inline markdown as the plain text it shows.
export function plainText(parts: Inline[]): string {
  return parts.map(p => (typeof p === 'string' ? p : p.kind === 'code' ? p.text : plainText(p.children))).join('')
}

// Inline markdown as plain text: what a table cell shows and copies.
export function plainInline(cell: string): string {
  return plainText(parseInline(cell.replace(/<br\s*\/?>/gi, ' ')))
}

// A part of a reply's prose: one the plugin draws, for a heading's color, a
// task's box or strikethrough, or a run handed to Claude Code as written.
export type ProseBlock =
  | { kind: 'engine'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'rule' }

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
// A thematic break: a line of three or more `-`, `*` or `_`, which is a divider
// unless a paragraph above it makes it a setext underline.
const THEMATIC = /^ {0,3}([-*_])( *\1){2,} *$/
// Lines the plugin leaves to Claude Code wherever they sit: a rule, a setext
// underline, HTML, a link reference. (A block opening four spaces in is an
// indented code block, also left; inside a list that indent is nesting.)
const UNSUPPORTED = new RegExp(`${THEMATIC.source}|^ {0,3}(=+|-+) *$|^ {0,3}<|^ {0,3}\\[[^\\]]+\\]:`)
// One item of a list: its depth by indent, its marker as Claude Code draws
// it, and for a task list item whether its box is ticked.
export type ListItem = { depth: number; marker: string; text: string; task?: 'open' | 'done' }

// What the plugin styles: strikethrough (which Claude Code leaves as written)
// or a task list item. Every heading too, for its color. Code spans, bold and
// links alone are Claude Code's to draw.
const STYLED = /~~|^ *([-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]/m

// Cuts prose into paragraphs, headings, lists and quotes. Headings, and the
// others that hold something STYLED, the plugin draws; every other run, and
// anything it does not model, goes to Claude Code whole and as written.
// With `isOwn`, every block is the plugin's to draw, those it would leave to
// Claude Code as paragraphs: for prose in a quote the plugin draws.
export function splitProse(prose: string, isOwn = false): ProseBlock[] {
  // A leading tab indents as four spaces, so a list nested with tabs nests.
  const lines = prose.split('\n').map(l => l.replace(/^[ \t]+/, lead => lead.replace(/\t/g, '    ')))
  const raw: { lines: string[]; kind: 'paragraph' | 'heading' | 'quote' | 'list' | 'rule' }[] = []
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      raw.push({ lines: [line], kind: 'paragraph' })
      i++
      continue
    }
    if (THEMATIC.test(line)) {
      raw.push({ lines: [line], kind: 'rule' })
      i++
      continue
    }
    const kind = HEADING.test(line)
      ? 'heading'
      : /^ {0,3}>/.test(line)
        ? 'quote'
        : LIST_ITEM.test(line)
          ? 'list'
          : 'paragraph'
    const block = { lines: [line], kind } as (typeof raw)[number]
    i++
    if (kind !== 'heading') {
      // A block runs to a blank line, a heading, or another kind's start.
      while (i < lines.length) {
        const next = lines[i] ?? ''
        if (next.trim() === '' || HEADING.test(next)) break
        if (kind === 'quote' && !/^ {0,3}>/.test(next)) break
        if (kind === 'paragraph' && (/^ {0,3}>/.test(next) || LIST_ITEM.test(next))) break
        if (kind === 'list' && startsOtherList(line, next)) break
        block.lines.push(next)
        i++
      }
    }
    raw.push(block)
  }

  const out: ProseBlock[] = []
  const toEngine = (text: string) => {
    const last = out[out.length - 1]
    if (last?.kind === 'engine') last.text += `\n${text}`
    else out.push({ kind: 'engine', text })
  }
  for (const block of raw) {
    if (block.kind === 'rule') {
      out.push({ kind: 'rule' })
      continue
    }
    const text = block.lines.join('\n')
    const isBlank = text.trim() === ''
    const isIndentedCode = block.kind === 'paragraph' && /^ {4}/.test(block.lines[0] ?? '')
    if (
      isBlank ||
      (!isOwn &&
        (isIndentedCode ||
          (block.kind !== 'heading' && !STYLED.test(text)) ||
          block.lines.some(l => UNSUPPORTED.test(l))))
    ) {
      toEngine(text)
      continue
    }
    if (block.kind === 'heading') {
      const [, marks = '#', title = ''] = HEADING.exec(text) ?? []
      out.push({ kind: 'heading', level: marks.length, text: `${marks} ${title}` })
    } else if (block.kind === 'quote') {
      const body = block.lines.map(l => l.replace(/^ {0,3}> ?/, ''))
      if (body.some(l => /^ {0,3}>/.test(l) || LIST_ITEM.test(l) || HEADING.test(l))) toEngine(text)
      else out.push({ kind: 'quote', text: body.map(l => l.trim()).join('\n') })
    } else if (block.kind === 'list') {
      out.push({ kind: 'list', items: listItems(block.lines) })
    } else {
      out.push({ kind: 'paragraph', text: block.lines.map(l => l.trim()).join('\n') })
    }
  }

  // The runs left to Claude Code lose the blank lines at their edges, which
  // the parts' own spacing stands for.
  return out
    .map(b => (b.kind === 'engine' ? { ...b, text: b.text.replace(/^\n+|\n+$/g, '') } : b))
    .filter(b => b.kind !== 'engine' || b.text.trim() !== '')
    .map(b => (isOwn && b.kind === 'engine' ? { kind: 'paragraph', text: b.text.trim() } : b))
}

// Whether `next` opens a list of the other type (bullets after numbers, or
// numbers after bullets) at or left of `first`'s indent: a new list.
function startsOtherList(first: string, next: string): boolean {
  const [, indent = '', marker = ''] = LIST_ITEM.exec(first) ?? []
  const [, nextIndent, nextMarker = ''] = LIST_ITEM.exec(next) ?? []
  if (nextIndent === undefined || nextIndent.length > indent.length) return false

  return /^\d/.test(marker) !== /^\d/.test(nextMarker)
}

// A list's items, each with its depth by indent and its marker as Claude Code
// draws it: `-` for every bullet, and an ordered list numbered on from its
// first item. A line that opens no item continues the one before.
function listItems(lines: string[]): ListItem[] {
  const items: ListItem[] = []
  const indents: number[] = []
  const counts: number[] = []
  for (const line of lines) {
    const m = LIST_ITEM.exec(line)
    if (m === null) {
      const last = items[items.length - 1]
      if (last !== undefined) last.text += `\n${line.trim()}`
      continue
    }
    const [, spaces = '', bullet = '-', text = ''] = m
    while (indents.length > 0 && spaces.length < (indents[indents.length - 1] ?? 0)) {
      indents.pop()
      counts.pop()
    }
    if (indents.length === 0 || spaces.length > (indents[indents.length - 1] ?? 0)) {
      indents.push(spaces.length)
      counts.push(/^\d/.test(bullet) ? Number.parseInt(bullet, 10) : 0)
    } else {
      counts[counts.length - 1] = (counts[counts.length - 1] ?? 0) + 1
    }
    const depth = indents.length - 1
    const marker = /^\d/.test(bullet) ? `${counts[depth]}.` : '-'
    // A task list item: `[ ]` or `[x]` before its text.
    const task = /^\[([ xX])\][ \t]+(.*)$/.exec(text.trim())
    if (task === null) items.push({ depth, marker, text: text.trim() })
    else items.push({ depth, marker, text: task[2] ?? '', task: task[1] === ' ' ? 'open' : 'done' })
  }

  return items
}

// The table as CSV (RFC 4180): a cell with a comma, quote or line break is
// quoted, its quotes doubled.
export function tableAsCsv(table: Table): string {
  const field = (cell: string) => {
    const text = plainInline(cell)

    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const line = (cells: string[]) => cells.map(field).join(',')

  return [line(table.header), ...table.rows.map(line)].join('\n')
}

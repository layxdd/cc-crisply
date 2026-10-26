// Measures and wraps text in terminal cells, and fits a table to the
// terminal's width: column widths, wrapped cell lines.

import type { Align, Table } from './parse'
import { plainInline } from './parse'

// Cells a character takes: two for East Asian wide and most emoji, zero for
// combining marks and joiners, one otherwise.
function charWidth(cp: number): number {
  if (cp === 0x200d || cp === 0x20e3 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    WIDE_EMOJI.has(cp)
  ) {
    return 2
  }

  return 1
}

// Emoji outside the blocks above that draw two wide by default (Unicode's
// East Asian Width W): ✅ ❌ ⭐ ⚡ ⌛ ☕ and the like.
const WIDE_EMOJI = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2649,
  0x264a, 0x264b, 0x264c, 0x264d, 0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa,
  0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705,
  0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf,
  0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x1f004, 0x1f0cf, 0x1f18e, 0x1f191, 0x1f192, 0x1f193, 0x1f194, 0x1f195, 0x1f196,
  0x1f197, 0x1f198, 0x1f199, 0x1f19a, 0x1f201, 0x1f21a, 0x1f22f, 0x1f232, 0x1f233, 0x1f234, 0x1f235, 0x1f236, 0x1f238,
  0x1f239, 0x1f23a, 0x1f250, 0x1f251,
])

// The characters of `text` grouped as the terminal draws them: each with the
// marks and selectors after it, an emoji with its skin tone, and the emoji a
// joiner (U+200D) ties on (`👨‍👩‍👧`). A narrow symbol followed by U+FE0F (`⚠️`)
// turns into a two-cell emoji.
function clusters(text: string): { text: string; width: number }[] {
  const out: { text: string; width: number }[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const width = charWidth(cp)
    const last = out[out.length - 1]
    const isJoined =
      last !== undefined && (last.text.endsWith('\u200d') || (last.width === 2 && cp >= 0x1f3fb && cp <= 0x1f3ff))
    if (last !== undefined && (width === 0 || isJoined)) {
      last.text += ch
      if (cp === 0xfe0f && last.width === 1) last.width = 2
    } else {
      out.push({ text: ch, width })
    }
  }

  return out
}

export function textWidth(text: string): number {
  let width = 0
  for (const c of clusters(text)) width += c.width

  return width
}

// Cuts `text` into lines of at most `width` cells, at spaces where it can.
export function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width)
  const lines: string[] = []
  let line = ''
  let lineWidth = 0

  const push = () => {
    lines.push(line)
    line = ''
    lineWidth = 0
  }

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word)
    if (lineWidth > 0 && lineWidth + 1 + w <= max) {
      line += ` ${word}`
      lineWidth += 1 + w
      continue
    }
    if (lineWidth > 0) push()
    if (w <= max) {
      line = word
      lineWidth = w
      continue
    }
    for (const c of clusters(word)) {
      if (lineWidth + c.width > max) push()
      line += c.text
      lineWidth += c.width
    }
  }
  if (lineWidth > 0 || lines.length === 0) push()

  return lines
}

// Cuts `text` into lines of at most `width` cells wherever a cell runs out,
// its spaces kept, as code is wrapped.
export function hardWrap(text: string, width: number): string[] {
  const max = Math.max(1, width)
  const lines = ['']
  let lineWidth = 0
  for (const c of clusters(text)) {
    if (lineWidth + c.width > max) {
      lines.push('')
      lineWidth = 0
    }
    lines[lines.length - 1] += c.text
    lineWidth += c.width
  }

  return lines
}

// Cuts a line of `text` into lines of at most `width` cells at its spaces, as
// `wrap` does, but keeps its spaces as written: runs of them inside a line,
// and its indent, on each line it makes while that leaves half the width. A
// word too long for a line is cut wherever a cell runs out.
export function softWrap(text: string, width: number): string[] {
  const max = Math.max(1, width)
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  const indent = textWidth(lead) * 2 <= max ? lead : ''
  const lines: string[] = []
  let line = indent
  // Whether `line` holds no word yet, and the spaces before the next word.
  let isEmpty = true
  let gap = ''
  for (const token of text.slice(lead.length).split(/(\s+)/)) {
    if (token === '') continue
    if (/^\s/.test(token)) {
      gap = token
      continue
    }
    let next = isEmpty ? line + token : line + gap + token
    gap = ''
    if (!isEmpty && textWidth(next) > max) {
      lines.push(line)
      next = indent + token
    }
    const cut = hardWrap(next, max)
    lines.push(...cut.slice(0, -1))
    line = cut.at(-1) ?? ''
    isEmpty = false
  }
  lines.push(line)

  return lines
}

// A stretch of text in one style, the unit `wrapRuns` lays out.
export type Run<S> = { text: string; style: S }

// Lays styled runs out in lines of at most `width` cells, breaking at spaces
// where it can and at every newline. Text with no space between, across runs
// too (`foo` then `bar` written `foo`bar), stays on one line unless it alone
// is wider than a line. Neighbouring runs of one style (the same object) are
// joined.
export function wrapRuns<S>(runs: Run<S>[], width: number): Run<S>[][] {
  const max = Math.max(1, width)
  const lines: Run<S>[][] = []
  let line: Run<S>[] = []
  let lineWidth = 0
  let space: Run<S>[] = []
  let word: Run<S>[] = []

  const add = (run: Run<S>) => {
    const last = line[line.length - 1]
    if (last !== undefined && last.style === run.style) last.text += run.text
    else line.push({ ...run })
    lineWidth += textWidth(run.text)
  }
  const breakLine = () => {
    lines.push(line)
    line = []
    lineWidth = 0
  }
  const placeWord = () => {
    if (word.length === 0) return
    const wordWidth = word.reduce((sum, r) => sum + textWidth(r.text), 0)
    const spaceWidth = space.reduce((sum, r) => sum + textWidth(r.text), 0)
    if (lineWidth > 0 && lineWidth + spaceWidth + wordWidth > max) breakLine()
    else if (lineWidth > 0) space.forEach(add)
    if (wordWidth <= max - lineWidth) {
      word.forEach(add)
    } else {
      // Wider than a line: cut it wherever a cell runs out.
      for (const run of word) {
        for (const c of clusters(run.text)) {
          if (lineWidth + c.width > max) breakLine()
          add({ text: c.text, style: run.style })
        }
      }
    }
    word = []
    space = []
  }

  for (const run of runs) {
    for (const part of run.text.split(/(\n| +)/)) {
      if (part === '') continue
      if (part === '\n') {
        placeWord()
        space = []
        breakLine()
      } else if (part.startsWith(' ')) {
        placeWord()
        space.push({ text: part, style: run.style })
      } else {
        word.push({ text: part, style: run.style })
      }
    }
  }
  placeWord()
  breakLine()

  return lines
}

export function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - textWidth(text))
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)

    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }

  return text + ' '.repeat(gap)
}

const NUMERIC = /^[-+]?[$€£¥]?\(?[\d.,]+\)?%?[kKmMbB]?$/

export type TableLayout = {
  widths: number[]
  align: Align[]
  header: string[][]
  rows: string[][][]
}

// The space a table's frame takes besides its cells: a border between and
// around the columns, and one space of padding on each side of each cell.
export function frameWidth(columns: number): number {
  return columns + 1 + columns * 2
}

// Lays the table out within `room` cells, or returns undefined when even
// three cells a column (fewer for a column that needs fewer) would not fit;
// the caller then draws it as a list.
export function layoutTable(table: Table, room: number): TableLayout | undefined {
  const n = table.header.length
  const header = table.header.map(plainInline)
  const rows = table.rows.map(r => r.map(plainInline))
  const available = room - frameWidth(n)
  const natural = header.map((h, k) => Math.max(textWidth(h), ...rows.map(r => textWidth(r[k] ?? '')), 1))
  // The least a column takes: three cells, or fewer when it needs fewer.
  const least = natural.map(w => Math.min(w, 3))
  if (available < least.reduce((a, b) => a + b, 0)) return undefined

  const widths = [...natural]
  const total = natural.reduce((a, b) => a + b, 0)

  if (total > available) {
    // Every column gets an even share, capped by what it needs but never
    // under its least; what is left goes to the wide columns in proportion to
    // what they still lack.
    const share = Math.floor(available / n)
    for (let k = 0; k < n; k++) {
      widths[k] = Math.max(Math.min(natural[k] ?? 1, share), least[k] ?? 1)
    }
    let left = available - widths.reduce((a, b) => a + b, 0)
    const lacks = natural.map((w, k) => w - (widths[k] ?? 0))
    const lackTotal = lacks.reduce((a, b) => a + b, 0)
    for (let k = 0; k < n && lackTotal > 0; k++) {
      const extra = Math.floor(((lacks[k] ?? 0) / lackTotal) * left)
      widths[k] = (widths[k] ?? 0) + extra
    }
    left = available - widths.reduce((a, b) => a + b, 0)
    for (let k = 0; left > 0 && k < n; k++) {
      if ((widths[k] ?? 0) < (natural[k] ?? 0)) {
        widths[k] = (widths[k] ?? 0) + 1
        left--
      }
    }
  }

  // A column the model left unaligned whose body cells are all numbers is
  // set right, as a spreadsheet would.
  const align = table.align.map((a, k) => {
    const body = rows.map(r => r[k] ?? '').filter(c => c !== '')
    if (a === 'left' && body.length > 0 && body.every(c => NUMERIC.test(c))) return 'right'

    return a
  })

  return {
    widths,
    align,
    header: header.map((h, k) => wrap(h, widths[k] ?? 1)),
    rows: rows.map(r => r.map((c, k) => wrap(c, widths[k] ?? 1))),
  }
}

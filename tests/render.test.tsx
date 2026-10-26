import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { layoutTable, textWidth, wrap, wrapRuns } from '../hooks/layout'
import {
  parseInline,
  plainInline,
  showCodeTicks,
  showHeadingMarks,
  splitMarkdown,
  splitProse,
  splitRow,
  tableAsCsv,
} from '../hooks/parse'

const REPLY = [
  'Here is the fix:',
  '',
  '```ts',
  'const a = 1',
  'console.log(a)',
  '```',
  '',
  '| Name | Count |',
  '| --- | --- |',
  '| apples | 3 |',
  '| `pears` | 12 |',
  '',
  'Done.',
].join('\n')

const message = (text: string, requestId = 'msg-1') =>
  ({
    plugin: 'cc-crisply',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
    viewport: { columns: 80, rows: 40 },
  }) as const

// Stands for Claude Code's own drawing of a reply block: the bullet on the
// reply's first block, a blank gutter on the others, then the text.
const engine: TestBody = (_, on) => {
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`${e.props.isFirstOfReply ? '⏺' : ' '} ${e.props.text}`}</Text>
  })
}

test('a reply splits into prose, code and a table', () => {
  const parts = splitMarkdown(REPLY)
  expect(parts.map(p => p.kind)).toEqual(['prose', 'code', 'table', 'prose'])

  const code = parts[1]
  expect(code?.kind === 'code' && code.language).toBe('ts')
  expect(code?.kind === 'code' && code.source).toBe('const a = 1\nconsole.log(a)')

  const table = parts[2]
  expect(table?.kind === 'table' && tableAsCsv(table)).toBe('Name,Count\napples,3\npears,12')
})

test('a fence still streaming is code, marked open', () => {
  const parts = splitMarkdown('Start\n```py\nprint(1)')
  expect(parts[1]).toEqual({ kind: 'code', language: 'py', source: 'print(1)', isOpen: true })
})

test('pipes inside code spans and escaped pipes stay in their cell', () => {
  const parts = splitMarkdown('| a | b |\n|---|---|\n| `x|y` | c \\| d |')
  const table = parts[0]
  expect(table?.kind === 'table' && table.rows[0]).toEqual(['`x|y`', 'c | d'])
})

test('a wide table is fitted to the room and numbers are right-aligned', () => {
  const parts = splitMarkdown(`| Description | n |\n|---|---|\n| ${'word '.repeat(30)}| 42 |`)
  const table = parts[0]
  if (table?.kind !== 'table') throw new Error('no table')
  const layout = layoutTable(table, 40)
  expect(layout).toBeDefined()
  const widths = layout?.widths ?? []
  expect(widths.reduce((a, b) => a + b, 0) + 3 * widths.length + 1).toBeLessThanOrEqual(40)
  expect(layout?.align[1]).toBe('right')
  expect((layout?.rows[0]?.[0]?.length ?? 0) > 1).toBe(true)
})

test('wide characters count two cells', () => {
  expect(textWidth('日本')).toBe(4)
  expect(wrap('日本語のテキスト', 4)).toEqual(['日本', '語の', 'テキ', 'スト'])
})

test('a reply with only prose is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount(message('Just words, *leaning* ones.'))
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('code spans keep their backticks in the text Claude Code draws', async ($, on) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn.push(e.props.text)
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  const ui = await $.ui.mount(message('Run `npm test` and **ship**.'))
  expect(drawn).toEqual(['Run `` `npm test` `` and **ship**.'])
  await ui.unmount()
})

test('a code span shows its backticks: wrapped in a longer run, its own ticks kept', () => {
  expect(showCodeTicks('a `x` b')).toBe('a `` `x` `` b')
  expect(showCodeTicks('``a ` b``')).toBe('`` `a ` b` ``')
  expect(showCodeTicks('`` `x` ``')).toBe('``` ``x`` ```')
  // Escaped and unclosed ticks are not spans; indented code is left alone.
  expect(showCodeTicks('\\`a\\` and `open')).toBe('\\`a\\` and `open')
  expect(showCodeTicks('    code `a`')).toBe('    code `a`')
  expect(showCodeTicks('- item\n    - nested `a`')).toBe('- item\n    - nested `` `a` ``')
  expect(showCodeTicks('- item\n\n    - loose `a`')).toBe('- item\n\n    - loose `` `a` ``')
  // Indented code after a blank line, outside a list, is code even where it
  // reads like a list item.
  expect(showCodeTicks('Example:\n\n    - `x`\n\n    - `y`')).toBe('Example:\n\n    - `x`\n\n    - `y`')
  expect(showCodeTicks('    - `x`\nafter `z`')).toBe('    - `x`\nafter `` `z` ``')
})

test('code and tables get numbered copy buttons that copy their text', async ($, on) => {
  engine($, on)
  const copies: string[] = []
  on('ui.copy', (_, e) => {
    copies.push(e.text)

    return { value: { isCopied: true } }
  })

  const ui = await $.ui.mount(message(REPLY))
  expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(1)
  expect(await ui.find({ key: 'copy-1' })).toBeDefined()
  expect(await ui.find({ key: 'copy-2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /╭/ })).toBeDefined()
  // No block number, and no title over a table.
  expect(await ui.find({ type: 'Text', text: /#\d|table 2×2/ })).toBeUndefined()

  await ui.press({ key: 'copy-1' })
  await ui.press({ key: 'copy-2-csv' })
  expect(copies).toEqual(['const a = 1\nconsole.log(a)', 'Name,Count\napples,3\npears,12'])
  await ui.unmount()
})

test('identifiers and arithmetic in cells keep their underscores and stars', () => {
  expect(plainInline('`MAX_RETRY_COUNT`')).toBe('MAX_RETRY_COUNT')
  expect(plainInline('`__init__`')).toBe('__init__')
  expect(plainInline('my_file_name.py')).toBe('my_file_name.py')
  expect(plainInline('2 * 3 * 4')).toBe('2 * 3 * 4')
  expect(plainInline('`[a](b)` and \\*not em\\*')).toBe('[a](b) and *not em*')
  expect(plainInline('**bold**, *em*, _em_, __strong__, ~~gone~~')).toBe('bold, em, em, strong, gone')
  expect(plainInline('``a ` b``')).toBe('a ` b')
})

test('multi-backtick spans and stray backticks do not merge cells', () => {
  expect(splitRow('| `` ` `` | backtick key | yes |')).toEqual(['`` ` ``', 'backtick key', 'yes'])
  expect(splitRow('| it`s | b | c |')).toEqual(['it`s', 'b', 'c'])
  expect(splitRow('| \\`x | `y|z` |')).toEqual(['\\`x', '`y|z`'])
  const parts = splitMarkdown('| key ` | b |\n|---|---|\n| 1 | 2 |')
  expect(parts[0]?.kind).toBe('table')
})

test('a pipe in a code span over --- is a heading, not a table', () => {
  expect(splitMarkdown('Use `a|b` here\n---').map(p => p.kind)).toEqual(['prose'])
  expect(splitMarkdown('| only |\n| --- |\n| one |').map(p => p.kind)).toEqual(['table'])
})

test('emoji take two cells', () => {
  expect(textWidth('✅')).toBe(2)
  expect(textWidth('❌ ⭐ ⚡')).toBe(8)
  expect(textWidth('⚠️')).toBe(2)
  expect(wrap('⚠️⚠️⚠️', 4)).toEqual(['⚠️⚠️', '⚠️'])
})

test('an indented fence takes its indent off the lines inside it', () => {
  const parts = splitMarkdown('1. Install:\n   ```bash\n   npm i\n     --save\n   ```')
  const code = parts[1]
  expect(code?.kind === 'code' && code.source).toBe('npm i\n  --save')
})

test('many narrow columns stay a table when they fit', () => {
  const digits = Array.from({ length: 10 }, (_, k) => String(k))
  const parts = splitMarkdown(
    [`| ${digits.join(' | ')} |`, `|${'---|'.repeat(10)}`, `| ${digits.join(' | ')} |`].join('\n'),
  )
  const table = parts[0]
  if (table?.kind !== 'table') throw new Error('no table')
  expect(layoutTable(table, 54)?.widths).toEqual(Array(10).fill(1))
  expect(layoutTable(table, 30)).toBeUndefined()
})

test('a table has csv then md buttons with icons; the pressed one reads copied for a moment', async ($, on) => {
  engine($, on)
  const clock = mock.clock(on)
  on('ui.copy', () => ({ value: { isCopied: true } }))
  const ui = await $.ui.mount(message(REPLY))
  expect((await ui.find({ key: 'copy-1' }))?.text).toBe('[ ⧉ copy ]')
  const buttons = await ui.findAll({ type: 'Button', text: /csv|md/ })
  expect(buttons.map(b => b.text)).toEqual(['[ ⧉ csv ]', '[ ⧉ md ]'])
  await ui.press({ key: 'copy-2-csv' })
  expect((await ui.find({ key: 'copy-2-csv' }))?.text).toBe('[ ✓ copied ]')
  expect((await ui.find({ key: 'copy-2' }))?.text).toBe('[ ⧉ md ]')
  await clock.advance(1999)
  expect((await ui.find({ key: 'copy-2-csv' }))?.text).toBe('[ ✓ copied ]')
  await clock.advance(1)
  expect((await ui.find({ key: 'copy-2-csv' }))?.text).toBe('[ ⧉ csv ]')
  await ui.unmount()
})

test('a diff or patch fence is drawn by Claude Code, in its frame', async $ => {
  for (const [k, fence] of ['```diff\n-old\n+new\n same\n```', '```patch\n-old\n+new\n```'].entries()) {
    const ui = await $.ui.mount(message(fence, `msg-${k}`))
    expect((await ui.find({ type: 'Markdown' }))?.props).toEqual({ text: fence })
    expect(await ui.find({ key: 'copy-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('a block that turns back into prose loses its button; each message numbers its own', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  // Streamed up to here, the inline span reads as an open fence.
  const streaming = await $.ui.mount(message('Run\n```x', 'msg-a'))
  expect(await streaming.find({ key: 'copy-1' })).toBeDefined()
  await streaming.unmount()
  const done = await $.ui.mount(message('Run\n```x``` inline', 'msg-a'))
  expect(await done.find({ key: 'copy-1' })).toBeUndefined()
  await done.unmount()

  const next = await $.ui.mount(message(REPLY, 'msg-b'))
  expect(await next.find({ key: 'copy-1' })).toBeDefined()
  expect(await next.find({ key: 'copy-2' })).toBeDefined()
  expect(await next.find({ key: 'copy-3' })).toBeUndefined()
  await next.unmount()
})

test('Claude Code draws the prose and its bullet; a block opening a reply draws its own', async ($, on) => {
  const drawn: { text: string; isFirstOfReply: boolean }[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn.push({ text: e.props.text, isFirstOfReply: e.props.isFirstOfReply })
    const { Text } = $.ui.resolve(e)

    return <Text>{`${e.props.isFirstOfReply ? '⏺' : ' '} ${e.props.text}`}</Text>
  })

  const prose = await $.ui.mount(message(REPLY))
  expect(drawn).toEqual([
    { text: 'Here is the fix:', isFirstOfReply: true },
    { text: 'Done.', isFirstOfReply: false },
  ])
  expect(await prose.findAll({ type: 'Text', text: /⏺/ })).toHaveLength(1)
  await prose.unmount()

  const block = await $.ui.mount(message('```sh\nls\n```\nListed.', 'msg-2'))
  expect(await block.find({ type: 'Text', text: '⏺' })).toBeDefined()
  expect(drawn.at(-1)).toEqual({ text: 'Listed.', isFirstOfReply: false })
  await block.unmount()

  const later = await $.ui.mount({
    ...message('```sh\nls\n```', 'msg-3'),
    props: { text: '```sh\nls\n```', isFirstOfReply: false },
  })
  expect(await later.find({ type: 'Text', text: /⏺/ })).toBeUndefined()
  await later.unmount()
})

test('a code block opens on a header: its language, its copy button, a rule', async $ => {
  const ui = await $.ui.mount(message('```ts\nconst a = 1\n```'))
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).not.toMatch(/backgroundColor/)
  expect(tree).toMatch(
    /"borderStyle":"round".*"ts".*"copy-1".*"─+".*"type":"Markdown","props":\{"text":"```ts\\nconst a = 1\\n```"\}/,
  )
  await ui.unmount()
})

test('a fence keeps its own language name, and one with none gets a guess', async $ => {
  const trees: string[] = []
  for (const [k, fence] of [
    '```shell\nexport A=1\n```',
    '```\nnpm install\n```',
    '```\n{"a": 1}\n```',
    '```\njust words\n```',
    '```\n{ user { id } }\n```',
    '```\n[x for x in y]\n```',
    '```\n{"a": 1',
  ].entries()) {
    const ui = await $.ui.mount(message(fence, `msg-${k}`))
    trees.push(JSON.stringify(await ui.drawn()))
    await ui.unmount()
  }
  // The header names the language: the one fenced, as Claude Code
  // highlights it, or the one guessed.
  expect(trees[0]).toMatch(/"children":\["shell"\].*"text":"```shell\\nexport A=1\\n```"/)
  expect(trees[1]).toMatch(/"children":\["bash"\].*"text":"```bash\\nnpm install\\n```"/)
  expect(trees[2]).toMatch(/"children":\["json"\].*"text":"```json\\n/)
  expect(trees[3]).toMatch(/"children":\["text"\].*"text":"```\\njust words\\n```"/)
  // Brackets alone are not JSON: a GraphQL query, a comprehension.
  expect(trees[4]).toMatch(/"children":\["text"\]/)
  expect(trees[5]).toMatch(/"children":\["text"\]/)
  // Still streaming, JSON by how it opens.
  expect(trees[6]).toMatch(/"children":\["json"\]/)
})

test('code holding a fence is fenced with more backticks', async $ => {
  const ui = await $.ui.mount(message('````md\n```js\nx\n```\n````'))
  expect((await ui.find({ type: 'Markdown' }))?.props).toEqual({ text: '````md\n```js\nx\n```\n````' })
  await ui.unmount()
})

test('a table header is bold, in no color of its own', async $ => {
  const ui = await $.ui.mount(message('| Name | Count |\n| --- | --- |\n| apples | 3 |'))
  expect((await ui.find({ type: 'Text', text: /^Name/ }))?.props).toEqual({ bold: true })
  await ui.unmount()
})

test('a cell with a comma or quote is quoted in the csv', () => {
  const parts = splitMarkdown('| a | b |\n|---|---|\n| 1,5 | say "hi" |')
  const table = parts[0]
  expect(table?.kind === 'table' && tableAsCsv(table)).toBe('a,b\n"1,5","say ""hi"""')
})

test('headings keep their # marks in their text', () => {
  expect(showHeadingMarks('# Heading 1\n\ntext\n## Heading 2\n###### Six')).toBe(
    '# \\# Heading 1\n\ntext\n## \\#\\# Heading 2\n###### \\#\\#\\#\\#\\#\\# Six',
  )
  // Not headings: no space after the marks, seven marks, four spaces in, `#` alone.
  expect(showHeadingMarks('#tag\n####### seven\n    # code\n#')).toBe('#tag\n####### seven\n    # code\n#')
})

test("a heading is drawn with its marks in Claude orange; the plain prose after it is the engine's", async ($, on) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn.push(e.props.text)
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  const ui = await $.ui.mount(message('## Setup\nRun it.'))
  expect(drawn).toEqual(['Run it.'])
  expect(JSON.stringify(await ui.drawn())).toContain(
    '{"type":"Text","props":{"bold":true,"color":"claude"},"children":["## Setup"]}',
  )
  await ui.unmount()
})

test('inline markdown parses into code, strong, emphasis and links', () => {
  expect(parseInline('Run `npm test`, **all `ok`** and *then* [docs](https://a.b) \\*not\\* my_var')).toEqual([
    'Run ',
    { kind: 'code', text: 'npm test' },
    ', ',
    { kind: 'strong', children: ['all ', { kind: 'code', text: 'ok' }] },
    ' and ',
    { kind: 'em', children: ['then'] },
    ' ',
    { kind: 'link', href: 'https://a.b', children: ['docs'] },
    ' *not* my_var',
  ])
})

test('prose with strikethrough or a task box is drawn by the plugin, the rest left as written', () => {
  const prose = [
    'Plain opening.',
    '',
    'Run `npm test` **now** and see [docs](https://a.b).',
    '',
    'An ~~old~~ way.',
    '## Setup **fast**',
    '- use ~~foo~~',
    '- plain',
    '  - nested **b**',
    '1. first',
    '2. ~~second~~',
    '',
    '> quoted ~~q~~',
    '',
    'Setext ~~x~~',
    '---',
    '',
    'Plain closing.',
  ].join('\n')
  expect(splitProse(prose)).toEqual([
    // Code, bold and links alone are Claude Code's.
    { kind: 'engine', text: 'Plain opening.\n\nRun `npm test` **now** and see [docs](https://a.b).' },
    { kind: 'paragraph', text: 'An ~~old~~ way.' },
    { kind: 'heading', level: 2, text: '## Setup **fast**' },
    {
      kind: 'list',
      items: [
        { depth: 0, marker: '-', text: 'use ~~foo~~' },
        { depth: 0, marker: '-', text: 'plain' },
        { depth: 1, marker: '-', text: 'nested **b**' },
      ],
    },
    // A change from bullets to numbers starts a new list.
    {
      kind: 'list',
      items: [
        { depth: 0, marker: '1.', text: 'first' },
        { depth: 0, marker: '2.', text: '~~second~~' },
      ],
    },
    { kind: 'quote', text: 'quoted ~~q~~' },
    { kind: 'engine', text: 'Setext ~~x~~\n---\n\nPlain closing.' },
  ])
})

test('code light blue with its backticks, bold uncolored, ~~ dim and struck, links bright blue, as Claude Code draws them', async ($, on) => {
  engine($, on)
  const ui = await $.ui.mount(message('Run `npm test` and **check** ~~old~~ [docs](https://a.b).'))
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('{"type":"Text","props":{"color":"suggestion"},"children":["`npm test`"]}')
  expect(tree).toContain(
    '{"type":"Text","props":{"dimColor":true},"children":["~~"]},{"type":"Text","props":{"dimColor":true,"strikethrough":true},"children":["old"]},{"type":"Text","props":{"dimColor":true},"children":["~~"]}',
  )
  // The terminal draws an OSC 8 link's dashed underline itself.
  expect(tree).toContain(
    '{"type":"Text","props":{"color":"blueBright"},"children":[{"type":"Link","props":{"href":"https://a.b","label":"docs"}}]}',
  )
  expect(tree).not.toMatch(/"underline"|"hover"/)
  expect(tree).toContain('{"type":"Text","props":{"bold":true},"children":["check"]}')
  expect(await ui.find({ type: 'Text', text: '⏺' })).toBeDefined()
  await ui.unmount()
})

test('bold italic, nested emphasis and strikethrough pair as CommonMark does', () => {
  const both = { kind: 'em', children: [{ kind: 'strong', children: ['both'] }] }
  expect(parseInline('***both***')).toEqual([both])
  expect(parseInline('___both___')).toEqual([both])
  expect(parseInline('**_both_**')).toEqual([{ kind: 'strong', children: [{ kind: 'em', children: ['both'] }] }])
  expect(parseInline('*a **b** c*')).toEqual([
    { kind: 'em', children: ['a ', { kind: 'strong', children: ['b'] }, ' c'] },
  ])
  expect(parseInline('~~gone~~ and ~5 min')).toEqual([{ kind: 'strike', children: ['gone'] }, ' and ~5 min'])
  expect(parseInline('**bold `code`**')).toEqual([
    { kind: 'strong', children: ['bold ', { kind: 'code', text: 'code' }] },
  ])
  // Left as written: intraword underscores, spaced stars, unclosed runs.
  expect(parseInline('snake_case_name, 2 * 3 * 4, **open')).toEqual(['snake_case_name, 2 * 3 * 4, **open'])
})

test('task list items get boxes in the inline code color, a ticked one dim and struck', async ($, on) => {
  engine($, on)
  expect(splitProse('- [ ] todo\n- [x] done `x`')).toEqual([
    {
      kind: 'list',
      items: [
        { depth: 0, marker: '-', text: 'todo', task: 'open' },
        { depth: 0, marker: '-', text: 'done `x`', task: 'done' },
      ],
    },
  ])
  const ui = await $.ui.mount(message('- [ ] todo\n- [x] done'))
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain('{"type":"Text","props":{"color":"suggestion"},"children":["- [ ] "]}')
  expect(tree).toContain('{"type":"Text","props":{"color":"suggestion"},"children":["- [x] "]}')
  expect(tree).toContain('{"type":"Text","props":{"dimColor":true,"strikethrough":true},"children":["done"]}')
  expect(tree).not.toContain('~~')
  await ui.unmount()
})

test("copy buttons draw their own brackets in the links' blue", async ($, on) => {
  engine($, on)
  const ui = await $.ui.mount(message(REPLY))
  for (const key of ['copy-1', 'copy-2', 'copy-2-csv']) {
    expect((await ui.find({ key }))?.props).toMatchObject({ plain: true })
  }
  expect(JSON.stringify(await ui.drawn())).toContain(
    '{"type":"Text","props":{"color":"blueBright","bold":true},"children":["[ ⧉ copy ]"]}',
  )
  await ui.unmount()
})

test('a ticked task dims everything in its row, code, bold and links included', async ($, on) => {
  engine($, on)
  const ui = await $.ui.mount(message('- [x] run `npm test`, **ship** and [log](https://a.b)\n- [ ] keep `x`'))
  const tree = JSON.stringify(await ui.drawn())
  // Up to the open task's box, whose element opens before its text.
  const done = tree.slice(tree.indexOf('- [x]'), tree.lastIndexOf('{"type"', tree.indexOf('- [ ]')))
  expect(done).toContain('{"type":"Text","props":{"dimColor":true,"strikethrough":true},"children":["`npm test`"]}')
  expect(done).toContain(
    '{"type":"Text","props":{"dimColor":true,"strikethrough":true,"bold":true},"children":["ship"]}',
  )
  expect(done).toMatch(/"props":\{"dimColor":true,"strikethrough":true\},"children":\[\{"type":"Link"/)
  expect(done).not.toMatch(/"color":"(suggestion|blueBright)"/)
  // The open task keeps its colors.
  expect(tree.slice(tree.indexOf('- [ ]'))).toContain(
    '{"type":"Text","props":{"color":"suggestion"},"children":["`x`"]}',
  )
  await ui.unmount()
})

test('styled runs wrap at spaces, keep unspaced runs together, and break at newlines', () => {
  const a = { k: 'a' }
  const b = { k: 'b' }
  const text = (lines: { text: string }[][]) => lines.map(l => l.map(r => r.text).join(''))
  expect(text(wrapRuns([{ text: 'one two three', style: a }], 8))).toEqual(['one two', 'three'])
  // `foo` then `bar` with no space between stays on one line.
  expect(
    text(
      wrapRuns(
        [
          { text: 'xx foo', style: a },
          { text: 'bar', style: b },
        ],
        7,
      ),
    ),
  ).toEqual(['xx', 'foobar'])
  expect(text(wrapRuns([{ text: 'a\nb', style: a }], 10))).toEqual(['a', 'b'])
  expect(text(wrapRuns([{ text: 'abcdefghij', style: a }], 4))).toEqual(['abcd', 'efgh', 'ij'])
  // Neighbouring runs of one style join into one.
  expect(
    wrapRuns(
      [
        { text: 'x ', style: a },
        { text: 'y', style: a },
      ],
      10,
    ),
  ).toEqual([[{ text: 'x y', style: a }]])
})

test('strikethrough is styled in lists nested by two spaces, four, or a tab', () => {
  const nested = (text: string) => ({
    kind: 'list',
    items: [
      { depth: 0, marker: '-', text },
      { depth: 1, marker: '-', text: 'nested ~~a~~' },
    ],
  })
  expect(splitProse('- item\n  - nested ~~a~~')).toEqual([nested('item')])
  expect(splitProse('- item\n    - nested ~~a~~')).toEqual([nested('item')])
  expect(splitProse('- item\n\t- nested ~~a~~')).toEqual([nested('item')])
  expect(splitProse('1. step\n    - nested ~~a~~')).toEqual([
    {
      kind: 'list',
      items: [
        { depth: 0, marker: '1.', text: 'step' },
        { depth: 1, marker: '-', text: 'nested ~~a~~' },
      ],
    },
  ])
  // A block that opens four spaces in is still an indented code block.
  expect(splitProse('    code ~~a~~')).toEqual([{ kind: 'engine', text: '    code ~~a~~' }])
})

test('a block quote that holds code or a table is one segment, its parts inside', () => {
  expect(
    splitMarkdown('> Note:\n> ```ts\n> x\n> ```\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n> done\n\nafter'),
  ).toEqual([
    {
      kind: 'quote',
      parts: [
        { kind: 'prose', text: 'Note:' },
        { kind: 'code', language: 'ts', source: 'x', isOpen: false },
        {
          kind: 'table',
          header: ['a', 'b'],
          align: ['left', 'left'],
          rows: [['1', '2']],
          raw: '| a | b |\n|---|---|\n| 1 | 2 |',
        },
        { kind: 'prose', text: 'done' },
      ],
    },
    { kind: 'prose', text: 'after' },
  ])
  // A quote in a quote is a part of it; a quote of prose alone is left whole.
  expect(splitMarkdown('> > ```\n> > x\n> > ```')).toMatchObject([
    { kind: 'quote', parts: [{ kind: 'quote', parts: [{ kind: 'code' }] }] },
  ])
  expect(splitMarkdown('> just\n> words')).toEqual([{ kind: 'prose', text: '> just\n> words' }])
  // The quote's end closes its fences, nested ones too, unless the reply may
  // stream more.
  expect(splitMarkdown('> ```\n> x\nafter')[0]).toMatchObject({ parts: [{ isOpen: false }] })
  expect(splitMarkdown('> > ```\n> > x\nafter')[0]).toMatchObject({ parts: [{ parts: [{ isOpen: false }] }] })
  expect(splitMarkdown('> ```\n> x')[0]).toMatchObject({ parts: [{ isOpen: true }] })
})

test('a quote with a block is drawn whole behind one bar, its prose italic and its blocks framed', async ($, on) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    drawn.push(e.props.text)
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  const ui = await $.ui.mount(
    message('> Look `here`:\n> ```ts\n> const a = 1\n> ```\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n> - done\n\nAfter.'),
  )
  const tree = JSON.stringify(await ui.drawn())
  // Claude Code draws only the prose after the quote.
  expect(drawn).toEqual(['After.'])
  // One bar exactly as tall as the parts and the blank rows between them:
  // the prose a row, the code's frame five, the table six, the list one.
  expect(tree).not.toMatch(/"position":"absolute"|"overflow"/)
  const bar = /"children":\["(▎(?:\\n▎)*)"\]/.exec(tree)?.[1] ?? ''
  expect(bar.split('\\n')).toHaveLength(1 + 5 + 6 + 1 + 3)
  expect(tree).toMatch(/\{"type":"Box","props":\{"flexDirection":"column","gap":1\}/)
  expect(tree).toContain('{"type":"Text","props":{"italic":true},"children":["Look "]}')
  expect(tree).toContain('{"type":"Text","props":{"italic":true,"color":"suggestion"},"children":["`here`"]}')
  expect(tree).toMatch(/"borderStyle":"round".*"copy-1"/)
  expect(await ui.find({ key: 'copy-2-csv' })).toBeDefined()
  expect(tree).toContain('{"type":"Text","props":{"italic":true},"children":["done"]}')
  await ui.unmount()
})

test("the person's prompt is boxed on its own background, border too, its pointer in the border's place; a task's notification is not", async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`> ${e.props.text}`}</Text>
  })
  const prompt = (requestId: string, kind: 'composer' | 'task-notification', text = 'fix the bug') =>
    ({
      plugin: 'cc-crisply',
      surface: 'terminal',
      component: 'UserMessage',
      requestId,
      props: { text, origin: { kind }, isExpanded: false },
      viewport: { columns: 20, rows: 40 },
    }) as const
  const mine = await $.ui.mount(prompt('u-1', 'composer', 'fix the bug in the parser'))
  const rows = (await mine.findAll({ type: 'Text' })).map(t => t.text)
  expect(rows).toEqual([
    '╭──────────────────╮',
    '❯',
    ' fix the bug in   ',
    '│',
    '│',
    ' the parser       ',
    '│',
    '╰──────────────────╯',
  ])
  const tree = JSON.stringify(await mine.drawn())
  expect(tree).toContain(
    '{"type":"Text","props":{"color":"inactive","backgroundColor":"userMessageBackground"},"children":["❯"]}',
  )
  expect(tree).toContain(
    '{"type":"Text","props":{"color":"permission","backgroundColor":"userMessageBackground"},"children":["│"]}',
  )
  expect(tree).not.toContain('borderStyle')
  await mine.unmount()
  const task = await $.ui.mount(prompt('u-2', 'task-notification'))
  expect(JSON.stringify(await task.drawn())).not.toContain('╭')
  await task.unmount()
})

test(
  'with the prompt border setting off, Claude Code draws the prompt',
  { options: { promptBorder: false } },
  async ($, on) => {
    on('ui.render', { component: 'UserMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{`> ${e.props.text}`}</Text>
    })
    const ui = await $.ui.mount({
      plugin: 'cc-crisply',
      surface: 'terminal',
      component: 'UserMessage',
      requestId: 'u-off',
      props: { text: 'fix the bug', origin: { kind: 'composer' }, isExpanded: false },
      viewport: { columns: 40, rows: 40 },
    })
    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['> fix the bug'] })
    await ui.unmount()
  },
)

test("the prompt box keeps the prompt's spaces, and a deep indent stays inside the border", async $ => {
  const prompt = (requestId: string, text: string, columns = 20, isExpanded = false) =>
    ({
      plugin: 'cc-crisply',
      surface: 'terminal',
      component: 'UserMessage',
      requestId,
      props: { text, origin: { kind: 'composer' }, isExpanded },
      viewport: { columns, rows: 40 },
    }) as const
  const rowsOf = async (requestId: string, text: string, columns?: number, isExpanded?: boolean) => {
    const ui = await $.ui.mount(prompt(requestId, text, columns, isExpanded))
    const rows = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.length > 1)
    await ui.unmount()

    return rows
  }
  expect(await rowsOf('u-sp', 'x    = 1')).toContain(' x    = 1         ')
  const deep = await rowsOf('u-deep', `${' '.repeat(30)}deep`)
  for (const row of deep.slice(1, -1)) expect(row.length).toBe(18)
  expect(deep).toContain(' deep             ')
  // A long prompt is drawn whole, as Claude Code draws it, expanded or not.
  const long = Array.from({ length: 30 }, (_, k) => `line ${k}`).join('\n')
  expect(await rowsOf('u-long', long, 40)).toHaveLength(2 + 30)
  expect(await rowsOf('u-long-open', long, 40, true)).toHaveLength(2 + 30)
})

test('in a window too narrow for the box, Claude Code draws the prompt', async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`> ${e.props.text}`}</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'cc-crisply',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u-narrow',
    props: { text: 'fix it', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 8, rows: 40 },
  })
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['> fix it'] })
  await ui.unmount()
})

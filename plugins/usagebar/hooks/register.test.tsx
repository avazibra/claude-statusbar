import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { CELL, NETSIGNAL_ROOM, SWITCH_ROOM, fit, tokens } from './pills'
import { configFrom, pace, pills, render, rowFor, until } from './register'

const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const NOW = Date.parse('2026-10-03T06:00:00Z')

const usage = {
  startedAt: NOW,
  context: { window: 200_000, tokens: 62_000, percent: 31 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-03T08:10:00Z' },
    { kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-06T10:00:00Z' },
  ],
  cost: { usd: 1.237 },
}

test('reset countdowns read as days, hours or minutes', () => {
  expect(until('2026-10-03T08:10:00Z', NOW)).toBe('2h10m')
  expect(until('2026-10-06T10:00:00Z', NOW)).toBe('3d4h')
  expect(until('2026-10-03T06:12:00Z', NOW)).toBe('12m')
  expect(until(undefined, NOW)).toBe('')
})

test('compact style drops reset times; cost only when asked', () => {
  const s = { windows: [{ kind: 'five_hour', percent: 42.4 }], contextPercent: 31, usd: 2 }
  expect(render(s, configFrom({ style: 'compact', showCost: false }), NOW)).toBe('5h 42% · ctx 31%')
  expect(render(s, configFrom({ style: 'compact', showCost: true, showContext: false }), NOW)).toBe('5h 42% · $2.00')
  expect(render({ windows: [] }, configFrom({}), NOW)).toBe(undefined)
})

function wire(on: On, surfaces: ('terminal' | 'desktop')[] = ['terminal']) {
  const clock = mock.clock(on, { now: NOW })
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const stored: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: usage }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  return { clock, statuses, toasts, stored }
}

test('shows usage on start and follows each measurement', async ($, on) => {
  const { clock, statuses, toasts } = wire(on)

  await $.session.start(start)
  await clock.settle()
  expect(statuses.at(-1)).toBe('5h 42% ↻2h10m · 7d 18% ↻3d4h · ctx 31% · $1.24')

  await $.session.measure({
    context: { window: 200_000, percent: 55 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 93, resetsAt: '2026-10-03T08:10:00Z' }],
    changed: ['rateLimits', 'context'],
  })
  expect(statuses.at(-1)).toBe('5h 93% ↻2h10m · ctx 55%')
  expect(toasts).toEqual(['5h usage at 93%, resets in 2h10m'])

  // The same window past the threshold again does not toast twice.
  await $.session.measure({
    context: { window: 200_000, percent: 56 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-03T08:10:00Z' }],
    changed: ['rateLimits'],
  })
  expect(toasts.length).toBe(1)

  const ran = await $.command.run({
    command: 'usagebar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(ran.text).toContain('5h limit: 42% used, resets in 2h10m')
  expect(ran.text).toContain('Session cost: $1.24')
})

test('draws pills above the prompt in the apps, not the terminal', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start(start)
  await clock.settle()

  const props = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }
  const desktop = await $.ui.mount({ plugin: 'usagebar', surface: 'desktop', component: 'AbovePrompt', props })
  const drawn = (await desktop.findAll({ type: 'Svg' })).map(x => x.props.alt)
  expect(drawn).toEqual([
    '5h limit 42% used, resets in 2h 10m',
    '7d limit 18% used, resets in 3d 4h',
    '62.0k in context',
    '$1.24 this session',
  ])

  const terminal = await $.ui.mount({ plugin: 'usagebar', surface: 'terminal', component: 'AbovePrompt', props })
  expect((await terminal.findAll({ type: 'Svg' })).length).toBe(0)
})

test('desktop shows pills only, the footer stays empty', async ($, on) => {
  const { clock, statuses } = wire(on, ['desktop'])
  await $.session.start(start)
  await clock.settle()
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.every(t => t === undefined)).toBe(true)
})

test('desktop footer placement keeps the status line', { options: { desktopPlacement: 'footer' } }, async ($, on) => {
  const { clock, statuses } = wire(on, ['desktop'])
  await $.session.start(start)
  await clock.settle()
  expect(statuses.at(-1)).toBe('5h 42% ↻2h10m · 7d 18% ↻3d4h · ctx 31% · $1.24')
})

test('a desktop band clears the footer even when the roster lacks the app', async ($, on) => {
  const { clock, statuses } = wire(on, ['terminal'])
  await $.session.start(start)
  await clock.settle()
  expect(statuses.at(-1)).toBe('5h 42% ↻2h10m · 7d 18% ↻3d4h · ctx 31% · $1.24')

  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  await $.ui.mount({ plugin: 'usagebar', surface: 'desktop', component: 'AbovePrompt', props })
  expect(statuses.at(-1)).toBe(undefined)

  // Later redraws keep it clear.
  await clock.advance(60_000)
  expect(statuses.at(-1)).toBe(undefined)
})

test('pills carry a bar with a pace tick, and token counts once turns finish', () => {
  const c = configFrom({})
  const s = {
    windows: [{ kind: 'five_hour', percent: 20, resetsAt: '2026-10-03T08:40:00Z' }],
    contextTokens: 954_200,
    usd: 4.32,
  }
  // 2h40m left of 5h: 47% of the way through the window.
  expect(Math.round((pace('five_hour', '2026-10-03T08:40:00Z', NOW) ?? 0) * 100)).toBe(47)
  expect(until('2026-10-03T08:40:00Z', NOW, ' ')).toBe('2h 40m')

  const groups = pills(s, { input: 15_600, output: 3_000 }, c, NOW)
  expect(groups.map(g => g.map(p => p.key))).toEqual([['five_hour'], ['session'], ['cost']])
  const limit = groups[0]![0]!
  expect(limit.source).toContain('>20%<')
  expect(limit.source).toContain('>2h 40m<')
  expect(limit.alt).toBe('5h limit 20% used, resets in 2h 40m')
  // Sent, received and context share one pill, each behind its own colour.
  const session = groups[1]![0]!
  expect(session.alt).toBe('15.6k tokens sent, 3.0k received, 954.2k in context')
  expect(session.source).toContain('#c0583f')
  expect(session.source).toContain('#4f8a55')
  expect(session.source).toContain('#4f5fc9')
  expect(groups[2]![0]!.source).toContain('$4.32')
  expect(tokens(1_250_000)).toBe('1.3M')
})

test('sums the main thread turns into token totals', async ($, on) => {
  const { clock } = wire(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start(start)
  await clock.settle()
  const usage = { input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 800, cache_read_input_tokens: 50_000, model: 'm' }
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage })
  await $.turn.complete({ answer: 'b', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage })
  // A subagent's turn is its own, not the session's.
  await $.turn.complete({ answer: 'c', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer', usage, agentId: 'sub' })
  const ran = await $.command.run({ command: 'usagebar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(ran.text).toContain('Tokens: 3.0k sent, 1.6k received')
})

test('the switch and /pillstyle cycle the style and remember it', async ($, on) => {
  const { clock, stored } = wire(on)
  stored.pillStyle = 'solid'
  await $.session.start(start)
  await clock.settle()

  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const band = await $.ui.mount({ plugin: 'usagebar', surface: 'desktop', component: 'AbovePrompt', props })
  const bg = async () => String((await band.find({ type: 'Svg' }))?.props.source).match(/fill="(#[0-9a-f]{6})"/)?.[1]
  // The style saved in an earlier session comes back: solid fills with the ink.
  expect(await bg()).toBe('#3f7d68')

  await $.ui.press({ plugin: 'usagebar', key: 'usagebar-style' })
  expect(stored.pillStyle).toBe('dark')
  expect(await bg()).toBe('#33322f')

  await $.ui.press({ plugin: 'usagebar', key: 'usagebar-style' })
  expect(stored.pillStyle).toBe('soft')
  expect(await bg()).toBe('#d9eae2')

  const ran = await $.command.run({ command: 'pillstyle', args: 'dark', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(ran.text).toBe('Pill style: dark')
  expect(stored.pillStyle).toBe('dark')
  expect(await bg()).toBe('#33322f')

  const bad = await $.command.run({ command: 'pillstyle', args: 'neon', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(bad.text).toBe('Pill styles: soft, outline, solid, dark')
})

const full = {
  windows: [
    { kind: 'five_hour', percent: 42, resetsAt: '2026-10-03T08:10:00Z' },
    { kind: 'seven_day', percent: 18, resetsAt: '2026-10-06T10:00:00Z' },
  ],
  contextTokens: 954_200,
  usd: 14.32,
}
const sent = { input: 15_600, output: 3_000 }
const rowWidth = (r: { width: number }[]) => r.reduce((w, p) => w + p.width, 0) + CELL * (r.length - 1)
const roomAt = (columns: number) => columns * CELL - NETSIGNAL_ROOM - SWITCH_ROOM

test('a wide band keeps the full pills, a narrow one shrinks them to fit', () => {
  const c = configFrom({})
  const at = (columns: number) => rowFor(full, sent, c, NOW, 'soft', columns)

  const wide = at(200)
  expect(wide.scale).toBe(1)
  expect(wide.row.every(p => p.source.includes('>2h 10m<') || !p.key.includes('five'))).toBe(true)

  // Every width from roomy to cramped: one row's worth of pills, never wider
  // than the room (down to the floor), always the same figures.
  let last = Infinity
  for (let columns = 200; columns >= 60; columns -= 5) {
    const { row, scale } = at(columns)
    expect(row.map(p => p.key)).toEqual(['five_hour', 'seven_day', 'session', 'cost'])
    if (scale > 0.6) expect(rowWidth(row)).toBeLessThanOrEqual(roomAt(columns))
    expect(rowWidth(row)).toBeLessThanOrEqual(last)
    last = rowWidth(row)
  }

  // Scaling keeps the markup's own size, so text and spacing shrink together.
  const narrow = at(70)
  expect(narrow.scale).toBeLessThan(1)
  const p = narrow.row[0]!
  expect(p.source).toContain('viewBox="0 0 ')
  expect(p.height).toBeLessThan(24)
})

test('short on room, the limits drop their countdown before the pills shrink far', () => {
  const c = configFrom({})
  const widest = rowFor(full, sent, c, NOW, 'soft', 200).row
  const lean = rowFor(full, sent, c, NOW, 'soft', 80)
  const limit = lean.row[0]!
  expect(limit.source).not.toContain('>2h 10m<')
  // The alt text still says when it resets.
  expect(limit.alt).toBe('5h limit 42% used, resets in 2h 10m')
  expect(lean.scale).toBeGreaterThan(0.6)
  expect(rowWidth(lean.row)).toBeLessThan(rowWidth(widest))
})

test('fit never goes below the floor, even with no room at all', () => {
  const { row, scale } = fit([[{ width: 100, height: 24 }, { width: 100, height: 24 }]], 10, 7)
  expect(scale).toBe(0.6)
  expect(row.map(p => p.width)).toEqual([60, 60])
})

test('the band is one row that does not wrap, at any width', async ($, on) => {
  const { clock } = wire(on)
  await $.session.start(start)
  await clock.settle()
  for (const bodyColumns of [200, 100, 60]) {
    const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} }
    const band = await $.ui.mount({ plugin: 'usagebar', surface: 'desktop', component: 'AbovePrompt', props })
    expect((await band.find({ type: 'Box' }))?.props.flexWrap).toBe('nowrap')
    expect((await band.findAll({ type: 'Svg' })).length).toBe(4)
  }
  // A narrow band draws smaller pills than a wide one.
  const sizeAt = async (bodyColumns: number) => {
    const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} }
    const band = await $.ui.mount({ plugin: 'usagebar', surface: 'desktop', component: 'AbovePrompt', props })
    return (await band.findAll({ type: 'Svg' })).reduce((w, x) => w + Number(x.props.width), 0)
  }
  expect(await sizeAt(60)).toBeLessThan(await sizeAt(200))
})

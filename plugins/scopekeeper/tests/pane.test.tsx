import { expect, test } from 'claude-code/testing'
import type { On, UiFocusResult } from 'claude-code'

import type { Snapshot, View } from '../types'

const DAY = 86_400_000
const NOW = 2_000_000_000_000

const SNAP: Snapshot = {
  scannedAt: NOW,
  home: '/w',
  cwdProject: '/w/app',
  backfilledAt: 1,
  historySince: NOW - 40 * DAY,
  historyProblem: '',
  rcLoaded: true,
  problems: [],
  items: [
    { id: 'skill:improve', kind: 'skill', name: 'improve', ref: '/c/skills/improve', claim: 'new', total: 17, last: NOW - DAY, uses: [{ project: '/w/app', n: 17, last: NOW - DAY }] },
    { id: 'mcp:blender', kind: 'mcp', name: 'blender', ref: 'blender', claim: 'kit:blender', total: 546, last: NOW - 10 * DAY, uses: [{ project: '/w/game', n: 546, last: NOW - 10 * DAY }] },
    { id: 'plugin:token-kingdom', kind: 'plugin', name: 'token-kingdom', ref: 'token-kingdom@token-kingdom', claim: 'keep', total: 2, last: 0, uses: [] },
  ],
  kits: [
    { name: 'blender', summary: 'Blender MCP + blender-kiln', parts: ['mcp blender: uvx mcp-for-blender', 'plugin blender-kiln@blender-kiln'], globals: ['mcp:blender'], projects: [
      { project: '/w/game', status: 'partial', n: 546, last: NOW - 10 * DAY, since: 0 },
    ] },
    { name: 'design', summary: 'impeccable + genjutsu', parts: ['runs: npx -y impeccable@latest install --project', 'plugin genjutsu@genjutsu'], globals: [], projects: [
      { project: '/w/app', status: 'on', n: 14, last: NOW - DAY, since: 0 },
      { project: '/w/old', status: 'on', n: 1, last: NOW - 90 * DAY, since: 0 },
      // Just enabled and not used yet: on, not stale.
      { project: '/w/new', status: 'on', n: 0, last: 0, since: NOW - DAY },
      { project: '/w/site', status: 'off', n: 1, last: NOW - 2 * DAY, since: 0 },
    ] },
    { name: 'video', summary: 'remotion skills', parts: ['skills remotion-* from https://github.com/remotion-dev/skills.git'], globals: [], projects: [
      { project: '/w/app', status: 'off', n: 6, last: NOW - 3 * DAY, since: 0 },
    ] },
  ],
  bundles: [
    { id: 'skill:improve', name: 'improve', ids: ['skill:improve'], why: 'used in 1 project', projects: [{ project: '/w/app', n: 17, last: NOW - DAY }], total: 17, direct: false },
    { id: 'mcp:godot-ai plugin:godot-kit', name: 'godot', ids: ['mcp:godot-ai', 'plugin:godot-kit'], why: 'used together in 4 sessions', projects: [{ project: '/w/game', n: 30, last: NOW - DAY }], total: 30, direct: true },
  ],
  everywhere: ['skill:commit'],
  unused: ['agent:lonely'],
}

const PANE = {
  plugin: 'scopekeeper',
  component: 'Pane',
  requestId: 'scopekeeper-advanced',
  props: {
    title: 'Scope',
    isFocused: true,
    bodyColumns: 62,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/** Serves the pane's state from a map the test seeds, and records what the mod writes. */
function seed(on: On, snap: Snapshot | undefined, view?: View) {
  const state: Record<string, unknown> = {
    snapshot: snap && { shape: 'snap-4', value: snap },
    view: view && { shape: 'view-3', value: view },
  }
  let version = 1
  on('state.get', (_, e) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_, e) => {
    state[e.key] = (e as { value: unknown }).value
    return { value: { isSet: true, version: ++version } }
  })
  // The engine's own move of the ring, beneath the mod's hook: a call on $ is answered as `{ value }`.
  on('ui.focus', () => ({ value: {} }) as UiFocusResult)
  return state
}

/** Every row a Button draws, as text, so its width can be checked against the pane's. */
const rowTexts = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined; text: string }[]> }, prefix: RegExp) =>
  (await ui.findAll({ type: 'Button' })).filter(b => prefix.test(b.key ?? '')).map(b => b.text)

// ---- the advanced pane: every global and every kit, across projects

test('the globals tab lists unsorted installs first, on every surface', async ($, on) => {
  seed(on, SNAP)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 unsorted · 1 to adopt/ })).toBeDefined()
    const rows = await rowTexts(ui, /^item:/)
    expect(rows.length).toBe(2)
    expect(rows[0]!.includes('improve')).toBe(true)
    expect(await ui.find({ key: 'triage' })).toBeDefined()
    await ui.unmount()
  }
})

test('before the first scan the pane says so', async ($, on) => {
  seed(on, undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Scanning your setup…')
  await ui.unmount()
})

test('every action is a plain Button, so the terminal draws its hotkey', async ($, on) => {
  seed(on, SNAP, { tab: 'globals', selected: 'skill:improve', showKept: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const [key, hotkey] of [['tab-globals', 'g'], ['tab-kits', 'i'], ['rescan', 'r'], ['act-make', 'm'], ['act-keep', 'k'], ['act-remove', 'x']]) {
    const button = await ui.find({ key: key! })
    expect(button?.props.plain, key).toBe(true)
    expect(button?.props.hotkey, key).toBe(hotkey)
  }
  await ui.unmount()
})

test('nothing starts open; an open row shows its details right under it', async ($, on) => {
  const state = seed(on, SNAP)
  const closed = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await closed.find({ key: 'detail:skill:improve' })).toBe(undefined)
  await closed.unmount()
  state.view = { shape: 'view-3', value: { tab: 'globals', selected: 'skill:improve', showKept: false } }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'detail:skill:improve' })).toBeDefined()
  // Its actions are buttons in its details, not a line of keys to read.
  expect((await ui.find({ key: 'act-make' }))?.text).toBe('Make a kit')
  expect(await ui.find({ type: 'Text', text: /^m make a kit/ })).toBe(undefined)
  // The kept install is folded away until asked for.
  expect(await ui.find({ key: 'item:plugin:token-kingdom' })).toBe(undefined)
  expect((await ui.find({ key: 'kept' }))?.text).toBe('▸ Kept global (1)')
  await ui.unmount()
})

test('moving the ring opens nothing; Enter opens the row', async ($, on) => {
  const state = seed(on, SNAP)
  // Rows that opened under the ring shifted the rows below it, so the arrows skipped them.
  await $.ui.focus({ component: 'Pane', requestId: 'scopekeeper-advanced', plugin: 'scopekeeper', element: 'item:mcp:blender', origin: { kind: 'person' } })
  expect(state.view).toBe(undefined)
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.press({ key: 'item:mcp:blender' })
  await first.unmount()
  expect((state.view as { value: View }).value.selected).toBe('mcp:blender')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Covered by kit blender, but still installed globally/ })).toBeDefined()
  expect((await ui.find({ key: 'act-adopt' }))?.text).toBe('Adopt blender')
  // a goes back to the local pane, so Adopt takes o.
  expect((await ui.find({ key: 'act-adopt' }))?.props.hotkey).toBe('o')
  // Enter on the open row closes it again.
  await ui.press({ key: 'item:mcp:blender' })
  await ui.unmount()
  expect((state.view as { value: View }).value.selected).toBe('')
})

test('no row is wider than the pane', async ($, on) => {
  const state = seed(on, SNAP)
  for (const width of [40, 62, 120]) {
    for (const tab of ['globals', 'kits'] as const) {
      state.view = { shape: 'view-3', value: { tab, selected: tab === 'kits' ? 'design' : '', showKept: true } }
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'terminal' })
      const rows = await rowTexts(ui, /^(item|kit|proj):/)
      expect(rows.length > 0).toBe(true)
      for (const row of rows) expect(row.length <= width, `${width} ${tab}: "${row}"`).toBe(true)
      await ui.unmount()
    }
  }
})

test('a kit just enabled is on, one unused for staleDays is stale', async ($, on) => {
  seed(on, SNAP, { tab: 'kits', selected: 'design', showKept: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // ✓ already says on: the last cell only speaks for what needs a look.
  expect((await ui.find({ key: 'proj:design:/w/new' }))?.text.trimEnd().endsWith(' on')).toBe(false)
  expect((await ui.find({ key: 'proj:design:/w/site' }))?.text.endsWith('used, off')).toBe(true)
  expect((await ui.find({ key: 'kit:design' }))?.text.trimEnd().endsWith('turn on 1')).toBe(true)
  expect((await ui.find({ key: 'proj:design:/w/old' }))?.text.endsWith('stale')).toBe(true)
  expect((await ui.find({ key: 'act-prune' }))?.text).toBe('Prune 1 stale')
  // What cc-design runs is shown before anyone enables it.
  expect(await ui.find({ type: 'Text', text: '· runs: npx -y impeccable@latest install --project' })).toBeDefined()
  await ui.unmount()
})

test('while history loads, counts are not shown as zero and nothing can be removed', async ($, on) => {
  seed(on, { ...SNAP, backfilledAt: 0 }, { tab: 'globals', selected: 'skill:improve', showKept: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'act-remove' })).toBe(undefined)
  expect((await ui.find({ key: 'item:skill:improve' }))?.text.includes('…')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Reading your transcripts/ })).toBeDefined()
  await ui.unmount()
})

// ---- the daily pane: this project, and what to make local

const DAILY = { ...PANE, requestId: 'scopekeeper' } as const

test('the daily pane shows whether each kit is on in this project', async ($, on) => {
  seed(on, SNAP)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...DAILY, surface })
    expect(await ui.find({ type: 'Text', text: 'app' })).toBeDefined()
    // The dot says on or off; the last cell only speaks for what needs a look.
    expect((await ui.find({ key: 'here:design' }))?.text.includes('●')).toBe(true)
    expect((await ui.find({ key: 'here:design' }))?.text.trimEnd().endsWith(' on')).toBe(false)
    expect((await ui.find({ key: 'here:blender' }))?.text.trimEnd().endsWith('off')).toBe(false)
    expect((await ui.find({ key: 'here:video' }))?.text.trimEnd().endsWith('used 3d ago')).toBe(true)
    // The cross-project tables stay in the advanced pane.
    expect(await ui.find({ key: 'tab-globals' })).toBe(undefined)
    expect((await ui.find({ key: 'advanced' }))?.props.hotkey).toBe('a')
    await ui.unmount()
  }
})

test('a kit used here but off comes first, with one key to turn it on', async ($, on) => {
  seed(on, SNAP)
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect((await rowTexts(ui, /^here:/))[0]!.includes('video')).toBe(true)
  expect(await ui.find({ key: 'detail:here:video' })).toBe(undefined)
  const button = await ui.find({ key: 'turn-on-used' })
  expect(button?.props.hotkey).toBe('y')
  // It belongs to the list, not the row under the cursor, so it names every kit it turns on.
  expect(button?.text).toBe('Turn on what you used here: video')
  // The footer names what Enter does on the selected row.
  expect(await ui.find({ type: 'Text', text: 'Enter: Turn on' })).toBeDefined()
  expect((await ui.find({ key: 'triage' }))?.text).toBe('Let Claude triage')
  await ui.unmount()
})

test('a switches between local and advanced, one pane at a time', async ($, on) => {
  seed(on, SNAP)
  const calls: string[] = []
  on('ui.open', (_, e) => {
    calls.push(`open ${e.id} ${e.title} ${e.focus}`)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    calls.push(`close ${e.id}`)
    return { value: undefined }
  })
  const local = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  await local.press({ key: 'advanced' })
  await local.unmount()
  expect(calls).toEqual(['close scopekeeper', 'open scopekeeper-advanced Scope · all projects true'])
  calls.length = 0
  const advanced = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await advanced.find({ key: 'local' }))?.props.hotkey).toBe('a')
  await advanced.press({ key: 'local' })
  await advanced.unmount()
  expect(calls).toEqual(['close scopekeeper-advanced', 'open scopekeeper Scope · Local true'])
})

test('the header shows the project path once, and the globals counts sit on one line', async ($, on) => {
  const state = seed(on, SNAP)
  state.log = ['Enabled design in ~/app.', 'Cancelled.', '']
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '~/' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Globals: 1 always on · 3 to make local · 1 never used$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /always loaded/ })).toBe(undefined)
  // A cancelled question or an empty line leaves nothing behind; the last real action says what it was.
  expect(await ui.find({ type: 'Text', text: /Cancelled|^· / })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: 'Last: Enabled design in ~/app.' })).toBeDefined()
  await ui.unmount()
})

test('moving onto a suggestion opens nothing; Enter opens it with make local and keep global', async ($, on) => {
  const state = seed(on, SNAP)
  // Details that opened under the ring shifted the rows below it, so the arrows skipped them.
  await $.ui.focus({ component: 'Pane', requestId: 'scopekeeper', plugin: 'scopekeeper', element: 'sug:mcp:godot-ai plugin:godot-kit', origin: { kind: 'person' } })
  expect(state.pick).toBe('sug:mcp:godot-ai plugin:godot-kit')
  const closed = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect(await closed.find({ key: 'act-local' })).toBe(undefined)
  expect(await closed.find({ type: 'Text', text: 'Enter: Open' })).toBeDefined()
  await closed.press({ key: 'sug:mcp:godot-ai plugin:godot-kit' })
  await closed.unmount()
  expect(state.opened).toBe('sug:mcp:godot-ai plugin:godot-kit')
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect((await ui.find({ key: 'sug:mcp:godot-ai plugin:godot-kit' }))?.text.startsWith('›')).toBe(true)
  expect((await ui.find({ key: 'act-local' }))?.text).toBe('Make local')
  expect((await ui.find({ key: 'act-local' }))?.props.hotkey).toBe('l')
  expect((await ui.find({ key: 'act-keep' }))?.props.hotkey).toBe('k')
  // One project a line under the actions, never one long line cut at the edge.
  expect(await ui.find({ type: 'Text', text: 'Used in:' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ~\/game +30 +1d$/ })).toBeDefined()
  // Enter on the open suggestion closes it again.
  await ui.press({ key: 'sug:mcp:godot-ai plugin:godot-kit' })
  expect(state.opened).toBe('')
  // A bundle holding skills is set up by Claude, which works out where they come from.
  state.opened = 'sug:skill:improve'
  await ui.unmount()
  const again = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect((await again.find({ key: 'act-local' }))?.text).toBe('Make local with Claude')
  expect(await again.find({ type: 'Text', text: /1 never used/ })).toBeDefined()
  await again.unmount()
})

test('with every global unused, the daily pane does not say there is nothing to split', async ($, on) => {
  seed(on, { ...SNAP, kits: [], bundles: [], everywhere: [], unused: ['skill:a', 'skill:b'] })
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Nothing to split/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /2 globals never used: t lets Claude sort them/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /make one local below/ })).toBe(undefined)
  await ui.unmount()
})

test('a kits.json that does not parse is named in the daily pane', async ($, on) => {
  seed(on, { ...SNAP, problems: ['~/.claude/scopekeeper/kits.json does not parse (x): fix it by hand'] })
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /kits.json does not parse/ })).toBeDefined()
  await ui.unmount()
})

test('outside a project the daily pane only offers what to make local', async ($, on) => {
  seed(on, { ...SNAP, cwdProject: '' })
  const ui = await $.ui.mount({ ...DAILY, surface: 'terminal' })
  expect(await ui.find({ key: 'here:design' })).toBe(undefined)
  expect(await ui.find({ key: 'sug:skill:improve' })).toBeDefined()
  expect(await ui.find({ key: 'detail:sug:skill:improve' })).toBe(undefined)
  await ui.unmount()
})

test('no daily row is wider than the pane', async ($, on) => {
  const state = seed(on, SNAP)
  for (const width of [30, 40, 56, 120]) {
    for (const pick of ['here:design', 'sug:skill:improve', 'sug:everywhere']) {
      state.opened = pick
      const ui = await $.ui.mount({ ...DAILY, props: { ...DAILY.props, bodyColumns: width }, surface: 'terminal' })
      const rows = await rowTexts(ui, /^(here|sug):/)
      expect(rows.length).toBe(6)
      for (const row of rows) expect(row.length <= width, `${width}: "${row}"`).toBe(true)
      // An open bundle's projects, one a line, indented 4 under it.
      const projects = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => /^  ~\//.test(t))
      if (pick === 'sug:skill:improve') expect(projects.length).toBe(1)
      for (const p of projects) expect(p.length <= width - 4, `${width}: "${p}"`).toBe(true)
      await ui.unmount()
    }
  }
})

// ---- help: one short box per view, shown until the person hides it

test('each view explains itself until h hides it, and hidden stays hidden', async ($, on) => {
  const state = seed(on, SNAP)
  const stored: Record<string, unknown> = {}
  on('store.set', (_, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  for (const [mount, view, text] of [
    [DAILY, 'local', /^Load tools only/],
    [PANE, 'globals', /^  new: unsorted/],
    [{ ...PANE, requestId: 'scopekeeper-advanced' }, 'kits', /^A kit is a group of tools/],
  ] as const) {
    if (view === 'kits') state.view = { shape: 'view-3', value: { tab: 'kits', selected: '', showKept: false } }
    const ui = await $.ui.mount({ ...mount, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text }), view).toBeDefined()
    const help = await ui.find({ key: 'help' })
    expect(help?.props.hotkey).toBe('h')
    expect(help?.text).toBe('Hide help')
    await ui.press({ key: 'help' })
    await ui.unmount()
    expect((state.helpHidden as string[]).includes(view), view).toBe(true)
    const again = await $.ui.mount({ ...mount, surface: 'terminal' })
    expect(await again.find({ type: 'Text', text }), view).toBe(undefined)
    expect((await again.find({ key: 'help' }))?.text).toBe('Help')
    await again.unmount()
  }
  expect(stored.helpHidden).toEqual(['local', 'globals', 'kits'])
})

test('every help line, and the globals count under the lists, fits the pane at the width it opens at', async ($, on) => {
  const state = seed(on, SNAP)
  for (const [mount, tab, width] of [[DAILY, 'globals', 56], [PANE, 'globals', 64], [PANE, 'kits', 64]] as const) {
    state.view = { shape: 'view-3', value: { tab, selected: '', showKept: false } }
    const ui = await $.ui.mount({ ...mount, props: { ...mount.props, bodyColumns: width }, surface: 'terminal' })
    // The box's border and padding take 4 columns.
    const help = (await ui.findAll({ type: 'Box' })).filter(b => /^help:/.test(b.key ?? ''))
    expect(help.length > 0).toBe(true)
    for (const line of help) expect(line.text.length <= width - 4, `${width}: "${line.text}"`).toBe(true)
    const count = await ui.find({ type: 'Text', text: /^Globals: / })
    if (mount === DAILY) expect((count?.text.length ?? Infinity) <= width, `"${count?.text}"`).toBe(true)
    await ui.unmount()
  }
})

// ---- the band above the prompt

const BAND = {
  plugin: 'scopekeeper',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

test('the band lights this project\'s kits in color', async ($, on) => {
  seed(on, SNAP)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
    expect((await ui.find({ type: 'Text', text: '○' }))?.props.color).toBe('yellow')
    // Names keep the theme's own text color, and no reminder follows the lights.
    expect((await ui.find({ type: 'Text', text: ' video' }))?.props.color).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /turn on|\/scope/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('a light with something to say shows it on hover, after the lights', async ($, on) => {
  seed(on, SNAP)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // find leaves hover out of props: the drawn tree carries it.
  type Node = { type?: string; props?: { key?: unknown }; hover?: unknown; children?: unknown[] }
  const all = (n: unknown): Node[] => (n && typeof n === 'object' ? [n as Node, ...((n as Node).children ?? []).flatMap(all)] : [])
  const drawn = all(await ui.drawn())
  const at = (key: string) => drawn.find(n => n.props?.key === key)
  expect(at('light:video')?.hover).toEqual({ scope: 'light:video' })
  expect(at('info:video')?.hover).toEqual({ scope: 'light:video', display: 'flex' })
  const card = await ui.find({ key: 'info:video' })
  expect(card?.props.display).toBe('none')
  expect(card?.text).toBe('  video: off · used 6× here, last 3d ago')
  // design is on and in use here: nothing to add.
  expect(at('light:design')?.hover).toBe(undefined)
  expect(at('info:design')).toBe(undefined)
  await ui.unmount()
})

test('an idle kit\'s light is dimmed, one off is not', async ($, on) => {
  const kits = SNAP.kits.map(k => (k.name !== 'design' ? k : {
    ...k, projects: k.projects.map(pr => (pr.project === '/w/app' ? { ...pr, last: NOW - 40 * DAY } : pr)),
  }))
  seed(on, { ...SNAP, kits })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const dims = async (key: string) => (await ui.find({ key }))?.children
    .flatMap(c => (typeof c === 'string' ? [] : [(c as { props?: { dimColor?: boolean } }).props?.dimColor]))
  expect(await dims('light:design')).toEqual([true, true])
  expect(await dims('light:video')).toEqual([undefined, undefined])
  expect((await ui.find({ type: 'Text', text: '●' }))?.props.color).toBe('green')
  await ui.unmount()
})

test('a light in the band toggles its kit here, after one question', async ($, on) => {
  seed(on, SNAP)
  const asked: unknown[] = []
  // $.ui.ask is an AskUserQuestion call: refused here, so the question is cancelled.
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    asked.push(e)
    return { deny: 'test' }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ key: 'light:design' }))?.props.hotkey).toBe(undefined)
  await ui.press({ key: 'light:video' })
  await ui.unmount()
  expect(JSON.stringify(asked)).toContain('Enable video in ~/app?')
})

/** The engine's own band, beneath the mod: what shows when the mod passes. */
const engineBand = (on: On) => on('ui.render', ($, e) => {
  const { Text } = $.ui.resolve(e)
  return <Text>engine</Text>
})

test('the band gives way to a survey', async ($, on) => {
  seed(on, SNAP)
  engineBand(on)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '●' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('before the first scan the band leaves its row to the engine', async ($, on) => {
  seed(on, undefined)
  engineBand(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

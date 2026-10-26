import { expect, test } from 'claude-code/testing'

import { DAY, ago, claimOf, classify, clip, coUse, kitUsage, day, family, generateScript, isStale, partLine, partUsage, q, rcLineFor, rcPlan, bandText, suggest, validateKit } from '../hooks/core'
import type { ItemRow, KitProject, KitRow, Snapshot } from '../types'
import type { Registry } from '../hooks/core'

const known = (keys: string[]) => (key: string) => keys.includes(key)

test('uses map to the install they came from', async () => {
  const plugins = ['chrome-devtools-mcp', 'blender-kiln']
  const none = known([])
  expect(classify({ kind: 'skill', name: 'genjutsu:paint' }, plugins, none)).toBe('plugin:genjutsu')
  expect(classify({ kind: 'skill', name: 'impeccable' }, plugins, none)).toBe('skill:impeccable')
  expect(classify({ kind: 'mcp', name: 'plugin_chrome-devtools-mcp_chrome-devtools' }, plugins, none)).toBe('plugin:chrome-devtools-mcp')
  expect(classify({ kind: 'mcp', name: 'godot-ai' }, plugins, none)).toBe('mcp:godot-ai')
  expect(classify({ kind: 'mcp', name: 'claude_ai_Slack' }, plugins, none)).toBe('connector:Slack')
  expect(classify({ kind: 'agent', name: 'general-purpose' }, plugins, none)).toBe(undefined)
  expect(classify({ kind: 'agent', name: 'impeccable-documenter' }, plugins, none)).toBe('agent:impeccable-documenter')
  expect(classify({ kind: 'command', name: 'clear' }, plugins, none)).toBe(undefined)
  expect(classify({ kind: 'command', name: 'impeccable' }, plugins, known(['skill:impeccable']))).toBe('skill:impeccable')
  expect(classify({ kind: 'command', name: 'blender-kiln:kiln' }, plugins, none)).toBe('plugin:blender-kiln')
})

const REGISTRY: Registry = {
  version: 1,
  keepGlobal: ['plugin:token-kingdom'],
  kits: {
    design: {
      parts: [
        { kind: 'installer', run: 'npx -y impeccable@latest install --project -y', paths: ['.claude/skills/impeccable/', '.claude/agents/impeccable-*'] },
        { kind: 'plugin', id: 'genjutsu@genjutsu' },
      ],
    },
    remotion: { parts: [{ kind: 'git-skills', repo: 'https://github.com/remotion-dev/skills.git', match: 'remotion-*' }] },
    godot: { parts: [{ kind: 'mcp', name: 'godot-ai', config: { type: 'stdio', command: 'uvx', args: ["it's"] } }] },
  },
}

test('a kit claims the globals it covers', async () => {
  expect(partUsage(REGISTRY.kits.design!.parts[0]!)).toEqual(['skill:impeccable', 'agent:impeccable-*'])
  expect(kitUsage(REGISTRY.kits.remotion!)).toEqual(['skill:remotion-*'])
  expect(claimOf('agent:impeccable-finish-reviewer', REGISTRY)).toBe('kit:design')
  expect(claimOf('skill:remotion-captions', REGISTRY)).toBe('kit:remotion')
  expect(claimOf('plugin:genjutsu', REGISTRY)).toBe('kit:design')
  expect(claimOf('plugin:token-kingdom', REGISTRY)).toBe('keep')
  expect(claimOf('skill:improve', REGISTRY)).toBe('new')
})

test('the generated script has an on and an off function per kit', async () => {
  const script = generateScript(REGISTRY, '/home/x/.claude/skill-library')
  for (const name of ['design', 'remotion', 'godot']) {
    expect(script.includes(`cc-${name}() {`)).toBe(true)
    expect(script.includes(`cc-${name}-off() {`)).toBe(true)
  }
  expect(script.includes("claude plugin install 'genjutsu@genjutsu' --scope local || return 1")).toBe(true)
  expect(script.includes("_sk_exclude '.claude/skills/impeccable/' '.claude/agents/impeccable-*'")).toBe(true)
  expect(script.includes("'/home/x/.claude/skill-library/remotion-dev-skills'")).toBe(true)
  expect(script.includes(q(JSON.stringify({ type: 'stdio', command: 'uvx', args: ["it's"] })))).toBe(true)
  expect(q("it's")).toBe(`'it'\\''s'`)
})

test('kits that would write outside the project are refused', async () => {
  expect(validateKit('Design', { parts: [{ kind: 'plugin', id: 'genjutsu@genjutsu' }] }).length).toBe(1)
  expect(validateKit('x', { parts: [{ kind: 'installer', run: 'true', paths: ['../oops'] }] }).length).toBe(1)
  expect(validateKit('x', { parts: [{ kind: 'plugin', id: 'genjutsu' }] }).length).toBe(1)
  expect(validateKit('design', REGISTRY.kits.design!)).toEqual([])
})

test('the shell decides which startup files load cc.sh', async () => {
  const H = '/h'
  expect(rcPlan('/bin/zsh', H, true, {})).toEqual({ files: ['/h/.zshrc'] })
  // macOS bash with no login file: Terminal opens login shells, so .bash_profile is made.
  expect(rcPlan('/bin/bash', H, true, {})).toEqual({ files: ['/h/.bashrc', '/h/.bash_profile'], note: undefined })
  // Linux bash with no login file: terminals open non-login shells.
  expect(rcPlan('/usr/bin/bash', H, false, {}).files).toEqual(['/h/.bashrc'])
  // A login file that already loads .bashrc needs nothing more.
  expect(rcPlan('/bin/bash', H, true, { '/h/.bash_profile': '[ -f ~/.bashrc ] && . ~/.bashrc' }).files).toEqual(['/h/.bashrc'])
  // Only the first login file bash finds counts.
  expect(rcPlan('/bin/bash', H, false, { '/h/.profile': 'export X=1', '/h/.bash_login': 'export Y=1' }).files)
    .toEqual(['/h/.bashrc', '/h/.bash_login'])
  // Not zsh means bash's files, with a note for shells that cannot load them.
  const fish = rcPlan('/opt/homebrew/bin/fish', H, true, {})
  expect(fish.files).toEqual(['/h/.bashrc', '/h/.bash_profile'])
  expect(fish.note?.startsWith('fish cannot load')).toBe(true)
  expect(rcPlan('', H, false, {}).note).toBe(undefined)
  expect(rcPlan('/bin/zsh', H, true, {}, '~/.config/shell/rc')).toEqual({ files: ['/h/.config/shell/rc'] })
})

test('the line in a bash file only runs under bash', async () => {
  expect(rcLineFor('/h/.zshrc', '/c/cc.sh').startsWith('[ -f "/c/cc.sh" ]')).toBe(true)
  expect(rcLineFor('/h/.profile', '/c/cc.sh').startsWith('[ -n "$BASH_VERSION" ] && [ -f "/c/cc.sh" ]')).toBe(true)
})

test('each part says what it installs or runs', async () => {
  expect(REGISTRY.kits.design!.parts.map(partLine)).toEqual([
    'runs: npx -y impeccable@latest install --project -y',
    'plugin genjutsu@genjutsu',
  ])
  expect(partLine(REGISTRY.kits.godot!.parts[0]!)).toBe("mcp godot-ai: uvx it's")
  expect(partLine(REGISTRY.kits.remotion!.parts[0]!)).toBe('skills remotion-* from https://github.com/remotion-dev/skills.git')
})

test('stale counts from the later of last use and enabling', async () => {
  const now = 100 * DAY
  expect(isStale({ status: 'on', last: now - 40 * DAY, since: 0 }, now, 30)).toBe(true)
  expect(isStale({ status: 'on', last: now - 40 * DAY, since: now - DAY }, now, 30)).toBe(false)
  expect(isStale({ status: 'on', last: 0, since: now - DAY }, now, 30)).toBe(false)
  expect(isStale({ status: 'on', last: 0, since: 0 }, now, 30)).toBe(false)
  expect(isStale({ status: 'off', last: now - 40 * DAY, since: 0 }, now, 30)).toBe(false)
})

test('display helpers', async () => {
  expect(ago(0, 1)).toBe('—')
  expect(clip('status', 12)).toBe('status')
  expect(clip('a-long-kit-name', 8)).toBe('a-long-…')
  const now = Date.UTC(2026, 9, 26, 12)
  expect(day(Date.UTC(2026, 8, 26, 12), now)).toBe('Sep 26')
  expect(day(Date.UTC(2025, 8, 26, 12), now)).toBe('Sep 26 2025')
})

const row = (id: string, projects: string[], claim = 'new'): ItemRow => {
  const [kind, name] = id.split(':') as [ItemRow['kind'], string]
  const uses = projects.map(project => ({ project, n: 5, last: 1 }))
  return { id, kind, name, ref: name, claim, total: uses.length * 5, last: 1, uses }
}

test('names reduce to their family word', async () => {
  expect(family('remotion-best-practices')).toBe('remotion')
  expect(family('chrome-devtools-mcp')).toBe('chrome')
  expect(family('mcp-for-blender')).toBe('blender')
  expect(family('ai')).toBe('')
})

test('unsorted globals group into bundles by name, co-use and shared projects', async () => {
  const items = [
    row('skill:remotion-render', ['/a']),
    row('skill:remotion-best-practices', []),
    row('mcp:blender', ['/g']),
    row('plugin:kiln', ['/g']),
    row('skill:commit', ['/a', '/b', '/c']),
    row('agent:lonely', []),
    row('plugin:sorted', ['/g'], 'keep'),
    row('skill:x-one', ['/d', '/e']),
    row('agent:y-two', ['/d', '/e']),
  ]
  const co = coUse({
    s1: { at: 1, keys: ['mcp:blender', 'plugin:kiln'] },
    s2: { at: 2, keys: ['mcp:blender', 'plugin:kiln', 'skill:commit'] },
    s3: { at: 3, keys: ['plugin:kiln', 'mcp:blender'] },
  })
  const { bundles, everywhere, unused } = suggest(items, co, '/g')
  expect(everywhere).toEqual(['skill:commit'])
  expect(unused).toEqual(['agent:lonely'])
  const by = Object.fromEntries(bundles.map(b => [b.name, b]))
  expect(by.blender?.why).toBe('used together in 3 sessions')
  expect(by.blender?.direct).toBe(true)
  // The bundle used in this project comes first.
  expect(bundles[0]?.name).toBe('blender')
  expect(by.remotion?.ids.sort()).toEqual(['skill:remotion-best-practices', 'skill:remotion-render'])
  expect(by.remotion?.why).toBe('all remotion')
  expect(by.remotion?.direct).toBe(false)
  expect(bundles.find(b => b.ids.includes('skill:x-one'))?.why).toBe('used in the same 2 projects')
  expect(bundles.some(b => b.ids.includes('plugin:sorted'))).toBe(false)
})

test('the band lights this project\'s kits: on, partly on, or used here but off', async () => {
  const now = 100 * DAY
  const kit = (name: string, status: KitProject['status'], n: number, last: number, project = '/a') =>
    ({ name, summary: '', parts: [], globals: [], projects: [{ project, status, n, last, since: 0 }] })
  const snap = (kits: KitRow[], extra: Partial<Snapshot> = {}): Snapshot => ({
    scannedAt: now, home: '/h', cwdProject: '/a', items: [], kits, bundles: [], everywhere: [], unused: [],
    backfilledAt: 1, historySince: 1, historyProblem: '', rcLoaded: true, problems: [], ...extra,
  })
  const bundle = { id: 'b', name: 'b', ids: [], why: '', projects: [], total: 0, direct: true }

  expect(bandText(snap([kit('remotion', 'on', 4, now - DAY), kit('vercel', 'on', 2, now - DAY)]))).toBe('● remotion  ● vercel')
  expect(bandText(snap([kit('remotion', 'off', 6, now - 3 * DAY), kit('vercel', 'on', 2, now - DAY)]))).toBe('○ remotion  ● vercel')
  expect(bandText(snap([kit('godot', 'partial', 0, 0)]))).toBe('◐ godot')
  // No reminders: an idle kit is on, and problems and globals to make local stay in the pane.
  expect(bandText(snap([kit('godot', 'on', 1, now - 34 * DAY)], { problems: ['cc-* functions are not loaded'], bundles: [bundle] }))).toBe('● godot')
  // Kits only used elsewhere stay out; with none here, there is no band.
  expect(bandText(snap([kit('godot', 'on', 1, now - DAY, '/b')], { bundles: [bundle] }))).toBe(undefined)
  // Past four lights, the kits not fully on stay.
  const many = ['a', 'b', 'c', 'd', 'e'].map(n => kit(n, 'on', 1, now - DAY)).concat(kit('z', 'off', 1, now - DAY))
  expect(bandText(snap(many))).toBe('● a  ● b  ● c  ○ z  +2')
})

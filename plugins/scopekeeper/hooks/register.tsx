import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bundle, KitProject, KitRow, GlobalItem, ItemRow, Snapshot, View } from '../types'
import {
  addUse, ago, claimOf, classify, clip, coUse, kitUsage, count, day, fit, generateScript, invalidKits,
  isStale, kitsContext, matchesAny, mcpServerOf, mergeLedger, mergeSessions, partLine, partSummary, plural,
  pluginName, rcCandidates, rcLineFor, band, rcPlan, shortPath, skillsSource, suggest, trimSessions, validateKit,
} from './core'
import type { Kit, Ledger, Part, Registry, Sessions, UsageEvent } from './core'

type $T = EngineInterface

/** The daily pane: this project's kits, and what to split out of the global scope. */
const PANE = 'scopekeeper'
/** Every global install and every kit, across all projects. */
const ADVANCED = 'scopekeeper-advanced'
const snapshot = atom({ plugin: 'scopekeeper', key: 'snapshot' } as const, null, { shape: 'snap-4' })
const view = atom({ plugin: 'scopekeeper', key: 'view' } as const, { tab: 'globals', selected: '', showKept: false }, { shape: 'view-3' })
const pick = atom({ plugin: 'scopekeeper', key: 'pick' } as const, '')
const opened = atom({ plugin: 'scopekeeper', key: 'opened' } as const, '')
const helpHidden = atom({ plugin: 'scopekeeper', key: 'helpHidden' } as const, [])
const busy = atom({ plugin: 'scopekeeper', key: 'busy' } as const, '')
const log = atom({ plugin: 'scopekeeper', key: 'log' } as const, [])

const TOOL = (name: string) => `mcp__scopekeeper__${name}`

// ---------------------------------------------------------------- paths

type Paths = {
  home: string
  cfg: string
  globalJson: string
  dir: string
  registry: string
  /** Where kits were saved before they were called kits: read once, then moved to backups. */
  legacyRegistry: string
  script: string
  libRoot: string
  /** The startup files that must load cc.sh (see rcPlan). */
  rcFiles: string[]
  rcNote?: string
}

let pathsCache: Paths | undefined

async function paths($: $T, rcOption: string): Promise<Paths> {
  if (pathsCache) return pathsCache
  const home = (await $.env.get('HOME')) ?? ''
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  const cfg = custom || `${home}/.claude`
  const shell = (await $.env.get('SHELL')) ?? ''
  const contents: Record<string, string | undefined> = {}
  for (const file of rcCandidates(home)) contents[file] = await $.fs.read(file).catch(() => undefined)
  const uname = await $.process.run(['uname', '-s']).catch(() => undefined)
  const rc = rcPlan(shell, home, uname?.stdout.trim() === 'Darwin', contents, rcOption)
  const dir = `${cfg}/scopekeeper`
  pathsCache = {
    home,
    cfg,
    globalJson: custom ? `${cfg}/.claude.json` : `${home}/.claude.json`,
    dir,
    registry: `${dir}/kits.json`,
    legacyRegistry: `${dir}/combos.json`,
    script: `${dir}/cc.sh`,
    libRoot: `${cfg}/skill-library`,
    rcFiles: rc.files,
    rcNote: rc.note,
  }
  return pathsCache
}

async function readJson<T>($: $T, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------- registry

/** Why kits.json could not be read, when it exists but does not parse: nothing is saved over it until it is fixed. */
let registryError = ''

async function loadRegistry($: $T, p: Paths): Promise<Registry> {
  if (!(await $.fs.exists(p.registry))) {
    registryError = ''
    if (await $.fs.exists(p.legacyRegistry)) return migrateRegistry($, p)
    return { version: 1, keepGlobal: [], kits: {} }
  }
  let reg: Partial<Registry>
  try {
    reg = JSON.parse(await $.fs.read(p.registry)) as Partial<Registry>
    if (!reg || typeof reg !== 'object' || Array.isArray(reg)) throw new Error('not a JSON object')
    registryError = ''
  } catch (error) {
    registryError = `${shortPath(p.registry, p.home)} does not parse (${String(error).slice(0, 120)}): fix it by hand; nothing is saved over it until then`
    reg = {}
  }
  return { version: 1, keepGlobal: [...(reg.keepGlobal ?? [])], kits: { ...(reg.kits ?? {}) } }
}

/** kits.json and cc.sh may hold MCP secrets (env, headers): only the person reads them. */
async function lockDown($: $T, p: Paths): Promise<void> {
  await $.process.run(['chmod', '700', p.dir]).catch(() => undefined)
  for (const file of [p.registry, p.script]) {
    if (await $.fs.exists(file)) await $.process.run(['chmod', '600', file]).catch(() => undefined)
  }
}

/** combos.json, from before kits had their name: saved again as kits.json, the old file kept in backups. */
async function migrateRegistry($: $T, p: Paths): Promise<Registry> {
  const old = await readJson<{ keepGlobal?: string[]; combos?: Registry['kits'] }>($, p.legacyRegistry, {})
  const reg: Registry = { version: 1, keepGlobal: old.keepGlobal ?? [], kits: old.combos ?? {} }
  await saveRegistry($, p, reg)
  await $.process.run(['mkdir', '-p', `${p.dir}/backups`])
  await $.process.run(['mv', p.legacyRegistry, `${p.dir}/backups/combos.json`]).catch(() => undefined)
  return reg
}

async function saveRegistry($: $T, p: Paths, reg: Registry): Promise<void> {
  if (registryError) throw new Error(registryError)
  // The last good kits.json, should a save go wrong.
  if (await $.fs.exists(p.registry)) {
    await $.process.run(['mkdir', '-p', `${p.dir}/backups`])
    await $.process.run(['cp', p.registry, `${p.dir}/backups/kits.json.prev`]).catch(() => undefined)
  }
  await $.fs.write(p.registry, `${JSON.stringify(reg, null, 2)}\n`)
  await $.fs.write(p.script, generateScript(reg, p.libRoot))
  await lockDown($, p)
}

/** The startup files that do not load cc.sh yet. */
async function rcMissing($: $T, p: Paths): Promise<string[]> {
  const missing: string[] = []
  for (const file of p.rcFiles) {
    const text = await $.fs.read(file).catch(() => '')
    if (!text.includes(p.script)) missing.push(file)
  }
  return missing
}

const listFiles = (files: string[], home: string) => files.map(f => shortPath(f, home)).join(' and ')

/** Adds the one line that loads cc.sh to each startup file missing it, after asking once. */
async function ensureRc($: $T, p: Paths): Promise<boolean> {
  const missing = await rcMissing($, p)
  if (!missing.length) return true
  const answer = await $.ui
    .ask(`Add one line to ${listFiles(missing, p.home)} so the cc-* functions load in new shells?`, {
      header: 'Shell',
      options: ['Add it', 'Not now'],
    })
    .catch(() => 'Not now')
  if (answer !== 'Add it') return false
  for (const file of missing) {
    const text = await $.fs.read(file).catch(() => '')
    await $.fs.write(file, `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}\n${rcLineFor(file, p.script)}\n`)
  }
  return true
}

// ---------------------------------------------------------------- usage ledger

let ledger: Ledger | undefined
let sessions: Sessions | undefined
// What this session recorded since the last flush. Other sessions write the store too, so a flush
// adds these onto a fresh read rather than writing this session's copy over theirs.
let pendingUse: Ledger = {}
let pendingSessions: Sessions = {}
let flushTimer: { cancel: () => void } | undefined
/** The project usage is counted under: a git project's main checkout, worktrees folded in. */
let sessionProject: string | undefined
/** Where kits are turned on for this session: the checkout (worktree included) the session runs in. */
let sessionTarget: string | undefined
let sessionId: string | undefined
let knownPlugins: string[] = []
let knownKeys: string[] = []

async function loadLedger($: $T): Promise<Ledger> {
  ledger ??= ((await $.store.get('usage')) as Ledger | undefined) ?? {}
  return ledger
}

async function loadSessions($: $T): Promise<Sessions> {
  sessions ??= ((await $.store.get('sessions')) as Sessions | undefined) ?? {}
  return sessions
}

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Adds this session's pending uses onto what the store holds now, and reads back the merged whole. */
async function flushUsage($: $T): Promise<void> {
  const use = pendingUse
  const used = pendingSessions
  pendingUse = {}
  pendingSessions = {}
  try {
    const stored = ((await $.store.get('usage')) as Ledger | undefined) ?? {}
    await $.store.set('usage', mergeLedger(stored, use))
    const storedSessions = ((await $.store.get('sessions')) as Sessions | undefined) ?? {}
    const merged = trimSessions(mergeSessions(storedSessions, used))
    await $.store.set('sessions', merged)
    // Keep what was recorded while the store was being read.
    ledger = mergeLedger(copy(stored), pendingUse)
    sessions = mergeSessions(copy(merged), pendingSessions)
  } catch {
    // Not written: kept for the next flush.
    pendingUse = mergeLedger(use, pendingUse)
    pendingSessions = mergeSessions(used, pendingSessions)
  }
}

function scheduleFlush($: $T): void {
  if (flushTimer) return
  flushTimer = $.clock.after(5000, async () => {
    flushTimer = undefined
    await flushUsage($)
  })
}

const rootCache = new Map<string, string | null>()

/** The project a path belongs to: a repo's main worktree root, or the folder itself. */
async function projectRoot($: $T, path: string): Promise<string | null> {
  if (rootCache.has(path)) return rootCache.get(path) ?? null
  let root: string | null = null
  if (await $.fs.exists(path).catch(() => false)) {
    const git = await $.process
      .run(['git', '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 5000 })
      .catch(() => undefined)
    const common = git?.exitCode === 0 ? git.stdout.trim() : ''
    root = common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : path
  }
  rootCache.set(path, root)
  return root
}

function record($: $T, use: UsageEvent): void {
  if (!sessionProject || !ledger) return
  const key = classify(use, knownPlugins, k => matchesAny(k, knownKeys))
  if (!key) return
  void (async () => {
    const now = await $.clock.now()
    addUse(ledger!, key, sessionProject!, now)
    addUse(pendingUse, key, sessionProject!, now)
    // Installs used in the same sessions belong together: keep what this one used.
    if (sessionId && sessions) {
      for (const into of [sessions, pendingSessions]) {
        const cur = (into[sessionId] ??= { at: now, keys: [] })
        cur.at = now
        if (!cur.keys.includes(key)) cur.keys.push(key)
      }
    }
    scheduleFlush($)
  })()
}

/** One pass over the transcripts on disk, merged into the ledger. */
async function backfill($: $T, p: Paths): Promise<string> {
  const ran = await $.process
    .run(['python3', '-I', `${$.plugin.root}/scripts/backfill.py`, p.cfg], { timeoutMs: 600000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  const now = await $.clock.now()
  const prevSince = Number((await $.store.get('historySince')) ?? 0)
  if (ran.exitCode !== 0) {
    const text = `Backfill needs python3: ${ran.stderr.trim().slice(0, 200) || 'it did not run'}`
    // Counts then start now: say so, rather than leave the pane waiting for history forever.
    await $.store.set('backfillProblem', `${text}. Counts cover only use recorded since scopekeeper was installed.`)
    await $.store.set('backfilledAt', now)
    if (!prevSince) await $.store.set('historySince', now)
    return text
  }
  const { events, since, sessions: used = [] } = JSON.parse(ran.stdout) as {
    events: [UsageEvent['kind'], string, string, number, number][]
    since?: number | null
    sessions?: [string, number, [UsageEvent['kind'], string][]][]
  }
  const fresh: Ledger = {}
  for (const [kind, name, cwd, n, last] of events) {
    const key = classify({ kind, name }, knownPlugins, k => matchesAny(k, knownKeys))
    const root = key ? await projectRoot($, cwd) : null
    if (key && root) addUse(fresh, key, root, last, n)
  }
  // Backfill replaces what it covers; live use recorded since stays on top. Read fresh: other sessions write too.
  const live = ((await $.store.get('usage')) as Ledger | undefined) ?? {}
  for (const [key, byProject] of Object.entries(fresh)) {
    for (const [project, use] of Object.entries(byProject)) {
      const cur = live[key]?.[project]
      if (!cur || cur.n < use.n) addUse(live, key, project, use.last, use.n - (cur?.n ?? 0))
    }
  }
  await $.store.set('usage', live)
  ledger = mergeLedger(copy(live), pendingUse)
  const found: Sessions = {}
  for (const [id, at, uses] of used) {
    const keys = uses.flatMap(([kind, name]) => classify({ kind, name }, knownPlugins, k => matchesAny(k, knownKeys)) ?? [])
    if (keys.length) found[id] = { at, keys }
  }
  const known = trimSessions(mergeSessions(((await $.store.get('sessions')) as Sessions | undefined) ?? {}, found))
  await $.store.set('sessions', known)
  sessions = mergeSessions(copy(known), pendingSessions)
  await $.store.set('backfilledAt', now)
  // The ledger keeps what transcripts since deleted held, so the window only grows.
  const oldest = since || now
  await $.store.set('historySince', prevSince ? Math.min(prevSince, oldest) : oldest)
  await $.store.set('backfillProblem', '')
  return `Backfilled ${events.length} usage records from your transcripts.`
}

/** kit + project -> when it was enabled there (by the pane, or first seen on unused). */
type OnSince = Record<string, number>
const onKey = (kit: string, project: string) => `${kit}\n${project}`

async function loadOnSince($: $T): Promise<OnSince> {
  return { ...(((await $.store.get('onSince')) as OnSince | undefined) ?? {}) }
}

async function markOn($: $T, kit: string, project: string, on: boolean): Promise<void> {
  const map = await loadOnSince($)
  if (on) map[onKey(kit, project)] = await $.clock.now()
  else delete map[onKey(kit, project)]
  await $.store.set('onSince', map)
}

// ---------------------------------------------------------------- inventory

type Installed = Record<string, { scope: string; projectPath?: string }[]>
type GlobalJson = {
  mcpServers?: Record<string, Record<string, unknown>>
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>
}

async function inventory($: $T, p: Paths, reg: Registry) {
  const installed = (await readJson<{ plugins?: Installed }>($, `${p.cfg}/plugins/installed_plugins.json`, {})).plugins ?? {}
  const global = await readJson<GlobalJson>($, p.globalJson, {})
  const items: GlobalItem[] = []
  const add = (item: Omit<GlobalItem, 'claim'>) => items.push({ ...item, claim: claimOf(item.id, reg) })

  for (const [id, entries] of Object.entries(installed)) {
    // scopekeeper is global by design: never offer to remove itself.
    if (pluginName(id) === $.plugin.name) continue
    if (entries.some(e => e.scope === 'user')) add({ id: `plugin:${pluginName(id)}`, kind: 'plugin', name: pluginName(id), ref: id })
  }
  for (const entry of await $.fs.list(`${p.cfg}/skills`).catch(() => [])) {
    const path = `${p.cfg}/skills/${entry.name}`
    if (!entry.name.startsWith('.') && (await $.fs.exists(`${path}/SKILL.md`))) {
      add({ id: `skill:${entry.name}`, kind: 'skill', name: entry.name, ref: path })
    }
  }
  for (const entry of await $.fs.list(`${p.cfg}/agents`).catch(() => [])) {
    if (entry.name.endsWith('.md')) {
      const name = entry.name.slice(0, -3)
      add({ id: `agent:${name}`, kind: 'agent', name, ref: `${p.cfg}/agents/${entry.name}` })
    }
  }
  for (const name of Object.keys(global.mcpServers ?? {})) add({ id: `mcp:${name}`, kind: 'mcp', name, ref: name })

  knownPlugins = [...new Set([...Object.keys(installed).map(pluginName),
    ...Object.values(reg.kits).flatMap(c => c.parts.flatMap(x => (x.kind === 'plugin' ? [pluginName(x.id)] : [])))])]
  knownKeys = [...items.map(i => i.id), ...Object.values(reg.kits).flatMap(kitUsage)]
  return { items, installed, global }
}

async function partOn(
  $: $T, p: Paths, part: Part, project: string, installed: Installed, global: GlobalJson,
): Promise<boolean> {
  switch (part.kind) {
    case 'plugin':
      return (installed[part.id] ?? []).some(e => e.scope !== 'user' && e.projectPath === project)
    case 'mcp': {
      if (global.projects?.[project]?.mcpServers?.[part.name]) return true
      const shared = await readJson<{ mcpServers?: Record<string, unknown> }>($, `${project}/.mcp.json`, {})
      return Boolean(shared.mcpServers?.[part.name])
    }
    case 'git-skills': {
      const names = (await $.fs.list(`${project}/.claude/skills`).catch(() => [])).map(e => e.name)
      // The clone says which folders are the kit's: a skill of the person's own named alike is not it.
      const theirs = (await $.fs.list(skillsSource(part, p.libRoot)).catch(() => []))
        .map(e => e.name).filter(n => !n.startsWith('.') && matchesAny(n, [part.match]))
      if (theirs.length) return theirs.every(n => names.includes(n))
      return names.some(n => matchesAny(n, [part.match]))
    }
    case 'installer': {
      for (const raw of part.paths) {
        const clean = raw.replace(/\/+$/, '')
        const cut = clean.lastIndexOf('/')
        const names = (await $.fs.list(`${project}/${clean.slice(0, cut)}`).catch(() => [])).map(e => e.name)
        if (!names.some(n => matchesAny(n, [clean.slice(cut + 1)]))) return false
      }
      return true
    }
  }
}

/** The parts of a kit that are not in the wanted state in one project, read from disk now. */
async function partsNot($: $T, p: Paths, kit: Kit, project: string, wantOn: boolean): Promise<string[]> {
  const installed = (await readJson<{ plugins?: Installed }>($, `${p.cfg}/plugins/installed_plugins.json`, {})).plugins ?? {}
  const global = await readJson<GlobalJson>($, p.globalJson, {})
  const states = await Promise.all(kit.parts.map(part => partOn($, p, part, project, installed, global)))
  return kit.parts.filter((_, i) => states[i] !== wantOn).map(partSummary)
}

/** Projects worth offering: not home, not a folder that only holds other projects. */
async function eligible($: $T, p: Paths, projects: string[]): Promise<string[]> {
  const out: string[] = []
  for (const project of projects) {
    if (project === p.home || project === '/' || p.home.startsWith(`${project}/`)) continue
    if (project === p.cfg || project.startsWith(`${p.cfg}/`)) continue
    const isContainer = projects.some(o => o.startsWith(`${project}/`)) && !(await $.fs.exists(`${project}/.git`))
    if (!isContainer && (await $.fs.exists(project))) out.push(project)
  }
  return out
}

async function scan($: $T, rcOption: string): Promise<Snapshot> {
  const p = await paths($, rcOption)
  const reg = await loadRegistry($, p)
  const { items, installed, global } = await inventory($, p, reg)
  const usage = await loadLedger($)
  const problems: string[] = []
  const now = await $.clock.now()

  const usesOf = (globs: string[]) => {
    const byProject = new Map<string, { n: number; last: number }>()
    for (const [key, projects] of Object.entries(usage)) {
      if (!matchesAny(key, globs)) continue
      for (const [project, use] of Object.entries(projects)) {
        const cur = byProject.get(project) ?? { n: 0, last: 0 }
        byProject.set(project, { n: cur.n + use.n, last: Math.max(cur.last, use.last) })
      }
    }
    return byProject
  }

  // This session's project counts even before anything was used in it, so its kits can be turned on.
  const allProjects = [...new Set([
    ...Object.values(usage).flatMap(Object.keys),
    ...Object.values(installed).flatMap(es => es.flatMap(e => (e.projectPath ? [e.projectPath] : []))),
    ...Object.entries(global.projects ?? {}).flatMap(([pr, c]) => (Object.keys(c.mcpServers ?? {}).length ? [pr] : [])),
    ...(sessionProject ? [sessionProject] : []),
    ...(sessionTarget ? [sessionTarget] : []),
  ])]
  const ok = new Set(await eligible($, p, allProjects))
  // In a worktree, kits are turned on in the worktree, while use is counted under the main checkout.
  const cwdProject = sessionTarget && ok.has(sessionTarget) ? sessionTarget
    : sessionProject && ok.has(sessionProject) ? sessionProject : ''
  const cwdUsage = sessionProject && ok.has(sessionProject) ? sessionProject : cwdProject
  const useIn = (used: Map<string, { n: number; last: number }>, project: string) =>
    used.get(project) ?? (project === cwdProject && cwdUsage !== cwdProject ? used.get(cwdUsage) : undefined)

  const rows: ItemRow[] = items.map(item => {
    const uses = [...usesOf([item.id])].filter(([pr]) => ok.has(pr))
      .map(([project, u]) => ({ project, ...u })).sort((a, b) => b.n - a.n)
    return { ...item, uses, total: uses.reduce((s, u) => s + u.n, 0), last: Math.max(0, ...uses.map(u => u.last)) }
  })

  const onSince = await loadOnSince($)
  let onSinceChanged = false
  const kits: KitRow[] = []
  for (const [name, kit] of Object.entries(reg.kits)) {
    const used = usesOf(kitUsage(kit))
    const projects: KitProject[] = []
    for (const project of [...ok]) {
      const states = await Promise.all(kit.parts.map(part => partOn($, p, part, project, installed, global)))
      const on = states.filter(Boolean).length
      const use = useIn(used, project)
      const key = onKey(name, project)
      if (on === 0 && key in onSince) {
        delete onSince[key]
        onSinceChanged = true
      }
      // Enabled outside the pane (cc-<name> in a shell) and not used yet: start its clock now.
      if (on > 0 && !use && !onSince[key]) {
        onSince[key] = now
        onSinceChanged = true
      }
      if (on === 0 && !use) continue
      projects.push({
        project,
        status: on === states.length ? 'on' : on > 0 ? 'partial' : 'off',
        n: use?.n ?? 0,
        last: use?.last ?? 0,
        since: onSince[key] ?? 0,
        ...(on > 0 && on < states.length ? { off: kit.parts.filter((_, i) => !states[i]).map(partSummary) } : {}),
      })
    }
    projects.sort((a, b) => b.last - a.last)
    kits.push({
      name,
      summary: kit.description ?? kit.parts.map(partSummary).join(' + '),
      parts: kit.parts.map(partLine),
      globals: rows.filter(r => r.claim === `kit:${name}`).map(r => r.id),
      projects,
    })
  }
  if (onSinceChanged) await $.store.set('onSince', onSince)

  if (registryError) problems.push(registryError)
  for (const bad of invalidKits(reg)) problems.push(`kit ${bad.name} has no cc-* functions: ${bad.errors.join('; ')}`)
  if (!registryError && !(await $.fs.exists(p.script)) && Object.keys(reg.kits).length) await saveRegistry($, p, reg)
  const missing = await rcMissing($, p)
  const isRc = missing.length === 0
  if (Object.keys(reg.kits).length) {
    if (!isRc) problems.push(`cc-* functions are not loaded by ${listFiles(missing, p.home)}`)
    if (p.rcNote) problems.push(p.rcNote)
  }
  const backfillProblem = String((await $.store.get('backfillProblem')) ?? '')
  if (backfillProblem) problems.push(backfillProblem)

  return {
    scannedAt: now,
    home: p.home,
    cwdProject,
    ...(cwdUsage !== cwdProject ? { cwdUsage } : {}),
    items: rows,
    kits: kits.sort((a, b) => a.name.localeCompare(b.name)),
    ...suggest(rows, coUse(await loadSessions($)), cwdUsage),
    backfilledAt: Number((await $.store.get('backfilledAt')) ?? 0),
    historySince: Number((await $.store.get('historySince')) ?? 0),
    historyProblem: backfillProblem,
    rcLoaded: isRc,
    problems,
  }
}

/** What is waiting on the person: the header's to-do line. */
function todo(snap: Snapshot, staleDays: number) {
  const projects = snap.kits.flatMap(c => c.projects)
  return {
    unsorted: snap.items.filter(i => i.claim === 'new').length,
    toAdopt: snap.items.filter(i => i.claim.startsWith('kit:')).length,
    usedOff: projects.filter(pr => pr.status !== 'on' && pr.n > 0).length,
    stale: projects.filter(pr => isStale(pr, snap.scannedAt, staleDays)).length,
  }
}

/** A kit's state in one project, `off` where it was neither on nor used. */
const statusIn = (c: KitRow, project: string) => c.projects.find(pr => pr.project === project)

/** Used in this project but off there: the first thing worth turning on. */
function usedOffHere(c: KitRow, project: string): boolean {
  const pr = statusIn(c, project)
  return pr !== undefined && pr.status !== 'on' && pr.n > 0
}

/** The session's first scan, which the once-per-conversation context waits on briefly. */
let resolveFirstScan: (snap: Snapshot | null) => void = () => undefined
const firstScan = new Promise<Snapshot | null>(resolve => { resolveFirstScan = resolve })

async function rescan($: $T, opts: Opts): Promise<Snapshot> {
  const snap = await scan($, opts.rc)
  await update($, snapshot, () => snap)
  return snap
}

// ---------------------------------------------------------------- actions

let isRunning = false

/** A cancelled question changed nothing, so it leaves no line behind: the toast said it already. */
const worthLogging = (line: string) => line !== '' && !/cancelled\.$/i.test(line)

async function note($: $T, line: string): Promise<void> {
  if (!worthLogging(line)) return
  await update($, log, lines => [...lines, line].slice(-6))
}

/** Runs one action at a time, with the pane showing what is going on. `quiet` skips the log and toast. */
async function act($: $T, opts: Opts, label: string, work: () => Promise<string>, quiet = false): Promise<string> {
  if (isRunning) {
    $.ui.toast('scope: another action is still running')
    return 'Another scopekeeper action is still running.'
  }
  isRunning = true
  await update($, busy, () => label)
  try {
    const text = await work()
    if (quiet) return text
    await note($, text)
    $.ui.toast(text.split('\n')[0] ?? text)
    return text
  } catch (error) {
    const text = `${label} failed: ${String(error).slice(0, 300)}`
    await note($, text)
    $.ui.toast(text)
    return text
  } finally {
    await update($, busy, () => '')
    isRunning = false
    await rescan($, opts).catch(() => undefined)
  }
}

async function runKit($: $T, p: Paths, name: string, project: string, off: boolean) {
  const fn = `cc-${name}${off ? '-off' : ''}`
  const ran = await $.process
    .run(['bash', '-c', '. "$0" && "$1"', p.script, fn], { cwd: project, timeoutMs: 600000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  return { ok: ran.exitCode === 0, out: `${ran.stdout}\n${ran.stderr}`.trim().split('\n').slice(-3).join(' ') }
}

async function backupDir($: $T, p: Paths): Promise<string> {
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const dir = `${p.dir}/backups/${stamp}`
  await $.process.run(['mkdir', '-p', `${dir}/skills`, `${dir}/agents`])
  for (const file of [`${p.cfg}/settings.json`, p.globalJson]) {
    await $.process.run(['cp', file, `${dir}/`]).catch(() => undefined)
  }
  return dir
}

/** Takes one global item out of the user scope; skills and agents are moved, not deleted. */
async function removeGlobal($: $T, item: GlobalItem, backup: string): Promise<string | undefined> {
  const argv =
    item.kind === 'plugin' ? ['claude', 'plugin', 'uninstall', item.ref, '-s', 'user']
    : item.kind === 'mcp' ? ['claude', 'mcp', 'remove', item.ref, '-s', 'user']
    : ['mv', item.ref, `${backup}/${item.kind}s/`]
  const ran = await $.process.run(argv, { timeoutMs: 120000 }).catch((e: unknown) => ({ exitCode: -1, stderr: String(e), stdout: '' }))
  return ran.exitCode === 0 ? undefined : `${item.id}: ${ran.stderr.trim().slice(0, 160)}`
}

/**
 * After a change that reaches this session (its own project, or the global scope), reloads plugins
 * once the session is idle. Returns what to tell the person about open sessions.
 */
async function reloadAfter($: $T, touched: string[] | 'global'): Promise<string> {
  const current = sessionTarget ?? sessionProject
  const isHere = touched === 'global' || (current !== undefined && touched.includes(current))
  const elsewhere = touched !== 'global' && touched.some(t => t !== current)
  if (!isHere) return ' Run /reload-plugins there if a session is open.'
  const canReload = (await $.command.list().catch(() => [])).some(c => c.name === 'reload-plugins')
  if (!canReload) return ' Run /reload-plugins.'
  // Detached: a hook the turn waits on (the enable_kit tool) may not run a command itself.
  $.clock.after(0, () => {
    void $.command.run({ command: 'reload-plugins', args: '' }).catch(() => $.ui.toast('scope: could not reload plugins: run /reload-plugins'))
  })
  return elsewhere ? ' Reloading plugins here; run /reload-plugins in other open sessions there.' : ' Reloading plugins.'
}

async function enable($: $T, opts: Opts, name: string, project: string, off: boolean, reload = true): Promise<string> {
  const p = await paths($, opts.rc)
  const reg = await loadRegistry($, p)
  const kit = reg.kits[name]
  if (!kit) return `No kit named ${name}.`
  const bad = validateKit(name, kit)
  if (bad.length) return `${name} cannot run until kits.json is fixed: ${bad.join('; ')}`
  await saveRegistry($, p, reg)
  const { ok, out } = await runKit($, p, name, project, off)
  const where = shortPath(project, p.home)
  if (!ok) return `cc-${name}${off ? '-off' : ''} failed in ${where}: ${out}`
  // The function's exit status is not the whole story: check the parts themselves.
  const wrong = await partsNot($, p, kit, project, !off)
  if (wrong.length) return `cc-${name}${off ? '-off' : ''} ran in ${where}, but ${wrong.join(', ')} ${off ? 'is still on' : 'is not on'}.`
  await markOn($, name, project, !off)
  return `${off ? 'Removed' : 'Enabled'} ${name} ${off ? 'from' : 'in'} ${where}.${reload ? await reloadAfter($, [project]) : ''}`
}

/** Enable a kit everywhere it was used, then take its parts out of the global scope. `answer` skips the question. */
async function adopt($: $T, opts: Opts, name: string, answer?: 'Adopt' | 'Only enable'): Promise<string> {
  const p = await paths($, opts.rc)
  const snap = (await read($, snapshot)) ?? (await rescan($, opts))
  const row = snap.kits.find(c => c.name === name)
  if (!row) return `No kit named ${name}.`
  const targets = row.projects.filter(pr => pr.status !== 'on' && pr.n > 0).map(pr => pr.project)
  const globals = snap.items.filter(i => row.globals.includes(i.id))
  const plan = [
    targets.length ? `enable it in ${targets.length} project${targets.length > 1 ? 's' : ''} where it was used (${targets.map(t => shortPath(t, p.home)).join(', ')})` : '',
    globals.length ? `remove ${globals.length} global install${globals.length > 1 ? 's' : ''} (${globals.map(g => g.name).join(', ')}; backed up first)` : '',
  ].filter(Boolean)
  if (!plan.length) return `${name} is already per-project everywhere it was used.`
  const installs = targets.length ? ` In each project it installs: ${installList(row)}.` : ''
  answer ??= await $.ui
    .ask(`Adopt ${name}: ${plan.join(', then ')}?${installs}`, { header: 'Adopt', options: ['Adopt', 'Only enable', 'Cancel'] })
    .then(a => (a === 'Adopt' || a === 'Only enable' ? a : undefined))
    .catch(() => undefined)
  if (!answer) return `Adopting ${name} cancelled.`

  await ensureRc($, p)
  await saveRegistry($, p, await loadRegistry($, p))
  const failed: string[] = []
  for (const project of targets) {
    await update($, busy, () => `Enabling ${name} in ${shortPath(project, p.home)}…`)
    // enable checks every part is on before it says Enabled.
    const text = await enable($, opts, name, project, false, false)
    if (!text.startsWith('Enabled')) failed.push(text)
  }
  if (failed.length) return `Enabled ${name} in ${targets.length - failed.length}/${targets.length}; kept the globals because some failed:\n${failed.join('\n')}`
  if (answer !== 'Adopt' || !globals.length) return `Enabled ${name} in ${targets.length} project(s).${targets.length ? await reloadAfter($, targets) : ''}`

  // The globals go only once every project the kit is on in really has it, read from disk again.
  const kit = (await loadRegistry($, p)).kits[name]
  const onIn = [...new Set([...targets, ...row.projects.filter(pr => pr.status === 'on').map(pr => pr.project)])]
  const missing: string[] = []
  for (const project of kit ? onIn : []) {
    const off = await partsNot($, p, kit!, project, true)
    if (off.length) missing.push(`${shortPath(project, p.home)}: ${off.join(', ')} not on`)
  }
  if (!kit || missing.length) return `Enabled ${name}, but kept the globals: ${kit ? missing.join('; ') : 'the kit is gone from kits.json'}`

  await update($, busy, () => `Removing ${name}'s global installs…`)
  const backup = await backupDir($, p)
  // One at a time: claude plugin uninstall and claude mcp remove each rewrite the same settings files.
  const errors: string[] = []
  for (const g of globals) {
    const error = await removeGlobal($, g, backup)
    if (error) errors.push(error)
  }
  const still = new Set((await inventory($, p, await loadRegistry($, p))).items.map(i => i.id))
  const left = globals.filter(g => still.has(g.id)).map(g => g.name)
  const reload = await reloadAfter($, 'global')
  return errors.length || left.length
    ? `Enabled ${name}; some globals are still installed (${left.join(', ') || 'see below'}):\n${errors.join('\n')}${reload}`
    : `Adopted ${name}: on in ${plural(onIn.length, 'project')}, ${plural(globals.length, 'global')} removed (backup: ${shortPath(backup, p.home)}).${reload}`
}

async function keepGlobal($: $T, opts: Opts, ids: string[], keep: boolean): Promise<string> {
  const p = await paths($, opts.rc)
  const reg = await loadRegistry($, p)
  const set = new Set(reg.keepGlobal)
  for (const id of ids) keep ? set.add(id) : set.delete(id)
  await saveRegistry($, p, { ...reg, keepGlobal: [...set].sort() })
  return keep ? `Keeping ${ids.join(', ')} global.` : `${ids.join(', ')} back to unsorted.`
}

async function removeOne($: $T, opts: Opts, id: string): Promise<string> {
  const p = await paths($, opts.rc)
  const snap = await read($, snapshot)
  const item = snap?.items.find(i => i.id === id)
  if (!snap || !item) return `${id} is not installed globally.`
  // Before the transcripts are read every count is 0: never let that pass for "unused".
  if (!snap.backfilledAt) return `Usage history is still loading; ${item.name} was kept. Try again once the counts are in.`
  const since = snap.historySince ? ` since ${day(snap.historySince, snap.scannedAt)}` : ''
  const where = item.uses.length
    ? ` It was used in ${plural(item.uses.length, 'project')}${since}; no kit will bring it back.`
    : ` No recorded use${since}.`
  const answer = await $.ui
    .ask(`Remove ${item.kind} ${item.name} from your global setup?${where}`, { header: 'Remove', options: ['Remove', 'Cancel'] })
    .catch(() => 'Cancel')
  if (answer !== 'Remove') return `Kept ${item.name}.`
  const backup = await backupDir($, p)
  const error = await removeGlobal($, item, backup)
  return error ?? `Removed ${item.name} (backup: ${shortPath(backup, p.home)}).${await reloadAfter($, 'global')}`
}

/** The parts a kit installs, cut to fit a question. */
const installList = (row: KitRow) => row.parts.map(line => clip(line, 140)).join('; ')

/** Asks before enabling (saying what it installs and runs) or removing a kit in one project. */
async function toggleKit($: $T, opts: Opts, row: KitRow, project: string, off: boolean, home: string): Promise<string> {
  const where = shortPath(project, home)
  const question = off
    ? `Remove ${row.name} from ${where}?`
    : `Enable ${row.name} in ${where}? It installs: ${installList(row)}.`
  const answer = await $.ui
    .ask(question, { header: 'Kit', options: [off ? 'Remove' : 'Enable', 'Cancel'] })
    .catch(() => 'Cancel')
  return answer === 'Remove' || answer === 'Enable' ? enable($, opts, row.name, project, off) : 'Cancelled.'
}

/** Turns on, after one question, every kit used in this project but off here. */
async function turnOnUsed($: $T, opts: Opts, rows: KitRow[], project: string, home: string): Promise<string> {
  const where = shortPath(project, home)
  const names = rows.map(r => r.name).join(', ')
  const answer = await $.ui
    .ask(`Enable ${names} in ${where}? It installs: ${rows.map(installList).join('; ')}.`, { header: 'Kit', options: ['Enable', 'Cancel'] })
    .catch(() => 'Cancel')
  if (answer !== 'Enable') return 'Cancelled.'
  const failed: string[] = []
  for (const row of rows) {
    await update($, busy, () => `Enabling ${row.name}…`)
    const text = await enable($, opts, row.name, project, false, false)
    if (!text.startsWith('Enabled')) failed.push(text)
  }
  const reload = failed.length < rows.length ? await reloadAfter($, [project]) : ''
  return failed.length
    ? `Enabled ${rows.length - failed.length}/${rows.length}:\n${failed.join('\n')}${reload}`
    : `Enabled ${names} in ${where}.${reload}`
}

/** Takes a kit out of every project where it sat unused for staleDays. */
async function prune($: $T, opts: Opts, name: string): Promise<string> {
  const p = await paths($, opts.rc)
  const row = (await read($, snapshot))?.kits.find(c => c.name === name)
  if (!row) return `No kit named ${name}.`
  const now = await $.clock.now()
  const stale = row.projects.filter(pr => isStale(pr, now, opts.staleDays)).map(pr => pr.project)
  if (!stale.length) return `${name} is not stale anywhere.`
  const answer = await $.ui
    .ask(`Remove ${name} from ${plural(stale.length, 'project')} where it went unused for ${opts.staleDays}+ days (${stale.map(s => shortPath(s, p.home)).join(', ')})?`,
      { header: 'Prune', options: ['Remove', 'Cancel'] })
    .catch(() => 'Cancel')
  if (answer !== 'Remove') return 'Cancelled.'
  const failed: string[] = []
  for (const project of stale) {
    await update($, busy, () => `Removing ${name} from ${shortPath(project, p.home)}…`)
    const text = await enable($, opts, name, project, true, false)
    if (!text.startsWith('Removed')) failed.push(text)
  }
  const reload = failed.length < stale.length ? await reloadAfter($, stale) : ''
  return failed.length
    ? `Removed ${name} from ${stale.length - failed.length}/${stale.length}:\n${failed.join('\n')}${reload}`
    : `Removed ${name} from ${plural(stale.length, 'stale project')}.${reload}`
}

/**
 * Turns a suggested bundle into a kit, on in the projects that used it, its globals removed.
 * Plugins and MCP servers are done here; skills and agents go to Claude, which works out where they come from.
 */
async function makeLocal($: $T, opts: Opts, bundle: Bundle, items: ItemRow[]): Promise<string> {
  const members = items.filter(i => bundle.ids.includes(i.id))
  if (!bundle.direct) {
    void $.prompt.submit({
      text: `${TRIAGE}\n\nStart with these only; they look like one kit (${bundle.why}): ${bundle.ids.join(', ')}. Suggested name: ${bundle.name}.`,
    })
    return `Asking Claude to set up ${bundle.name}…`
  }
  const p = await paths($, opts.rc)
  const reg = await loadRegistry($, p)
  let name = bundle.name
  for (let n = 2; reg.kits[name]; n++) name = `${bundle.name}-${n}`
  const where = bundle.projects.map(pr => shortPath(pr.project, p.home))
  const answer = await $.ui
    .ask(`Make ${members.map(m => m.name).join(', ')} local as cc-${name}? It turns ${members.length > 1 ? 'them' : 'it'} on in ${where.join(', ')}, then removes the global install${members.length > 1 ? 's' : ''} (backed up first).`,
      { header: 'Make local', options: ['Make local', 'Only enable', 'Cancel'] })
    .catch(() => 'Cancel')
  if (answer !== 'Make local' && answer !== 'Only enable') return 'Cancelled.'
  const { global } = await inventory($, p, reg)
  const parts: Part[] = members.map(m => (m.kind === 'plugin'
    ? { kind: 'plugin', id: m.ref }
    : { kind: 'mcp', name: m.name, config: global.mcpServers?.[m.name] ?? {} }))
  const saved = await saveKit($, opts, name, { parts })
  if (saved.startsWith('Not saved')) return saved
  await rescan($, opts)
  return adopt($, opts, name, answer === 'Make local' ? 'Adopt' : 'Only enable')
}

async function saveKit($: $T, opts: Opts, name: string, kit: Kit): Promise<string> {
  const errors = validateKit(name, kit)
  if (errors.length) return `Not saved:\n- ${errors.join('\n- ')}`
  const p = await paths($, opts.rc)
  const reg = await loadRegistry($, p)
  const isNew = !reg.kits[name]
  reg.kits[name] = { description: kit.description, parts: kit.parts }
  if (registryError) return `Not saved:\n- ${registryError}`
  await saveRegistry($, p, reg)
  $.ui.invalidate('prompt.context')
  const missing = await rcMissing($, p)
  return `${isNew ? 'Saved' : 'Updated'} kit ${name}: cc-${name} and cc-${name}-off are in ${shortPath(p.script, p.home)}` +
    `${missing.length ? ` (not loaded by ${listFiles(missing, p.home)} yet: Adopt adds the line)` : ''}. The person adopts it from the /scope pane.`
}

const TRIAGE = `Triage my global Claude Code installs with the scopekeeper tools.
1. Call ${TOOL('inventory')}: it lists every user-scope plugin, skill, agent and MCP server, how much each was used and in which projects, and the kits I already have.
2. For each item whose claim is "new", find out how it was installed: a plugin is name@marketplace; for a skill, check whether ~/.claude/skills/<name> is a symlink and where it points, look for a lock file (~/.agents/.skill-lock.json) or a README naming an installer (\`npx <tool> install --project\`); find which skill or installer ships each agent. Group what belongs together, starting from inventory's \`suggested.bundles\` (detected from co-use, names and shared projects): a plugin and the MCP server or skill it needs, a skill and its agents.
3. Decide per group: keep global (general purpose, used across most projects, or the statusline/terminal kind), or a kit. Ask me with AskUserQuestion, one question per group, your recommendation first.
4. Save what I confirm: ${TOOL('save_kit')} for kits, ${TOOL('keep_global')} for keep-globals.
Never install, uninstall, move or delete anything yourself: I adopt kits from the /scope pane, which enables them in the right projects and removes the globals.`

// ---------------------------------------------------------------- the pane

type Opts = { rc: string; staleDays: number }

const KIND = { plugin: 'plugin', skill: 'skill', agent: 'agent', mcp: 'mcp' } as const

/** Each view's help: what it shows and what to do there, for someone who has never used scopekeeper. */
type HelpView = 'local' | 'globals' | 'kits'
// One short line each, so the box fits the pane's default width without wrapping (a test holds it).
// Runs are styled as the pane draws the same thing: headings bold, hotkeys in the accent color,
// ● green, ◆ and what needs a look yellow; the line that says what the view is for, and the reassurance, dim.
type HelpRun = string | { t: string; s: 'head' | 'key' | 'on' | 'warn' }
type HelpLine = HelpRun[] | { dim: string }
const bold = (t: string) => ({ t, s: 'head' } as const)
const hot = (t: string) => ({ t, s: 'key' } as const)
const green = (t: string) => ({ t, s: 'on' } as const)
const yellow = (t: string) => ({ t, s: 'warn' } as const)
const HELP: Record<HelpView, HelpLine[]> = {
  local: [
    { dim: 'Load tools only in the projects that need them.' },
    [bold('In this project'), ': your kits (groups of tools)'],
    ['  ', green('●'), ' on · ○ off - turn tool on/off'],
    ['  ', yellow('used 3d ago'), ' - tool used here previously, is off'],
    [bold('Global'), ':'],
    ['  ', yellow('◆'), ' loads everywhere. Enter to open, then:'],
    ['  ', hot('l'), ': Make local (only where used, global removed)'],
    ['  ', hot('k'), ': Keep global (leave it loading everywhere)'],
  ],
  globals: [
    { dim: 'Global installs load in every project, used or not.' },
    [bold('status')],
    ['  ', yellow('new'), ': unsorted · keep: stays global on purpose'],
    ['  ', yellow('→ name'), ': that kit covers it, but it is still global'],
    ['Enter opens a row, then:'],
    ['  ', hot('k'), ': Keep global · ', hot('x'), ': Remove global'],
    ['  ', hot('m'), ': Make a new kit from global'],
    ['  ', hot('o'), ': Adopt (turns existing kit on, removes the global)'],
  ],
  kits: [
    { dim: 'A kit is a group of tools you turn on per project.' },
    [bold('on in'), '  how many projects have it fully on'],
    [bold('to do'), '  ', yellow('adopt'), ': its tools are still installed globally'],
    ['       ', yellow('turn on N'), ': used but off in N projects'],
    ['       ', yellow('prune N'), ': on, but unused lately, in N projects'],
    ['Enter opens a kit, then:'],
    ['  Enter on a project turns it on or off there'],
    ['  ', hot('o'), ': Adopt · ', hot('e'), ': Enable here · ', hot('p'), ': Prune stale'],
  ],
}

/**
 * A view's help as a bordered box, each line in its own `help:<n>` row so a test can measure it.
 * h: Hide help sits in the top border, drawn over it after the box; the key row offers h: Help once hidden.
 */
function helpBox({ Box, Text, Button }: ReturnType<$T['ui']['resolve']>, which: HelpView, width: number, onHide: () => void) {
  return (
    <Box key="help-box" width={width}>
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={width}>
        {HELP[which].map((line, n) => (
          <Box key={`help:${n}`}>
            {'dim' in line ? <Text dimColor>{line.dim}</Text> : (
              <Text>
                {line.map(r => typeof r === 'string' ? r
                  : <Text bold={r.s === 'head'} color={r.s === 'key' ? 'suggestion' : r.s === 'on' ? 'green' : r.s === 'warn' ? 'yellow' : undefined}>{r.t}</Text>)}
              </Text>
            )}
          </Box>
        ))}
      </Box>
      <Box position="absolute" top={0} left={1}>
        <Text> </Text>
        <Button key="help" hotkey="h" plain onPress={onHide}>Hide help</Button>
        <Text> </Text>
      </Box>
    </Box>
  )
}

/** h shows or hides a view's help; hidden stays hidden in later sessions. */
async function toggleHelp($: $T, which: HelpView): Promise<void> {
  await update($, helpHidden, h => (h.includes(which) ? h.filter(x => x !== which) : [...h, which]))
  await $.store.set('helpHidden', await read($, helpHidden))
}

const openAdvanced = ($: $T) => $.ui.open({ id: ADVANCED, title: 'Scope · all projects', focus: true, columns: 64 })
const openLocal = ($: $T) => $.ui.open({ id: PANE, title: 'Scope · Local', focus: true, columns: 56 })

/** One mode at a time: the open pane holds the keys and would refuse the other's focus, so it closes first. */
async function switchMode($: $T, to: 'local' | 'advanced') {
  await $.ui.close({ id: to === 'advanced' ? PANE : ADVANCED })
  return to === 'advanced' ? openAdvanced($) : openLocal($)
}

async function setView($: $T, next: Partial<View>): Promise<void> {
  await update($, view, v => ({ ...v, ...next }))
}

const kitOf = (claim: string) => claim.slice('kit:'.length)

/** The status cell: an install a kit covers is still global, so it waits on Adopt. */
function claimText(claim: string): string {
  return claim === 'new' ? 'new' : claim === 'keep' ? 'keep' : `→ ${kitOf(claim)}`
}

const PART_SCHEMA = {
  type: 'object',
  oneOf: [
    { properties: { kind: { const: 'plugin' }, id: { type: 'string', description: 'name@marketplace' } }, required: ['kind', 'id'] },
    { properties: { kind: { const: 'mcp' }, name: { type: 'string' }, config: { type: 'object', description: 'the server JSON, as `claude mcp add-json` takes it' } }, required: ['kind', 'name', 'config'] },
    { properties: { kind: { const: 'git-skills' }, repo: { type: 'string', description: 'git URL' }, dir: { type: 'string', description: 'folder of skills in the repo, default "skills"' }, match: { type: 'string', description: 'glob of skill folder names, e.g. "remotion-*"' }, lib: { type: 'string' } }, required: ['kind', 'repo', 'match'] },
    { properties: { kind: { const: 'installer' }, run: { type: 'string', description: 'shell command run in the project; must install for Claude Code only, without hooks' }, paths: { type: 'array', items: { type: 'string' }, description: 'project-relative paths it writes (globs allowed), kept out of git and removed by cc-<name>-off' }, usage: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'run', 'paths'] },
  ],
}

export const register: Register = (on, options) => {
  const opts: Opts = {
    rc: typeof options.shellRc === 'string' ? options.shellRc : '',
    staleDays: typeof options.staleDays === 'number' ? options.staleDays : 30,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'scope',
      description: 'Global installs vs real usage, and per-project cc-* kits',
      argumentHint: '[advanced | audit | triage | backfill | enable <kit> | off <kit> | adopt <kit>]',
    })
    await $.tool.register({
      name: 'inventory',
      description: 'scopekeeper: every user-scope plugin, skill, agent and MCP server with its usage per project, its claim (keep / kit:<name> / new), and the saved kits with where each is enabled.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'save_kit',
      description: 'scopekeeper: save (or replace) a kit: the parts that cc-<name> installs in a project at local scope, kept out of git. Regenerates the cc-* functions. Installs and removes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'a-z, 0-9, -; becomes cc-<name>' },
          description: { type: 'string' },
          parts: { type: 'array', items: PART_SCHEMA },
        },
        required: ['name', 'parts'],
      },
    })
    await $.tool.register({
      name: 'keep_global',
      description: 'scopekeeper: mark global installs as intentionally global (or, with keep: false, unsorted again). Ids as inventory gives them.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } }, keep: { type: 'boolean' } },
        required: ['ids'],
      },
    })
    await $.tool.register({
      name: 'enable_kit',
      description: 'scopekeeper: turn on one of the person\'s kits in this project (local scope, kept out of git), after they confirm. Use when a request needs tools from a kit that is not on here.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'the kit name, as listed in the scopekeeperKits context' } },
        required: ['name'],
      },
    })
    void (async () => {
      sessionProject = (await projectRoot($, e.cwd)) ?? undefined
      const top = await $.process
        .run(['git', '-C', e.cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
        .catch(() => undefined)
      sessionTarget = top?.exitCode === 0 && top.stdout.trim() ? top.stdout.trim() : sessionProject
      await lockDown($, await paths($, opts.rc))
      // The kits tab was the combos tab: help hidden there stays hidden.
      const hidden = ((await $.store.get('helpHidden')) as string[] | undefined)?.map(h => (h === 'combos' ? 'kits' : h))
      if (hidden?.length) await update($, helpHidden, () => hidden)
      sessionId = await $.session.id()
      await loadLedger($)
      await loadSessions($)
      const snap = await rescan($, opts)
      resolveFirstScan(snap)
      // No historySince or sessions: backfilled by a version that did not record them; reading again only adds.
      const hasSessions = (await $.store.get('sessions')) !== undefined
      if (!snap.backfilledAt || !snap.historySince || !hasSessions) await backfill($, await paths($, opts.rc)).then(() => rescan($, opts))
    })().catch(() => resolveFirstScan(null))
    return started
  })

  // Live usage: every skill, MCP tool and agent call, and every slash command.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === 'Skill' && typeof input.skill === 'string') record($, { kind: 'skill', name: input.skill })
    else if ((tool === 'Agent' || tool === 'Task') && typeof input.subagent_type === 'string') record($, { kind: 'agent', name: input.subagent_type })
    else if (tool.startsWith('mcp__') && !tool.startsWith('mcp__scopekeeper__')) {
      const server = mcpServerOf(tool)
      if (server) record($, { kind: 'mcp', name: server })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', ($, e, next) => {
    if (e.command !== 'scope') record($, { kind: 'command', name: e.command })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__scopekeeper__inventory' }, async $ => {
    const snap = await rescan($, opts)
    const p = await paths($, opts.rc)
    const reg = await loadRegistry($, p)
    const items = snap.items.map(i => ({
      id: i.id, kind: i.kind, name: i.name, ref: i.ref, claim: i.claim, calls: i.total,
      lastUsed: i.last ? new Date(i.last).toISOString().slice(0, 10) : null,
      projects: i.uses.slice(0, 12).map(u => ({ project: u.project, calls: u.n })),
    }))
    const kits = Object.fromEntries(Object.entries(reg.kits).map(([name, c]) => [name, {
      ...c, projects: snap.kits.find(r => r.name === name)?.projects ?? [],
    }]))
    const suggested = { bundles: snap.bundles.map(b => ({ name: b.name, ids: b.ids, why: b.why })), usedEverywhere: snap.everywhere, unused: snap.unused }
    return { result: JSON.stringify({ home: p.home, items, kits, keepGlobal: reg.keepGlobal, suggested }, null, 1) }
  })

  on('tool.call', { tool: 'mcp__scopekeeper__save_kit' }, async ($, e) => {
    const input = e as unknown as { name?: string; description?: string; parts?: Part[] }
    const text = await saveKit($, opts, String(input.name ?? ''), { description: input.description, parts: input.parts ?? [] })
    void rescan($, opts)
    return { result: text }
  })

  on('tool.call', { tool: 'mcp__scopekeeper__keep_global' }, async ($, e) => {
    const input = e as unknown as { ids?: string[]; keep?: boolean }
    const text = await keepGlobal($, opts, input.ids ?? [], input.keep !== false).catch((error: unknown) => `Not saved: ${String(error)}`)
    void rescan($, opts)
    return { result: text }
  })

  // Claude asks; the person answers the same question Enter in the pane asks.
  on('tool.call', { tool: 'mcp__scopekeeper__enable_kit' }, async ($, e) => {
    const name = String((e as unknown as { name?: string }).name ?? '')
    const snap = (await read($, snapshot)) ?? (await rescan($, opts))
    const row = snap.kits.find(c => c.name === name)
    if (!row) return { result: `No kit named "${name}". Kits: ${snap.kits.map(c => c.name).join(', ') || 'none'}.` }
    if (!snap.cwdProject) return { result: 'This session is not in a project, so there is nowhere to turn a kit on.' }
    if (statusIn(row, snap.cwdProject)?.status === 'on') return { result: `${name} is already on in this project.` }
    const text = await act($, opts, `Turning on ${name}…`, () => toggleKit($, opts, row, snap.cwdProject, false, snap.home))
    if (text === 'Cancelled.') return { result: `The person chose not to turn ${name} on.` }
    return { result: text.startsWith('Enabled') ? `${text} Its tools are available from the next turn.` : text }
  })

  // Once per conversation: the kits not on here, so Claude can offer one rather than say it cannot.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const snap = (await read($, snapshot)) ?? (await Promise.race([
      firstScan,
      new Promise<null>(resolve => { $.clock.after(4000, () => resolve(null)) }),
    ]))
    const text = snap ? kitsContext(snap, TOOL('enable_kit')) : undefined
    return text ? { ...result, blocks: [...result.blocks, { name: 'scopekeeperKits', text }] } : result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'scope' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    const p = await paths($, opts.rc)
    if (verb === 'triage') {
      void $.prompt.submit({ text: TRIAGE })
      return { text: 'Asking Claude to triage your global installs…' }
    }
    if (verb === 'backfill') return { text: await act($, opts, 'Backfilling usage…', () => backfill($, p)) }
    if (verb === 'enable' || verb === 'off') {
      const project = sessionTarget ?? sessionProject
      if (!project) return { text: 'Not in a project: run /scope enable from a project folder.' }
      return { text: await act($, opts, `${verb === 'off' ? 'Removing' : 'Enabling'} ${arg}…`, () => enable($, opts, arg, project, verb === 'off')) }
    }
    if (verb === 'adopt') return { text: await act($, opts, `Adopting ${arg}…`, () => adopt($, opts, arg)) }
    if (verb === 'audit') return { text: auditText(await rescan($, opts), p.home, opts.staleDays) }
    const isAdvanced = verb === 'advanced' || verb === 'all'
    const opened = await switchMode($, isAdvanced ? 'advanced' : 'local')
    void rescan($, opts)
    const what = isAdvanced ? 'Scope (all projects)' : 'Scope'
    return { text: opened.isPlaced ? `${what} pane opened.` : `${what} pane waiting for room (${opened.reason}). /scope audit prints it as text.` }
  })

  // The local pane's cursor names what Enter does in the footer. It opens nothing: rows that opened under
  // the ring shifted the ones below it before the redraw, and the arrows skipped them.
  for (const requestId of [PANE, ADVANCED]) {
    on('ui.focus', { requestId }, async ($, e, next) => {
      const result = await next(e)
      const key = e.element ?? ''
      if (!('deny' in result && result.deny) && (await read($, pick)) !== key) await update($, pick, () => key)
      return result
    })
  }

  // The band above the prompt speaks for this project: its kits as lights, on, partly on or off.
  // Drawn here rather than with $.ui.status, which Claude Code shows as a yellow warning with our name before it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const b = snap && !e.props.hasSurvey ? band(snap, opts.staleDays) : undefined
    if (!b || !snap) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const tone = { '●': 'green', '◐': 'yellow', '○': 'yellow' } as const
    // A light with something to say joins a hover group, whose card shows in the room after the lights.
    const room = e.props.bodyColumns - b.lights.reduce((w, l, i) => w + (i ? 2 : 0) + 2 + l.name.length, 0)
      - (b.more > 0 ? `  +${b.more}`.length : 0) - 2
    // A light toggles its kit in this project, after the same question as Enter in the pane.
    // No hotkeys: a bare digit in an empty prompt would press them.
    const toggle = (name: string) => () => {
      const row = snap.kits.find(c => c.name === name)
      if (!row) return
      const isOn = statusIn(row, snap.cwdProject)?.status === 'on'
      void act($, opts, `${isOn ? 'Turning off' : 'Turning on'} ${name}…`, () => toggleKit($, opts, row, snap.cwdProject, isOn, snap.home))
    }
    return (
      <Box>
        {b.lights.flatMap((l, i) => [
          i ? <Text>{'  '}</Text> : null,
          <Button key={`light:${l.name}`} plain onPress={toggle(l.name)} hover={l.info ? { scope: `light:${l.name}` } : undefined}>
            {/* An idle kit is on but fading: dim, so it reads apart from one in use. */}
            <Text color={tone[l.glyph]} dimColor={l.isIdle || undefined}>{l.glyph}</Text>
            <Text dimColor={l.isIdle || undefined}> {l.name}</Text>
          </Button>,
        ])}
        {b.more > 0 && <Text dimColor>  +{b.more}</Text>}
        {room > 8 && b.lights.filter(l => l.info).map(l => (
          <Box key={`info:${l.name}`} display="none" hover={{ scope: `light:${l.name}`, display: 'flex' }}>
            <Text dimColor>{'  '}{clip(`${l.name}: ${l.info}`, room)}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const snap = await read($, snapshot)
    const sel = await read($, pick)
    const openKey = await read($, opened)
    const showHelp = !(await read($, helpHidden)).includes('local')
    const doing = await read($, busy)
    const lines = await read($, log)
    const W = Math.max(30, e.props.bodyColumns)
    if (!snap) return <Text dimColor>Scanning your setup…</Text>

    const home = snap.home
    const here = snap.cwdProject
    // In a worktree, use was counted under the main checkout.
    const usageHere = snap.cwdUsage ?? here
    const loading = !snap.backfilledAt
    const run = (label: string, work: () => Promise<string>) => () => act($, opts, label, work).then(() => undefined)
    const nameOf = (id: string) => snap.items.find(i => i.id === id)?.name ?? id
    const kept = snap.items.filter(i => i.claim === 'keep').length
    // Kits used here but off come first: they are the ones waiting on a decision.
    const hereKits = here ? [...snap.kits].sort((a, b) => Number(usedOffHere(b, here)) - Number(usedOffHere(a, here))) : []
    const usedOff = hereKits.filter(c => usedOffHere(c, here))

    // Rows in order: this project's kits, the bundles to make local, then what to keep global.
    const keys = [
      ...hereKits.map(c => `here:${c.name}`),
      ...snap.bundles.map(b => `sug:${b.id}`),
      ...(snap.everywhere.length ? ['sug:everywhere'] : []),
    ]
    const cur = keys.includes(sel) ? sel : (keys[0] ?? '')
    // Enter opens a suggestion, and on the open one closes it again.
    const sugKeys = keys.filter(k => k.startsWith('sug:'))
    const open = sugKeys.includes(openKey) ? openKey : ''
    const openRow = (key: string) => () => update($, opened, o => (o === key ? '' : key))
    const first = (key: string) => (key === keys[0] ? true : undefined)
    const action = (hotkey: string, id: string, label: string, onPress: () => unknown) => (
      <Button key={`act-${id}`} hotkey={hotkey} plain dimColor={doing !== ''} onPress={onPress}>{label}</Button>
    )
    const heading = (text: string) => <Text bold>{text}</Text>

    // ---- this project: each kit, ● on or ○ off, Enter to toggle; the last cell only for what needs a look
    const nameW = Math.min(16, Math.max(8, ...snap.kits.map(c => c.name.length + 1)))
    const stateW = 12
    const sumW = Math.max(0, W - 4 - nameW - stateW)
    const hereRow = (c: KitRow) => {
      const key = `here:${c.name}`
      const pr = statusIn(c, here)
      const isOn = pr?.status === 'on'
      const isUsedOff = usedOffHere(c, here)
      const mark = isOn ? '●' : pr?.status === 'partial' ? '◐' : '○'
      const state = isOn ? (isStale(pr!, snap.scannedAt, opts.staleDays) ? 'idle' : '')
        : isUsedOff ? `used ${ago(pr!.last, snap.scannedAt)} ago` : pr?.status === 'partial' ? 'partial' : ''
      return [
        <Button key={key} plain autoFocus={first(key)}
          onPress={run(`${isOn ? 'Turning off' : 'Turning on'} ${c.name}…`, () => toggleKit($, opts, c, here, isOn, home))}>
          <Text>{'  '}</Text>
          <Text color={isOn ? 'green' : isUsedOff || pr?.status === 'partial' ? 'yellow' : undefined} dimColor={!pr}>{mark} </Text>
          <Text>{fit(c.name, nameW)}</Text>
          <Text dimColor>{fit(c.summary, sumW)}</Text>
          <Text color="yellow">{clip(state, stateW)}</Text>
        </Button>,
        c.globals.length ? (
          <Box key={`detail:${key}`} flexDirection="column" paddingLeft={4}>
            <Text dimColor wrap="truncate-end">Still global too: {c.globals.map(nameOf).join(', ')}</Text>
          </Box>
        ) : null,
      ]
    }

    // ---- bundles to split out of the global scope
    const sugRow = (b: Bundle) => {
      const key = `sug:${b.id}`
      const isHere = b.projects.some(pr => pr.project === usageHere)
      const label = b.ids.length === 1 ? nameOf(b.ids[0]!) : `${b.name} (${b.ids.length})`
      return [
        <Button key={key} plain autoFocus={first(key)} onPress={openRow(key)}>
          <Text bold>{open === key ? '› ' : '  '}</Text>
          <Text color="yellow">◆ </Text>
          <Text bold={open === key}>{fit(label, Math.min(24, Math.max(10, W - 30)))}</Text>
          <Text dimColor>{clip(`${b.why}${isHere ? ' · here' : ''}`, Math.max(0, W - 4 - Math.min(24, Math.max(10, W - 30))))}</Text>
        </Button>,
        open === key ? (
          // The actions first, so a long list of projects never pushes them out of view; then one project a line.
          <Box key={`detail:${key}`} flexDirection="column" paddingLeft={4}>
            <Box flexDirection="row" columnGap={2} flexWrap="wrap">
              {action('l', 'local', b.direct ? 'Make local' : 'Make local with Claude',
                run(`Making ${b.name} local…`, () => makeLocal($, opts, b, snap.items)))}
              {action('k', 'keep', 'Keep global', run('Saving…', () => keepGlobal($, opts, b.ids, true)))}
            </Box>
            {b.ids.length > 1 && <Text>{b.ids.map(nameOf).join(', ')}</Text>}
            <Text dimColor>Used in:</Text>
            {b.projects.slice(0, 5).map(pr => (
              <Text bold={pr.project === usageHere}>
                {'  '}{fit(shortPath(pr.project, home), W - 18)}<Text dimColor>{fit(count(pr.n), 6)}{ago(pr.last, snap.scannedAt)}</Text>
              </Text>
            ))}
            {b.projects.length > 5 && <Text dimColor>  +{plural(b.projects.length - 5, 'more project')}</Text>}
          </Box>
        ) : null,
      ]
    }

    const everywhereRow = () => {
      const key = 'sug:everywhere'
      return [
        <Button key={key} plain autoFocus={first(key)} onPress={openRow(key)}>
          <Text bold>{open === key ? '› ' : '  '}</Text>
          <Text color="green">◇ </Text>
          <Text bold={open === key}>{clip(`${plural(snap.everywhere.length, 'global')} you use in most projects`, W - 4)}</Text>
        </Button>,
        open === key ? (
          <Box key={`detail:${key}`} flexDirection="column" paddingLeft={4}>
            <Box flexDirection="row" gap={2}>
              {action('k', 'keep', 'Keep global', run('Saving…', () => keepGlobal($, opts, snap.everywhere, true)))}
            </Box>
            <Text>{snap.everywhere.map(nameOf).join(', ')}</Text>
          </Box>
        ) : null,
      ]
    }

    const nothingToSplit = !snap.bundles.length && !snap.everywhere.length && !snap.unused.length
    const unsorted = snap.items.filter(i => i.claim === 'new').length
    const projectOnly = snap.bundles.reduce((n, b) => n + b.ids.length, 0)
    // Every count about the global scope, on one line.
    const globals = [
      kept ? `${kept} always on` : '',
      projectOnly ? `${projectOnly} to make local` : '',
      snap.unused.length ? `${snap.unused.length} never used` : '',
    ].filter(Boolean)
    // The keys row names what Enter does on the row under the cursor.
    const curKit = hereKits.find(c => `here:${c.name}` === cur)
    const enterHint = curKit ? `Turn ${statusIn(curKit, here)?.status === 'on' ? 'off' : 'on'}`
      : cur.startsWith('sug:') ? (cur === open ? 'Close' : 'Open') : ''
    const name = here.split('/').pop() ?? ''
    const lastLine = lines.filter(worthLogging).at(-1) ?? ''
    return (
      <Box flexDirection="column">
        {here ? (
          <Text wrap="truncate-end">
            <Text dimColor>{shortPath(here, home).slice(0, -name.length)}</Text>
            <Text bold>{name}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <Text bold>Not in a project</Text>
            <Text dimColor>  open /scope from a project to toggle kits</Text>
          </Text>
        )}
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          <Button key="advanced" hotkey="a" plain onPress={() => void switchMode($, 'advanced')}>Advanced</Button>
          <Button key="rescan" hotkey="r" plain dimColor={doing !== ''}
            onPress={() => act($, opts, 'Rescanning…', async () => '', true).then(() => undefined)}>Rescan</Button>
          {unsorted > 0 && <Button key="triage" hotkey="t" plain onPress={() => void $.prompt.submit({ text: TRIAGE })}>Let Claude triage</Button>}
          {!showHelp && <Button key="help" hotkey="h" plain onPress={() => void toggleHelp($, 'local')}>Help</Button>}
          {enterHint !== '' && <Text>Enter: {enterHint}</Text>}
        </Box>
        {showHelp && helpBox(ui, 'local', W, () => void toggleHelp($, 'local'))}
        {doing !== '' && <Text color="yellow">⟳ {doing}</Text>}
        {snap.historyProblem !== '' && <Text color="red" wrap="truncate-end">! {snap.historyProblem}</Text>}
        {/* A broken kits.json, or a kit left out of cc.sh, stops toggling: say so here too. */}
        {snap.problems.filter(pr => pr.includes('kits.json') || pr.startsWith('kit ')).map(pr => <Text color="red" wrap="truncate-end">! {pr}</Text>)}
        <Text dimColor>{'─'.repeat(W)}</Text>

        {here !== '' && (
          <Box flexDirection="column">
            {heading('In this project')}
            {snap.kits.length === 0 && (
              <Text dimColor>{snap.bundles.length ? 'No kits yet: make one local below.'
                : unsorted ? 'No kits yet: t lets Claude build them from your globals.' : 'No kits yet.'}</Text>
            )}
            {hereKits.flatMap(hereRow)}
            {usedOff.length > 0 && (
              <Button key="turn-on-used" hotkey="y" plain dimColor={doing !== ''}
                onPress={run('Turning on…', () => turnOnUsed($, opts, usedOff, here, home))}>
                {clip(`Turn on what you used here: ${usedOff.map(c => c.name).join(', ')}`, W - 3)}
              </Button>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginTop={here !== '' ? 1 : 0}>
          {heading('Global, but used in few projects')}
          {snap.bundles.length > 0 && <Text dimColor wrap="truncate-end">Make these project-only to cut context elsewhere.</Text>}
          {loading && <Text dimColor>Reading your history to spot habits…</Text>}
          {!loading && nothingToSplit && <Text color="green">✓ Nothing to split out of your global setup.</Text>}
          {!loading && !snap.bundles.length && snap.unused.length > 0 && (
            <Text dimColor wrap="truncate-end">{plural(snap.unused.length, 'global')} never used: t lets Claude sort them.</Text>
          )}
          {snap.bundles.flatMap(sugRow)}
          {snap.everywhere.length > 0 && everywhereRow()}
        </Box>
        {globals.length > 0 && <Text dimColor wrap="truncate-end">Globals: {globals.join(' · ')}</Text>}
        {lastLine !== '' && (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">Last: {lastLine}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ADVANCED }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const snap = await read($, snapshot)
    const v = await read($, view)
    const cursor = await read($, pick)
    const showHelp = !(await read($, helpHidden)).includes(v.tab)
    const doing = await read($, busy)
    const lines = await read($, log)
    const W = Math.max(30, e.props.bodyColumns)
    const home = snap?.home ?? ''
    const now = snap?.scannedAt ?? 0
    const run = (label: string, work: () => Promise<string>, quiet = false) => () =>
      act($, opts, label, work, quiet).then(() => undefined)

    if (!snap) return <Text dimColor>Scanning your setup…</Text>

    const loading = !snap.backfilledAt
    const since = snap.historySince ? ` since ${day(snap.historySince, now)}` : ''
    const wide = W >= 56
    const stale = (pr: KitProject) => isStale(pr, now, opts.staleDays)
    const pendingOf = (c: KitRow) => c.projects.filter(pr => pr.status !== 'on' && pr.n > 0).length

    // Hotkeys show on the terminal only on plain Buttons (`k: Keep`), so every action is plain.
    const action = (hotkey: string, id: string, label: string, onPress: () => unknown) => (
      <Button key={`act-${id}`} hotkey={hotkey} plain dimColor={doing !== ''} onPress={onPress}>{label}</Button>
    )
    const tab = (id: View['tab'], hotkey: string, label: string) => (
      <Button key={`tab-${id}`} hotkey={hotkey} plain onPress={() => setView($, { tab: id, selected: '' })}>
        <Text bold={v.tab === id} underline={v.tab === id} dimColor={v.tab !== id}>{label}</Text>
      </Button>
    )

    // ---- what is selected, and what can be done to it
    const rank = (i: ItemRow) => (i.claim === 'new' ? 0 : i.claim === 'keep' ? 2 : 1)
    const sorted = [...snap.items].sort((a, b) => rank(a) - rank(b) || b.total - a.total)
    const open = sorted.filter(i => i.claim !== 'keep')
    const kept = sorted.filter(i => i.claim === 'keep')
    const shown = v.showKept ? sorted : open
    // Nothing is open until Enter opens a row; Enter on the open row closes it.
    const selItem = v.tab === 'globals' ? shown.find(i => i.id === v.selected) : undefined
    const selKit = v.tab === 'kits' ? snap.kits.find(c => c.name === v.selected) : undefined
    const toggle = (id: string) => () => update($, view, cur => ({ ...cur, selected: cur.selected === id ? '' : id }))

    // The open row's actions sit at the end of its details, so a hotkey acts on what is shown open.
    const actions = (buttons: (ReturnType<typeof action> | false)[]) => (
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">{buttons.filter(b => b !== false)}</Box>
    )
    const itemActions = (i: ItemRow) => {
      const kit = kitOf(i.claim)
      return actions([
        i.claim.startsWith('kit:')
          ? action('o', 'adopt', `Adopt ${kit}`, run(`Adopting ${kit}…`, () => adopt($, opts, kit)))
          : action('m', 'make', 'Make a kit', () => void $.prompt.submit({ text: `${TRIAGE}\n\nStart with ${i.id} only.` })),
        i.claim === 'new' && action('k', 'keep', 'Keep global', run('Saving…', () => keepGlobal($, opts, [i.id], true))),
        i.claim === 'keep' && action('u', 'unkeep', 'Unkeep', run('Saving…', () => keepGlobal($, opts, [i.id], false))),
        !loading && action('x', 'remove', 'Remove', run(`Removing ${i.name}…`, () => removeOne($, opts, i.id))),
      ])
    }
    const kitActions = (c: KitRow) => {
      const staleN = c.projects.filter(stale).length
      return actions([
        (c.globals.length > 0 || pendingOf(c) > 0) && action('o', 'adopt', 'Adopt', run(`Adopting ${c.name}…`, () => adopt($, opts, c.name))),
        snap.cwdProject !== '' && c.projects.find(pr => pr.project === snap.cwdProject)?.status !== 'on'
          && action('e', 'enable', 'Enable here', run(`Enabling ${c.name}…`, () => toggleKit($, opts, c, snap.cwdProject, false, home))),
        staleN > 0 && action('p', 'prune', `Prune ${staleN} stale`, run(`Pruning ${c.name}…`, () => prune($, opts, c.name))),
      ])
    }

    // What Enter does on the row under the cursor, named last in the keys row as in the local pane.
    const enterHint = (() => {
      if (cursor === 'kept') return v.showKept ? 'Hide kept' : 'Show kept'
      if (cursor.startsWith('item:')) return cursor.slice('item:'.length) === selItem?.id ? 'Close' : 'Open'
      if (cursor.startsWith('kit:')) return cursor.slice('kit:'.length) === selKit?.name ? 'Close' : 'Open'
      if (!cursor.startsWith('proj:') || !selKit) return ''
      const pr = selKit.projects.find(p => cursor === `proj:${selKit.name}:${p.project}`)
      return pr ? `Turn ${pr.status === 'on' ? 'off' : 'on'} there` : ''
    })()

    // ---- header: totals, what waits on the person, the keys
    const t = todo(snap, opts.staleDays)
    const waiting = [
      t.unsorted ? `${t.unsorted} unsorted` : '',
      t.toAdopt ? `${t.toAdopt} to adopt` : '',
      t.usedOff ? `${t.usedOff} used but off` : '',
      t.stale ? `${t.stale} stale` : '',
    ].filter(Boolean).join(' · ')
    const header = (
      <Box flexDirection="column">
        <Text dimColor>{plural(snap.items.length, 'global')} · {plural(snap.kits.length, 'kit')}{snap.historySince ? ` · usage${since}` : ''}</Text>
        {waiting ? <Text color="yellow">▸ {waiting}</Text> : <Text color="green">✓ Nothing waiting on you</Text>}
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {tab('globals', 'g', 'Globals')}
          {tab('kits', 'i', 'Kits')}
          <Button key="local" hotkey="a" plain onPress={() => void switchMode($, 'local')}>Back to local</Button>
          <Button key="rescan" hotkey="r" plain dimColor={doing !== ''} onPress={run('Rescanning…', async () => '', true)}>Rescan</Button>
          {!snap.rcLoaded && snap.kits.length > 0 && (
            <Button key="shell" hotkey="s" plain dimColor={doing !== ''} onPress={run('Setting up your shell…', async () =>
              (await ensureRc($, await paths($, opts.rc))) ? 'cc-* functions load in new shells from now on.' : 'Left your shell files as they are.')}>
              Set up shell
            </Button>
          )}
          {t.unsorted > 0 && (
            <Button key="triage" hotkey="t" plain onPress={() => void $.prompt.submit({ text: TRIAGE })}>Let Claude triage</Button>
          )}
          {!showHelp && <Button key="help" hotkey="h" plain onPress={() => void toggleHelp($, v.tab)}>Help</Button>}
          {enterHint !== '' && <Text>Enter: {enterHint}</Text>}
        </Box>
        {showHelp && helpBox(ui, v.tab, W, () => void toggleHelp($, v.tab))}
        {doing !== '' && <Text color="yellow">⟳ {doing}</Text>}
        {snap.problems.map(pr => <Text color="red">! {pr}</Text>)}
        {loading && <Text dimColor>Reading your transcripts for usage history…</Text>}
      </Box>
    )

    const rule = <Text dimColor>{'─'.repeat(W)}</Text>
    const recent = lines.filter(worthLogging).slice(-3)
    const logLines = recent.length > 0 && (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>Recent</Text>
        {recent.map((l, n) => <Text dimColor wrap={n === recent.length - 1 ? 'wrap' : 'truncate-end'}>  {l}</Text>)}
      </Box>
    )

    if (v.tab === 'globals') {
      // Columns sum to W exactly: marker 2, kind 7 (wide only), name, calls 6, last 6, proj 5 (wide only), status.
      const nameW = wide ? Math.min(36, Math.max(8, W - 38)) : Math.max(8, W - 24)
      const statusW = W - 2 - nameW - 12 - (wide ? 12 : 0)
      const num = (s: string, w: number) => fit(loading ? '…' : s, w)

      const detail = (i: ItemRow) => {
        const kit = kitOf(i.claim)
        const why = i.claim === 'new'
          ? 'Unsorted: keep it global if you use it everywhere, or make a kit so it loads only where you need it.'
          : i.claim === 'keep' ? 'Kept global on purpose.'
          : `Covered by kit ${kit}, but still installed globally. Adopt enables ${kit} where it was used, then removes this global.`
        return (
          // The actions first, with what they would do, so a long usage list never pushes them out of view.
          <Box key={`detail:${i.id}`} flexDirection="column" paddingLeft={4} marginBottom={1}>
            {itemActions(i)}
            <Text color={i.claim.startsWith('kit:') ? 'yellow' : undefined} dimColor={!i.claim.startsWith('kit:')}>{why}</Text>
            {!(i.kind === 'mcp' && i.ref === i.name) && <Text dimColor wrap="truncate-middle">{shortPath(i.ref, home)}</Text>}
            {loading && <Text dimColor>Usage: still reading your transcripts…</Text>}
            {!loading && i.uses.length === 0 && <Text dimColor>No recorded use{since}.</Text>}
            {!loading && i.uses.slice(0, 5).map(u => (
              <Text>{fit(shortPath(u.project, home), W - 17)} <Text dimColor>{fit(count(u.n), 6)}{ago(u.last, now)}</Text></Text>
            ))}
            {!loading && i.uses.length > 5 && <Text dimColor>+{plural(i.uses.length - 5, 'more project')}</Text>}
          </Box>
        )
      }
      const row = (i: ItemRow, first: boolean) => {
        const isSel = i.id === selItem?.id
        return [
          <Button key={`item:${i.id}`} plain autoFocus={first ? true : undefined} onPress={toggle(i.id)}>
            <Text bold>{isSel ? '› ' : '  '}</Text>
            <Text dimColor>{wide ? fit(i.kind, 7) : ''}</Text>
            <Text bold={isSel}>{fit(i.name, nameW - 1)} </Text>
            <Text dimColor>{num(count(i.total), 6)}{num(ago(i.last, now), 6)}{wide ? num(`${i.uses.length}p`, 5) : ''}</Text>
            <Text color={i.claim === 'keep' ? undefined : 'yellow'} dimColor={i.claim === 'keep'}>{clip(claimText(i.claim), statusW)}</Text>
          </Button>,
          isSel ? detail(i) : null,
        ]
      }
      return (
        <Box flexDirection="column">
          {header}
          {rule}
          {sorted.length === 0 && <Text dimColor>Nothing is installed globally.</Text>}
          {sorted.length > 0 && (
            <Text dimColor>
              {'  '}{wide ? fit('kind', 7) : ''}{fit('name', nameW)}{fit('calls', 6)}{fit('last', 6)}{wide ? fit('proj', 5) : ''}{clip('status', statusW)}
            </Text>
          )}
          {open.flatMap((i, n) => row(i, n === 0))}
          {kept.length > 0 && (
            <Button key="kept" plain onPress={() => setView($, { showKept: !v.showKept })}>
              <Text dimColor>{v.showKept ? '▾' : '▸'} Kept global ({kept.length})</Text>
            </Button>
          )}
          {v.showKept && kept.flatMap((i, n) => row(i, open.length === 0 && n === 0))}
          {logLines}
        </Box>
      )
    }

    // Columns sum to W exactly: marker 2, name, summary (wide only), on in 6, to do 10.
    const cNameW = Math.min(16, Math.max(8, ...snap.kits.map(c => c.name.length + 1)))
    const sumW = wide ? W - 18 - cNameW : 0
    const cNameCol = wide ? cNameW : W - 18

    const kitDetail = (c: KitRow) => {
      const pending = pendingOf(c)
      return (
        // The actions first, with what Adopt would do; then the parts, and the projects with how to toggle them.
        <Box key={`detail:${c.name}`} flexDirection="column" paddingLeft={4} marginBottom={1}>
          {kitActions(c)}
          {c.globals.length > 0 && (
            <Text color="yellow">Still installed globally: {c.globals.join(', ')}. Adopt enables {c.name} where it was used, then removes the global{c.globals.length > 1 ? 's' : ''}.</Text>
          )}
          {c.globals.length === 0 && pending > 0 && (
            <Text color="yellow">Used but off in {plural(pending, 'project')}: Adopt enables it there.</Text>
          )}
          {sumW === 0 && <Text>{c.summary}</Text>}
          {c.parts.map(line => line.startsWith('runs: ')
            ? <Text>· {line}</Text>
            : <Text dimColor wrap="truncate-end">· {line}</Text>)}
          <Text dimColor>From a shell: cc-{c.name} · cc-{c.name}-off</Text>
          {c.projects.length === 0 && <Text dimColor>Not enabled or used anywhere yet.</Text>}
          {c.projects.length > 0 && <Text dimColor>Enter on a project turns {c.name} on or off there.</Text>}
          {c.projects.map(pr => {
            const mark = pr.status === 'on' ? '✓' : pr.status === 'partial' ? '◐' : '+'
            const tag = pr.status === 'on' ? (stale(pr) ? 'stale' : '') : pr.status === 'partial' ? 'partial' : 'used, off'
            const toOff = pr.status === 'on'
            return (
              <Button key={`proj:${c.name}:${pr.project}`} plain
                onPress={run(`${toOff ? 'Removing' : 'Enabling'} ${c.name}…`, () => toggleKit($, opts, c, pr.project, toOff, home))}>
                <Text color={pr.status === 'on' ? 'green' : 'yellow'}>{mark} </Text>
                {fit(shortPath(pr.project, home), W - 29)}{' '}
                <Text dimColor>{fit(count(pr.n), 6)}{fit(ago(pr.last, now), 6)}</Text>
                <Text color="yellow">{tag}</Text>
              </Button>
            )
          })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {rule}
        {snap.kits.length === 0 && <Text dimColor>No kits yet. Press m on an unsorted global, or t to triage them all with Claude.</Text>}
        {snap.kits.length > 0 && (
          <Text dimColor>{'  '}{fit('kit', cNameCol)}{sumW ? fit('what', sumW) : ''}{fit('on in', 6)}to do</Text>
        )}
        {snap.kits.flatMap((c, n) => {
          const isSel = c.name === selKit?.name
          const pending = pendingOf(c)
          const staleN = c.projects.filter(stale).length
          const onN = c.projects.filter(pr => pr.status === 'on').length
          // Verbs that match the open row's actions: o Adopt, Enter on a project, p Prune.
          const todo = c.globals.length ? 'adopt' : pending ? `turn on ${pending}` : staleN ? `prune ${staleN}` : ''
          return [
            <Button key={`kit:${c.name}`} plain autoFocus={n === 0 ? true : undefined} onPress={toggle(c.name)}>
              <Text bold>{isSel ? '› ' : '  '}</Text>
              <Text bold>{fit(c.name, cNameCol - 1)} </Text>
              <Text dimColor>{sumW ? `${fit(c.summary, sumW - 1)} ` : ''}</Text>
              <Text dimColor={onN === 0}>{fit(onN ? String(onN) : '—', 6)}</Text>
              <Text color="yellow">{clip(todo, 10)}</Text>
            </Button>,
            isSel ? kitDetail(c) : null,
          ]
        })}
        {logLines}
      </Box>
    )
  })
}

function auditText(snap: Snapshot, home: string, staleDays: number): string {
  const now = snap.scannedAt
  const t = todo(snap, staleDays)
  const waiting = [t.unsorted && `${t.unsorted} unsorted`, t.toAdopt && `${t.toAdopt} to adopt`,
    t.usedOff && `${t.usedOff} used but off`, t.stale && `${t.stale} stale`].filter(Boolean).join(' · ')
  const since = !snap.backfilledAt ? ', usage history still loading'
    : snap.historySince ? `, usage since ${day(snap.historySince, now)}` : ''
  const nameOf = (id: string) => snap.items.find(i => i.id === id)?.name ?? id
  const out = [`Waiting on you: ${waiting || 'nothing'}`]
  if (snap.bundles.length) {
    out.push('', 'Make local (suggested):')
    for (const b of snap.bundles) out.push(`  ${b.name}: ${b.ids.map(nameOf).join(', ')} (${b.why})`)
  }
  if (snap.everywhere.length) out.push('', `Used in most projects, keep global: ${snap.everywhere.map(nameOf).join(', ')}`)
  out.push('', `Global installs (calls · last used · projects · claim${since}):`)
  for (const i of [...snap.items].sort((a, b) => b.total - a.total)) {
    out.push(`  ${fit(i.kind, 7)}${fit(i.name, 28)} ${fit(count(i.total), 6)}${fit(ago(i.last, now), 6)}${fit(String(i.uses.length), 4)}${claimText(i.claim)}`)
  }
  out.push('', 'Kits:')
  if (!snap.kits.length) out.push('  none yet: /scope triage')
  for (const c of snap.kits) {
    const on = c.projects.filter(pr => pr.status === 'on').map(pr => shortPath(pr.project, home))
    const pending = c.projects.filter(pr => pr.status !== 'on' && pr.n > 0).map(pr => shortPath(pr.project, home))
    const stale = c.projects.filter(pr => isStale(pr, now, staleDays)).map(pr => shortPath(pr.project, home))
    out.push(`  cc-${c.name}: on in ${on.length ? on.join(', ') : 'none'}${pending.length ? `; used but off: ${pending.join(', ')}` : ''}${stale.length ? `; stale: ${stale.join(', ')}` : ''}${c.globals.length ? `; still global: ${c.globals.join(', ')}` : ''}`)
  }
  return out.join('\n')
}

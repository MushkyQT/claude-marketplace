// Pure logic: no `$`, so the tests can import it directly.

import type { Bundle, ItemRow, KitProject, ProjectUse, Snapshot } from '../types'

export type Part =
  | { kind: 'plugin'; id: string }
  | { kind: 'mcp'; name: string; config: Record<string, unknown> }
  | { kind: 'git-skills'; repo: string; dir?: string; match: string; lib?: string }
  | { kind: 'installer'; run: string; paths: string[]; usage?: string[] }

export type Kit = { description?: string; parts: Part[] }

export type Registry = {
  version: 1
  keepGlobal: string[]
  kits: Record<string, Kit>
}

/** usage key -> project -> { n, last } */
export type Ledger = Record<string, Record<string, { n: number; last: number }>>

export type UsageEvent = { kind: 'skill' | 'mcp' | 'agent' | 'command'; name: string }

export const EMPTY_REGISTRY: Registry = { version: 1, keepGlobal: [], kits: {} }

// Agent types that ship with Claude Code: never anyone's install.
const BUILTIN_AGENTS = new Set([
  'general-purpose', 'Explore', 'Plan', 'fork', 'claude', 'statusline-setup',
  'claude-code-guide',
])

export const KIT_NAME = /^[a-z][a-z0-9-]{0,30}$/

export function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`)
}

export const matchesAny = (key: string, globs: readonly string[]) =>
  globs.some(g => globToRegExp(g).test(key))

/**
 * Maps one observed use to the install it came from. `plugins` are the plugin
 * names known on this machine, so `mcp__plugin_<plugin>_<server>__x` resolves
 * even when a plugin name holds an underscore.
 */
export function classify(
  use: UsageEvent,
  plugins: readonly string[],
  isKnown: (key: string) => boolean,
): string | undefined {
  const { kind, name } = use
  if (kind === 'mcp') {
    if (name.startsWith('plugin_')) {
      const rest = name.slice('plugin_'.length)
      const owner = plugins.find(p => rest.startsWith(`${p}_`))
      return `plugin:${owner ?? rest.split('_')[0]}`
    }
    if (name.startsWith('claude_ai_')) return `connector:${name.slice('claude_ai_'.length)}`
    return `mcp:${name}`
  }
  const colon = name.indexOf(':')
  if (colon > 0) return `plugin:${name.slice(0, colon)}`
  if (kind === 'skill') return `skill:${name}`
  if (kind === 'agent') return BUILTIN_AGENTS.has(name) ? undefined : `agent:${name}`
  // A bare slash command is only worth keeping when it names a known skill.
  return isKnown(`skill:${name}`) ? `skill:${name}` : undefined
}

/** `mcp__<server>__<tool>` -> server */
export function mcpServerOf(tool: string): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const end = tool.indexOf('__', 5)
  return end > 5 ? tool.slice(5, end) : undefined
}

export const pluginName = (id: string) => id.split('@')[0] ?? id

/** The usage keys (globs) a part answers for. */
export function partUsage(part: Part): string[] {
  switch (part.kind) {
    case 'plugin':
      return [`plugin:${pluginName(part.id)}`]
    case 'mcp':
      return [`mcp:${part.name}`]
    case 'git-skills':
      return [`skill:${part.match}`]
    case 'installer':
      return part.usage ?? part.paths.flatMap(pathUsage)
  }
}

function pathUsage(path: string): string[] {
  const clean = path.replace(/\/+$/, '')
  const skill = /^\.claude\/skills\/([^/]+)$/.exec(clean)
  if (skill) return [`skill:${skill[1]}`]
  const agent = /^\.claude\/agents\/([^/]+?)(\.md)?$/.exec(clean)
  if (agent) return [`agent:${agent[1]}`]
  return []
}

export const kitUsage = (kit: Kit) => kit.parts.flatMap(partUsage)

/** Which kit (if any) covers a global item, else `keep` or `new`. */
export function claimOf(id: string, registry: Registry): string {
  for (const [name, kit] of Object.entries(registry.kits)) {
    if (matchesAny(id, kitUsage(kit))) return `kit:${name}`
  }
  return registry.keepGlobal.includes(id) ? 'keep' : 'new'
}

export function partSummary(part: Part): string {
  switch (part.kind) {
    case 'plugin':
      return pluginName(part.id)
    case 'mcp':
      return `${part.name} (mcp)`
    case 'git-skills':
      return `${part.match} (skills)`
    case 'installer':
      return part.paths.map(p => p.replace(/^\.claude\//, '').replace(/\/+$/, '')).join(', ')
  }
}

/** What one part installs or runs, for the person to read before enabling it. */
export function partLine(part: Part): string {
  switch (part.kind) {
    case 'plugin':
      return `plugin ${part.id}`
    case 'mcp': {
      const c = part.config as { command?: unknown; args?: unknown; url?: unknown }
      const how = typeof c.url === 'string' ? c.url
        : [c.command, ...(Array.isArray(c.args) ? c.args : [])].filter(x => typeof x === 'string').join(' ')
      return `mcp ${part.name}${how ? `: ${how}` : ''}`
    }
    case 'git-skills':
      return `skills ${part.match} from ${part.repo}`
    case 'installer':
      return `runs: ${part.run}`
  }
}

/** A glob that names everything in its folder: `*`, `?*`, `**`. cc-<kit>-off would empty the folder. */
const isCatchAll = (glob: string) => /^[*?]*$/.test(glob)

export function validateKit(name: string, kit: Kit): string[] {
  const errors: string[] = []
  if (!KIT_NAME.test(name)) errors.push(`name "${name}": use a-z, 0-9 and -, starting with a letter`)
  if (!Array.isArray(kit.parts) || kit.parts.length === 0) errors.push('a kit needs at least one part')
  for (const part of kit.parts ?? []) {
    if (part.kind === 'plugin' && !/^[^@\s]+@[^@\s]+$/.test(part.id)) errors.push(`plugin id "${part.id}" must be name@marketplace`)
    if (part.kind === 'mcp' && (!part.name || typeof part.config !== 'object')) errors.push('an mcp part needs name and config')
    if (part.kind === 'git-skills') {
      if (!part.repo || !part.match) errors.push('a git-skills part needs repo and match')
      else if (!/^[A-Za-z0-9_*?-][A-Za-z0-9._*?-]*$/.test(part.match) || isCatchAll(part.match)) {
        errors.push(`skills match "${part.match}" must name skill folders, like "remotion-*", not every folder`)
      }
      if (part.dir !== undefined && (part.dir.startsWith('/') || part.dir.split('/').includes('..'))) errors.push(`skills dir "${part.dir}" must be inside the repo`)
      if (part.lib !== undefined && (!/^[A-Za-z0-9._-]+$/.test(part.lib) || /^\.+$/.test(part.lib))) errors.push(`lib "${part.lib}" must be a plain folder name`)
    }
    if (part.kind === 'installer') {
      if (!part.run) errors.push('an installer part needs run')
      if (!part.paths?.length) errors.push('an installer part needs the paths it writes')
      for (const p of part.paths ?? []) {
        const clean = p.replace(/\/+$/, '')
        const segs = clean.split('/')
        if (p.startsWith('/') || segs.includes('..')) errors.push(`installer path "${p}" must be relative to the project`)
        else if (segs[0] !== '.claude' || segs.length < 3 || segs.some(s => s === '' || s === '.') || isCatchAll(segs.at(-1)!)) {
          errors.push(`installer path "${p}" must name what it writes under .claude/, like ".claude/skills/impeccable"`)
        }
      }
    }
  }
  return errors
}

/** Kits that fail validateKit, with why: left out of cc.sh. */
export function invalidKits(registry: Registry): { name: string; errors: string[] }[] {
  return Object.entries(registry.kits)
    .map(([name, kit]) => ({ name, errors: validateKit(name, kit) }))
    .filter(k => k.errors.length)
}

// ---------- shell generation (bash and zsh both source the file) ----------

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function libName(part: Extract<Part, { kind: 'git-skills' }>): string {
  if (part.lib) return part.lib
  const m = /([^/:]+)\/([^/]+?)(\.git)?\/?$/.exec(part.repo)
  return (m ? `${m[1]}-${m[2]}` : 'skills').replace(/[^A-Za-z0-9._-]/g, '-')
}

/** `find`-based removal of one project-relative path, which may end in a glob; a missing folder is nothing to remove. */
function removePath(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const cut = clean.lastIndexOf('/')
  const dir = cut < 0 ? '.' : clean.slice(0, cut)
  const base = clean.slice(cut + 1)
  return `{ [ ! -d ${q(dir)} ] || find ${q(dir)} -mindepth 1 -maxdepth 1 -name ${q(base)} -exec rm -rf {} +; }`
}

/** Where a git-skills part's skills live in its clone. */
export const skillsSource = (part: Extract<Part, { kind: 'git-skills' }>, libRoot: string) =>
  `${libRoot}/${libName(part)}/${part.dir ?? 'skills'}`

function onLines(part: Part, libRoot: string): string[] {
  switch (part.kind) {
    case 'plugin':
      return [`claude plugin install ${q(part.id)} --scope local || return 1`]
    case 'mcp':
      return [
        `claude mcp remove ${q(part.name)} -s local >/dev/null 2>&1`,
        `claude mcp add-json ${q(part.name)} ${q(JSON.stringify(part.config))} -s local || return 1`,
      ]
    case 'git-skills': {
      const lib = `${libRoot}/${libName(part)}`
      return [
        `[ -d ${q(lib)} ] || git clone --depth 1 -q ${q(part.repo)} ${q(lib)} || return 1`,
        `git -C ${q(lib)} pull -q --ff-only 2>/dev/null`,
        `_sk_skills_on ${q(skillsSource(part, libRoot))} ${q(part.match)} || return 1`,
      ]
    }
    case 'installer':
      return [`${part.run} || return 1`, `_sk_exclude ${part.paths.map(q).join(' ')}`]
  }
}

/** Each line sets _sk_rc=1 when its part could not be removed; one that was not there counts as removed. */
function offLines(part: Part, libRoot: string): string[] {
  switch (part.kind) {
    case 'plugin':
      return [`_sk_try claude plugin uninstall ${q(part.id)} -s local || _sk_rc=1`]
    case 'mcp':
      return [`_sk_try claude mcp remove ${q(part.name)} -s local || _sk_rc=1`]
    case 'git-skills':
      return [`_sk_skills_off ${q(skillsSource(part, libRoot))} ${q(part.match)} || _sk_rc=1`]
    case 'installer':
      return part.paths.map(p => `${removePath(p)} || _sk_rc=1`)
  }
}

export const SCRIPT_HEADER = '# Generated by the scopekeeper mod from kits.json. Edits here are overwritten.'

export function generateScript(registry: Registry, libRoot: string): string {
  const out: string[] = [
    SCRIPT_HEADER,
    '# Each cc-<kit> enables a kit in the current project (local scope, never committed);',
    '# cc-<kit>-off removes it. Run /scope in Claude Code to manage them.',
    '',
    '_sk_guard() {',
    '  _sk_here=$(pwd -P)',
    '  case "$_sk_here" in',
    '    /|"$HOME"|"$(cd "$HOME" && pwd -P)")',
    '      echo "scopekeeper: not in $_sk_here: a project install there would be global" >&2; return 1 ;;',
    '  esac',
    '}',
    '_sk_exclude() {',
    '  git rev-parse --git-dir >/dev/null 2>&1 || return 0',
    '  _sk_ex=$(git rev-parse --git-path info/exclude)',
    '  mkdir -p "$(dirname "$_sk_ex")"',
    '  for _sk_p in "$@"; do',
    '    grep -qxF "$_sk_p" "$_sk_ex" 2>/dev/null || printf \'%s\\n\' "$_sk_p" >> "$_sk_ex"',
    '  done',
    '}',
    '# Runs a removal; one that finds nothing to remove succeeds.',
    '_sk_try() {',
    '  _sk_out=$("$@" 2>&1) && return 0',
    '  case "$_sk_out" in',
    '    *"not installed"*|*"Not installed"*|*"not found"*|*"No MCP server"*|*"does not exist"*) return 0 ;;',
    '  esac',
    '  printf \'%s\\n\' "$_sk_out" >&2',
    '  return 1',
    '}',
    '# The skill folders in clone $1 named like $2: only those are copied in, and only those removed.',
    '_sk_skills_in() {',
    '  find "$1" -mindepth 1 -maxdepth 1 -name "$2" ! -name \'.*\' -exec basename {} \\; 2>/dev/null',
    '}',
    '_sk_skills_on() {',
    '  _sk_names=$(_sk_skills_in "$1" "$2")',
    '  [ -n "$_sk_names" ] || { echo "scopekeeper: no skill named $2 in $1" >&2; return 1; }',
    '  mkdir -p .claude/skills',
    '  while IFS= read -r _sk_b; do',
    '    [ -n "$_sk_b" ] || continue',
    '    rm -rf ".claude/skills/$_sk_b"',
    '    cp -R "$1/$_sk_b" .claude/skills/ || return 1',
    '    _sk_exclude ".claude/skills/$_sk_b"',
    '  done <<EOF',
    '$_sk_names',
    'EOF',
    '}',
    '_sk_skills_off() {',
    '  [ -d "$1" ] || { echo "scopekeeper: $1 is gone, so its skills cannot be told from yours; .claude/skills left as it is" >&2; return 1; }',
    '  _sk_names=$(_sk_skills_in "$1" "$2")',
    '  while IFS= read -r _sk_b; do',
    '    [ -n "$_sk_b" ] || continue',
    '    rm -rf ".claude/skills/$_sk_b" || return 1',
    '  done <<EOF',
    '$_sk_names',
    'EOF',
    '}',
  ]
  const bad = new Set(invalidKits(registry).map(k => k.name))
  for (const [name, kit] of Object.entries(registry.kits).sort(([a], [b]) => a.localeCompare(b))) {
    if (bad.has(name)) {
      out.push('', `# ${name}: left out, it does not pass validation (see /scope)`)
      continue
    }
    const what = kit.description ?? kit.parts.map(partSummary).join(' + ')
    out.push('', `# ${what.replace(/\n/g, ' ')}`)
    out.push(`cc-${name}() {`, '  _sk_guard || return 1')
    for (const line of kit.parts.flatMap(p => onLines(p, libRoot))) out.push(`  ${line}`)
    out.push(`  echo "cc-${name}: enabled in $(pwd -P). Run /reload-plugins in open sessions."`, '}')
    out.push(`cc-${name}-off() {`, '  _sk_guard || return 1', '  _sk_rc=0')
    for (const line of kit.parts.flatMap(p => offLines(p, libRoot))) out.push(`  ${line}`)
    out.push(
      `  [ "$_sk_rc" = 0 ] || { echo "cc-${name}-off: some parts were not removed from $(pwd -P)" >&2; return 1; }`,
      `  echo "cc-${name}: removed from $(pwd -P)."`,
      '}',
    )
  }
  return `${out.join('\n')}\n`
}

// ---------- which startup files load cc.sh ----------

export type RcPlan = { files: string[]; note?: string }

const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile']

/**
 * The startup files that must load cc.sh for the person's shell. zsh reads
 * ~/.zshrc. bash reads ~/.bashrc when interactive, but a login shell (every new
 * macOS terminal tab) reads only the first of ~/.bash_profile, ~/.bash_login and
 * ~/.profile that exists: that file gets the line too unless it already loads
 * ~/.bashrc. `contents` maps each candidate path to its text, absent when missing.
 */
export function rcPlan(
  shellPath: string,
  home: string,
  isMac: boolean,
  contents: Record<string, string | undefined>,
  override = '',
): RcPlan {
  if (override) return { files: [override.replace(/^~(?=\/)/, home)] }
  const shell = shellPath.split('/').pop() ?? ''
  if (shell === 'zsh') return { files: [`${home}/.zshrc`] }
  const files = [`${home}/.bashrc`]
  const login = BASH_LOGIN_FILES.map(f => `${home}/${f}`).find(f => contents[f] !== undefined)
  if (login) {
    if (!/\.bashrc\b/.test(contents[login] ?? '')) files.push(login)
  } else if (isMac) {
    files.push(`${home}/.bash_profile`)
  }
  const note = shell && shell !== 'bash'
    ? `${shell} cannot load the cc-* functions (they are bash/zsh); they are set up for bash, and the /scope pane works either way`
    : undefined
  return { files, note }
}

export const rcCandidates = (home: string) => [`${home}/.zshrc`, `${home}/.bashrc`, ...BASH_LOGIN_FILES.map(f => `${home}/${f}`)]

/** The line that loads cc.sh; in a bash file it only runs under bash, as ~/.profile may be read by sh. */
export function rcLineFor(file: string, script: string): string {
  const load = `[ -f "${script}" ] && . "${script}"  # scopekeeper: cc-* kits`
  return file.endsWith('/.zshrc') ? load : `[ -n "$BASH_VERSION" ] && ${load}`
}

// ---------- merging what was observed ----------

export function addUse(ledger: Ledger, key: string, project: string, at: number, n = 1): void {
  const byProject = (ledger[key] ??= {})
  const cur = (byProject[project] ??= { n: 0, last: 0 })
  cur.n += n
  cur.last = Math.max(cur.last, at)
}

/** Adds `delta` (uses recorded since the last flush) onto `into`. */
export function mergeLedger(into: Ledger, delta: Ledger): Ledger {
  for (const [key, byProject] of Object.entries(delta)) {
    for (const [project, use] of Object.entries(byProject)) addUse(into, key, project, use.last, use.n)
  }
  return into
}

// ---------- habits and bundles ----------

/** session id -> the usage keys seen in it. */
export type Sessions = Record<string, { at: number; keys: string[] }>

export type CoUse = { sessions: Record<string, number>; pairs: Record<string, number> }

const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`)

/** How many sessions used each key, and each pair of keys together. */
export function coUse(sessions: Sessions): CoUse {
  const out: CoUse = { sessions: {}, pairs: {} }
  for (const { keys } of Object.values(sessions)) {
    const uniq = [...new Set(keys)]
    for (const [i, a] of uniq.entries()) {
      out.sessions[a] = (out.sessions[a] ?? 0) + 1
      for (const b of uniq.slice(i + 1)) out.pairs[pairKey(a, b)] = (out.pairs[pairKey(a, b)] ?? 0) + 1
    }
  }
  return out
}

/** Adds `delta` onto `into`: the later time, the keys of both. */
export function mergeSessions(into: Sessions, delta: Sessions): Sessions {
  for (const [id, s] of Object.entries(delta)) {
    const cur = into[id]
    into[id] = { at: Math.max(s.at, cur?.at ?? 0), keys: [...new Set([...(cur?.keys ?? []), ...s.keys])] }
  }
  return into
}

/** Keeps the `max` most recent sessions. */
export function trimSessions(sessions: Sessions, max = 1000): Sessions {
  const ids = Object.keys(sessions)
  if (ids.length <= max) return sessions
  return Object.fromEntries(ids.sort((a, b) => sessions[b]!.at - sessions[a]!.at).slice(0, max).map(id => [id, sessions[id]!]))
}

const GENERIC = new Set([
  'claude', 'code', 'mcp', 'ai', 'dev', 'the', 'my', 'for', 'and', 'with', 'skill', 'skills', 'agent', 'agents',
  'plugin', 'plugins', 'tool', 'tools', 'server', 'app', 'cli', 'web', 'api', 'pro', 'kit', 'best', 'practices',
])

/** The distinctive first word of a name: `remotion-best-practices` -> `remotion`. */
export function family(name: string): string {
  return name.toLowerCase().split(/[-_:.@\s]+/).find(w => w.length >= 3 && !GENERIC.has(w)) ?? ''
}

export type Habit = 'everywhere' | 'some' | 'unused'

/** Used in most of the projects you work in, in a few of them, or not at all. */
export function habitOf(item: Pick<ItemRow, 'total' | 'uses'>, activeProjects: number): Habit {
  if (item.total === 0) return 'unused'
  if (item.uses.length >= 3 && item.uses.length * 2 >= activeProjects) return 'everywhere'
  return 'some'
}

const kitName = (raw: string) => {
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 31)
  return KIT_NAME.test(name) ? name : 'kit'
}

export type Suggestions = { bundles: Bundle[]; everywhere: string[]; unused: string[] }

/**
 * Groups the unsorted globals into bundles to make local: installs that are
 * used in the same sessions, share a name, or are used in the same projects.
 * What is used in most projects is offered to keep global; what is never used,
 * and belongs to no bundle, is listed apart.
 */
export function suggest(items: readonly ItemRow[], co: CoUse, cwdProject = ''): Suggestions {
  const active = new Set(items.flatMap(i => i.uses.map(u => u.project))).size
  const open = items.filter(i => i.claim === 'new')
  const everywhere = open.filter(i => habitOf(i, active) === 'everywhere')
  const pool = open.filter(i => habitOf(i, active) !== 'everywhere')

  const parent = pool.map((_, n) => n)
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n]!)))
  const together = (a: ItemRow, b: ItemRow) => {
    const both = co.pairs[pairKey(a.id, b.id)] ?? 0
    return both >= 2 && both * 2 >= Math.min(co.sessions[a.id] ?? 0, co.sessions[b.id] ?? 0) ? both : 0
  }
  const sameProjects = (a: ItemRow, b: ItemRow) => {
    if (a.uses.length < 2 || b.uses.length < 2) return false
    const pa = new Set(a.uses.map(u => u.project))
    const shared = b.uses.filter(u => pa.has(u.project)).length
    return shared / (pa.size + b.uses.length - shared) >= 0.8
  }
  for (const [i, a] of pool.entries()) {
    for (const [j, b] of pool.entries()) {
      if (j <= i) continue
      const fam = family(a.name)
      if ((fam && fam === family(b.name)) || together(a, b) || sameProjects(a, b)) parent[find(j)] = find(i)
    }
  }

  const groups = new Map<number, ItemRow[]>()
  for (const [n, item] of pool.entries()) groups.set(find(n), [...(groups.get(find(n)) ?? []), item])

  const bundles: Bundle[] = []
  const unused: string[] = []
  for (const members of groups.values()) {
    if (members.every(m => m.total === 0)) {
      unused.push(...members.map(m => m.id))
      continue
    }
    members.sort((a, b) => b.total - a.total)
    const byProject = new Map<string, ProjectUse>()
    for (const u of members.flatMap(m => m.uses)) {
      const cur = byProject.get(u.project)
      byProject.set(u.project, { project: u.project, n: (cur?.n ?? 0) + u.n, last: Math.max(cur?.last ?? 0, u.last) })
    }
    const projects = [...byProject.values()].sort((a, b) => b.n - a.n)
    const fam = family(members[0]!.name)
    const shared = members.length > 1 && fam !== '' && members.every(m => family(m.name) === fam)
    const sessions = Math.max(0, ...members.flatMap(a => members.map(b => (a === b ? 0 : together(a, b)))))
    const why = members.length === 1 ? `used in ${plural(projects.length, 'project')}`
      : sessions ? `used together in ${plural(sessions, 'session')}`
      : shared ? `all ${fam}`
      : `used in the same ${plural(projects.length, 'project')}`
    bundles.push({
      id: members.map(m => m.id).sort().join(' '),
      name: kitName(members.length === 1 || !fam ? members[0]!.name : fam),
      ids: members.map(m => m.id),
      why,
      projects,
      total: members.reduce((s, m) => s + m.total, 0),
      direct: members.every(m => m.kind === 'plugin' || m.kind === 'mcp'),
    })
  }
  const isHere = (b: Bundle) => (b.projects.some(p => p.project === cwdProject) ? 0 : 1)
  bundles.sort((a, b) => isHere(a) - isHere(b) || b.total - a.total)
  return { bundles, everywhere: everywhere.map(i => i.id), unused }
}

// ---------- display helpers ----------

export const DAY = 86_400_000

/** On in a project and neither used nor (re)enabled there for `days`. */
export const isStale = (p: { status: string; last: number; since: number }, now: number, days: number) =>
  p.status === 'on' && Math.max(p.last, p.since) > 0 && now - Math.max(p.last, p.since) > days * DAY

const LIGHTS = 4

/** `info` is what hovering the light tells: empty for a kit on and in use. `isIdle`: on, unused for staleDays. */
export type Light = { glyph: '●' | '◐' | '○'; name: string; info: string; isIdle: boolean }

/** The band's parts: this project's kits as lights, and how many more there are. */
export type Band = { lights: Light[]; more: number }

/** What a light adds on hover, in a few words: what is off, or how long it sat unused. */
export function lightInfo(pr: KitProject, now: number, staleDays: number): string {
  const used = pr.n > 0 ? `used ${count(pr.n)}× here, last ${ago(pr.last, now)} ago` : ''
  if (pr.status === 'on') return isStale(pr, now, staleDays) ? `on, unused for ${ago(Math.max(pr.last, pr.since), now)}` : ''
  if (pr.status === 'off') return ['off', used].filter(Boolean).join(' · ')
  return [pr.off?.length ? `missing ${pr.off.join(', ')}` : 'partly on', used].filter(Boolean).join(' · ')
}

/** This project's kits as lights: ● on, ◐ partly on, ○ used here but off. Undefined when none are. */
export function band(snap: Snapshot, staleDays = 30): Band | undefined {
  const here = snap.kits.flatMap(c => {
    const pr = c.projects.find(p => p.project === snap.cwdProject)
    return pr ? [{
      name: c.name,
      glyph: (pr.status === 'on' ? '●' : pr.status === 'partial' ? '◐' : '○') as Light['glyph'],
      info: lightInfo(pr, snap.scannedAt, staleDays),
      isIdle: isStale(pr, snap.scannedAt, staleDays),
    }] : []
  })
  if (!here.length) return undefined
  // Past the cap, the kits not fully on stay, then the idle ones; the rest keep their alphabetical place.
  const shown = new Set([...here.filter(k => k.glyph !== '●'), ...here.filter(k => k.isIdle), ...here].slice(0, LIGHTS))
  return { lights: here.filter(k => shown.has(k)), more: Math.max(0, here.length - LIGHTS) }
}

/**
 * What Claude is told once per conversation: the kits not on in this project, so it can offer one
 * (enable_kit) instead of saying it cannot. Undefined outside a project or when every kit is on.
 */
export function kitsContext(snap: Pick<Snapshot, 'cwdProject' | 'kits'>, tool: string): string | undefined {
  if (!snap.cwdProject) return undefined
  const off = snap.kits.filter(c => c.projects.find(p => p.project === snap.cwdProject)?.status !== 'on')
  if (!off.length) return undefined
  return [
    `These tool kits are installed on this machine but not on in this project, so their tools are not loaded here.`,
    `When the person's request needs one of them, offer to turn it on with ${tool} (the person confirms); its tools load from the next turn.`,
    ...off.map(c => `- ${c.name}: ${clip(c.summary.replace(/\s+/g, ' '), 80)}`),
  ].join('\n')
}

/** The band as one line of text: `● vercel  ○ remotion`. */
export function bandText(snap: Snapshot): string | undefined {
  const b = band(snap)
  return b && [...b.lights.map(l => `${l.glyph} ${l.name}`), ...(b.more ? [`+${b.more}`] : [])].join('  ')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Sep 26`, with the year when it is not `now`'s. */
export function day(at: number, now: number): string {
  const d = new Date(at)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`
}

export function ago(then: number, now: number): string {
  if (!then) return '—'
  const s = Math.max(0, (now - then) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  return `${Math.round(s / (86400 * 30))}mo`
}

export function count(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function shortPath(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`
}

/** `fit` without the padding: for the last cell of a row. */
export const clip = (text: string, width: number) => fit(text, width).trimEnd()

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

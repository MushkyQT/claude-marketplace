export type ItemKind = 'plugin' | 'skill' | 'agent' | 'mcp'

/** A thing installed at user scope, loaded in every session. */
export type GlobalItem = {
  /** Usage key: `plugin:<name>`, `skill:<name>`, `agent:<name>`, `mcp:<name>`. */
  id: string
  kind: ItemKind
  name: string
  /** `name@marketplace` for a plugin; the path for a skill or agent. */
  ref: string
  /** `keep`, `combo:<name>`, or `new` (not classified yet). */
  claim: string
}

export type ProjectUse = { project: string; n: number; last: number }

export type ItemRow = GlobalItem & { total: number; last: number; uses: ProjectUse[] }

export type ComboProject = {
  project: string
  status: 'on' | 'partial' | 'off'
  n: number
  last: number
  /** When scopekeeper enabled it there, or first saw it on with no use since; 0 if unknown. */
  since: number
}

export type ComboRow = {
  name: string
  summary: string
  /** One line per part: what cc-<name> installs or runs. */
  parts: string[]
  /** Global items this combo covers that are still installed globally. */
  globals: string[]
  projects: ComboProject[]
}

/** Unsorted globals that belong together, offered as one combo to make local. */
export type Bundle = {
  /** The sorted member ids, joined: stable while the members are. */
  id: string
  /** The combo name it would be saved under. */
  name: string
  ids: string[]
  /** Why these go together, in a few words. */
  why: string
  /** Projects where its members were used, most-used first. */
  projects: ProjectUse[]
  total: number
  /** Only plugins and MCP servers: it can be made local without Claude working out sources. */
  direct: boolean
}

export type Snapshot = {
  scannedAt: number
  home: string
  cwdProject: string
  items: ItemRow[]
  combos: ComboRow[]
  /** Suggested from the unsorted globals: bundles to make local. */
  bundles: Bundle[]
  /** Unsorted globals used in most projects: worth keeping global. */
  everywhere: string[]
  /** Unsorted globals with no recorded use, in no bundle. */
  unused: string[]
  backfilledAt: number
  /** The oldest use on record: counts cover usage since then. 0 if unknown. */
  historySince: number
  /** Why usage history could not be read, if it could not. */
  historyProblem: string
  rcLoaded: boolean
  problems: string[]
}

export type View = { tab: 'globals' | 'combos'; selected: string; showKept: boolean }

declare module 'claude-code' {
  interface PluginState {
    scopekeeper: {
      snapshot: Shaped<Snapshot | null>
      view: Shaped<View>
      /** The element under the focus ring in the open pane: it only names what Enter does there. */
      pick: string
      /** The suggestion opened with Enter in the local pane. */
      opened: string
      /** The views whose help the person hid with h (kept in the store too, so it shows once per view). */
      helpHidden: string[]
      busy: string
      log: string[]
    }
  }
}

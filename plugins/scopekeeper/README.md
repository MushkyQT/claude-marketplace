# scopekeeper

Keep your global Claude Code setup lean. scopekeeper shows every plugin, skill, agent and MCP server installed at user scope next to how much you actually use it and in which projects. It then turns the ones you only need in some projects into **kits**: shell commands (`cc-<kit>`) that enable a set of tools in one project, at local scope, without committing anything to the project.

## What it does

- **Records usage as you work.** Every skill, MCP tool, agent and slash command call is counted per project: a git repo's root (worktrees folded into their main repo), or the folder itself outside git. On first run it backfills from the transcripts already on disk (needs `python3`).
- **Spots what belongs together.** Globals used in the same sessions, named alike (`remotion-*`), or used in the same projects are grouped into one suggested kit. Globals you use in most projects are offered to keep global.
- **Speaks for the project you are in.** A row just above the prompt shows this project's kits as lights: `● vercel  ○ remotion`. `●` on (green, dimmed when it went unused for the stale period), `◐` partly on and `○` used here but off (yellow); names keep your theme's text color. Hover a light that is not plainly on for a short line after the lights saying why: what is missing, when you last used it, or how long it sat idle. Kits never used here stay out, and past four lights the ones not fully on stay, then the idle ones. Click a light to turn that kit on or off in this project; it asks first, as Enter does in the pane. With no kits here the row is not drawn; it gives way to Claude Code's surveys, and `[-]` beside it collapses it.
- **Turns globals into kits.** A kit lists its parts: plugins (`name@marketplace`), MCP servers (their JSON), skills copied from a git repo, or a project installer command (like `npx impeccable install --project`). scopekeeper generates `cc-<kit>` and `cc-<kit>-off` for each.
- **Adopts a kit in one press.** Enables it in every project where you used it, checks every part took, then removes the global installs one at a time (skills and agents are moved to a backup, never deleted). If any part is missing anywhere, the globals stay.
- **Takes effect right away.** A kit turned on or off in the project you are in, or a global removed, reloads plugins in this session once it is idle. Other open sessions in that project still need `/reload-plugins`.
- **Lets Claude offer a kit.** At the start of each conversation Claude is told which of your kits are not on in this project, a line each. When a request needs one, Claude can turn it on with the `enable_kit` tool, after you confirm, as with Enter in the pane.

Everything it enables stays out of git: plugins and MCP servers at local scope, copied files listed in `.git/info/exclude`. In a git worktree, kits follow the main checkout: Claude Code loads a worktree's local plugins, MCP servers, skills and agents from there, so a kit on in the project is on in all its worktrees.

Turning a kit off removes only what it put there: for skills from a git repo, the folders named in its clone, so a skill of your own with a similar name stays. Installer paths must name what they write under `.claude/` (`.claude/skills/impeccable`, `.claude/agents/impeccable-*`); a path like `*` or `.claude/skills/*` is refused when the kit is saved.

## Install

In a Claude Code terminal session:

```
/plugin install scopekeeper --marketplace MushkyQT/claude-marketplace
```

From a shell: `claude plugin install scopekeeper --marketplace MushkyQT/claude-marketplace`.

## Use

| | |
|---|---|
| `/scope` | Opens the local pane (*Scope · Local*): which kits are on in this project, and the globals to make local. |
| `/scope advanced` | Opens the advanced pane (*Scope · all projects*): every global install and every kit across all your projects. |
| `/scope triage` | Claude inspects your unsorted globals, works out how each was installed, groups what belongs together, asks you, and saves kits or keep-globals. It installs and removes nothing. |
| `/scope audit` | The same overview as text. |
| `/scope adopt <kit>` | Enable where used, then remove the globals (asks first). |
| `/scope enable <kit>` / `/scope off <kit>` | Toggle a kit in the current project. |
| `/scope backfill` | Re-read usage from your transcripts. |

### The local pane

Two short lists, and nothing else:

- **In this project**: each kit, `●` on or `○` off here. The right column only speaks up when something needs a look: `used 3d ago` (yellow, listed first) when you used it here but it is not on, `idle` when it is on but went unused for the stale period, `partial` when only some parts are on. Enter toggles the selected one in this project (it asks first, saying what it installs and runs). When any are used here but off, a line under the list names them and `y` turns them all on, after one question.
- **Global, but used in few projects**: suggested kits from your unsorted globals, the ones used in this project first, each with why its parts go together. Enter opens one (marked `›`): its actions first, then the projects it was used in, one a line with how often and how lately (the first five, then a count of the rest). Enter again closes it; the arrows only move, so they never skip a line. `l` makes it local: for plugins and MCP servers it saves the kit, turns it on in the projects that used it, and removes the globals (backed up), after one question; a suggestion holding skills or agents goes to Claude, which works out where they come from first. `k` keeps it global instead. A last row gathers the globals you use in most projects, for `k` to keep them all.

One line under the lists counts your globals: always on (kept global), to make local, never used.

Both panes put their keys in the same place, one row under the header: `a` switches to the other pane, `r` rescans, `t` lets Claude triage every unsorted global, and last, what Enter does on the row under the cursor. Each view opens with a short help box under the keys: what the view is for, what its marks and colours mean, and its keys. `h: Hide help` sits in the box's top border; once hidden, the help stays hidden in later sessions, and `h: Help` in the keys row brings it back.

### The advanced pane

Local and advanced are two modes of one pane: `a` redraws it in place, so it keeps its seat (beside the transcript, or above the prompt on a narrower terminal) and the keyboard. A question an action asks gives the keys back to the pane once answered.

Tab or the arrows move through the rows without changing them; Enter opens one in place, its actions first and its details under them, and Enter again closes it; nothing starts open, so the arrows always land on the next line you see. `g`/`i` switch tabs, `a` goes back to the local pane, `r` rescans, `t` triages. **Globals** tab: every user-scope install with calls, last use, project count and its status (`new`, `keep`, or the kit covering it). On a global: `k` keep global (`u` to undo), `m` make a kit with Claude, `x` remove, `o` adopt its kit. **Kits** tab: each kit, how many projects it is on in, and what to do next (`adopt`, `turn on N` where it was used but is off, `prune N` stale). On a kit: Enter on a project toggles it, `o` adopts, `e` enables it in the current project, `p` prunes it from the projects where it went stale.

Its header says what is waiting on you: unsorted globals, globals a kit covers but that are still installed (adopt them), projects where a kit was used but is off, and stale ones. Counts cover usage since the oldest transcript scopekeeper has read, shown as `usage since <date>`; until the first read finishes they show `…` and nothing can be removed.

From a shell, `cc-<kit>` and `cc-<kit>-off` work in any project folder once your shell loads them. scopekeeper offers to add that one line the first time you adopt (or press `s` in the pane): `~/.zshrc` for zsh; for bash and any other shell, `~/.bashrc` plus the login file bash reads first (`~/.bash_profile`, `~/.bash_login` or `~/.profile`, created on macOS) unless it already loads `~/.bashrc`. fish cannot load the functions; the pane still works there.

## Files

- `~/.claude/scopekeeper/kits.json`: your kits and keep-globals, editable by hand. If an edit leaves it unreadable, the panes say so and nothing is saved over it until you fix it; the version before each save is kept as `backups/kits.json.prev`. A kit that fails validation is left out of `cc.sh`, and the panes name it. A `combos.json` from before 0.5 is read once, saved here, and moved to `backups/`.
- `~/.claude/scopekeeper/cc.sh`: the generated functions (bash and zsh). Overwritten when kits change.
- `~/.claude/scopekeeper/backups/`: settings, `~/.claude.json`, and any skill or agent folder taken out of the global scope.

`kits.json` and `cc.sh` can hold an MCP server's env and headers, copied from `~/.claude.json`, so they are readable by you only (`600`, the folder `700`).
- `~/.claude/skill-library/`: clones that git-skills kits copy from.

`CLAUDE_CONFIG_DIR` is honoured. Options (`/config`): days a kit may sit unused in a project, counted from its last use or from when it was enabled, before it counts as stale (default 30), and a single rc file to use instead of the ones picked from `$SHELL`.

## Limits

- Connectors from claude.ai are not managed here: turn those off in `/mcp`.
- The panes need a terminal at least 110 columns wide to dock, or open above the prompt.
- Suggestions from co-use need sessions that used more than one install: on a fresh setup they lean on names and shared projects.
- Usage recorded before installing scopekeeper only comes from transcripts still on disk (Claude Code deletes them after `cleanupPeriodDays`).

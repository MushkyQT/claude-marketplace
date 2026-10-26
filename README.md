# mushkyqt: Claude Code plugins

Plugins, skill packs and mods I use and share. Add the marketplace once, then install what you want from it.

## Install

In a Claude Code terminal session:

```
/plugin marketplace add MushkyQT/claude-marketplace
/plugin install <plugin>@mushkyqt
```

From a shell: `claude plugin marketplace add MushkyQT/claude-marketplace`, then `claude plugin install <plugin>@mushkyqt`. Add `--scope local` to install for one project only, without committing anything.

`/plugin marketplace update mushkyqt` picks up new plugins and versions.

## What's here

| Plugin | What it does |
|---|---|
| [scopekeeper](plugins/scopekeeper) | Shows every global plugin, skill, agent and MCP server next to how much you use it and where, turns the project-specific ones into `cc-*` kits, and removes the globals once the projects have them. `/scope` opens its pane. |

## Adding a plugin

Each plugin is a folder under `plugins/` plus one entry in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json):

```json
{ "name": "<plugin>", "source": "./plugins/<plugin>", "description": "<one line>" }
```

What goes in the folder depends on what you are sharing. Every kind needs `.claude-plugin/plugin.json` (`{ "name", "version", "description", "license" }`) and a README:

| Sharing | Folder holds |
|---|---|
| Skills | `skills/<skill>/SKILL.md` (and the skill's files). Invoked as `/<plugin>:<skill>`. |
| Agents | `agents/<agent>.md` |
| Slash commands | `commands/<command>.md` |
| An MCP server | `.mcp.json` |
| A mod (hooks module, panes, tools) | `hooks/hooks.json` naming `hooks/register.tsx`, plus `types/index.d.ts` if it keeps state. See scopekeeper. |

Kinds combine: one plugin can ship skills, agents and an MCP server together.

Check before pushing: `claude plugin validate plugins/<plugin>` and `claude plugin validate .` (the catalog). Bump `version` in the plugin's `plugin.json` when you change it, so installs see the update.

While working on one locally, this folder is installed as a marketplace (`claude plugin marketplace add ~/Projects/claude-marketplace`): Claude Code reads each plugin from here, so `/reload-plugins` applies an edit.

## License

MIT, unless a plugin's own `plugin.json` says otherwise.

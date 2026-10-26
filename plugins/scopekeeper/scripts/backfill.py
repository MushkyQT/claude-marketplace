"""Scan Claude Code transcripts and prompt history for skill, MCP, agent and
slash-command use. Prints one JSON object:
{"events": [[kind, name, cwd, n, last_ms], ...], "since": oldest_ms,
 "sessions": [[session_id, last_ms, [[kind, name], ...]], ...]}.
The mod classifies the events; this script only counts them.

usage: python3 -I backfill.py <claude-config-dir>
"""
import collections
import datetime
import glob
import json
import os
import re
import sys

COMMAND = re.compile(r"<command-name>/?([^<\s]+)\s*</command-name>")


def ms(ts):
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return 0


def main(config_dir):
    counts = collections.defaultdict(lambda: [0, 0])
    earliest = [None]
    # What each session used, so the mod can tell which installs go together.
    sessions = collections.defaultdict(lambda: [0, set()])

    def bump(kind, name, cwd, at, session=None):
        if name and cwd:
            if at and (earliest[0] is None or at < earliest[0]):
                earliest[0] = at
            entry = counts[(kind, name, cwd)]
            entry[0] += 1
            entry[1] = max(entry[1], at)
            if session:
                used = sessions[session]
                used[0] = max(used[0], at)
                used[1].add((kind, name))

    for path in glob.glob(os.path.join(config_dir, "projects", "**", "*.jsonl"), recursive=True):
        cwd = None
        session = os.path.splitext(os.path.basename(path))[0]
        try:
            handle = open(path, encoding="utf-8", errors="ignore")
        except OSError:
            continue
        with handle:
            for line in handle:
                if '"tool_use"' not in line and "command-name" not in line:
                    if '"cwd"' in line and cwd is None:
                        try:
                            cwd = json.loads(line).get("cwd") or cwd
                        except ValueError:
                            pass
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                cwd = row.get("cwd") or cwd
                session = row.get("sessionId") or session
                at = ms(row.get("timestamp") or "")
                message = row.get("message")
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                texts = [content] if isinstance(content, str) else []
                for block in content if isinstance(content, list) else []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text":
                        texts.append(block.get("text") or "")
                    if block.get("type") != "tool_use":
                        continue
                    name = block.get("name") or ""
                    args = block.get("input") or {}
                    if name == "Skill":
                        bump("skill", args.get("skill"), cwd, at, session)
                    elif name in ("Agent", "Task"):
                        bump("agent", args.get("subagent_type") or "general-purpose", cwd, at, session)
                    elif name.startswith("mcp__"):
                        end = name.find("__", 5)
                        if end > 5:
                            bump("mcp", name[5:end], cwd, at, session)
                for text in texts:
                    for command in COMMAND.findall(text):
                        bump("command", command, cwd, at, session)

    # History repeats the slash commands transcripts already hold: only take what
    # is older than the oldest transcript left on disk.
    cutoff = earliest[0] or float("inf")
    history = os.path.join(config_dir, "history.jsonl")
    if os.path.exists(history):
        with open(history, encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                text = (row.get("display") or "").strip()
                at = int(row.get("timestamp") or 0)
                if text.startswith("/") and at < cutoff:
                    name = text.split()[0][1:]
                    if name and "/" not in name:
                        bump("command", name, row.get("project"), at)

    events = [[k, n, c, v[0], v[1]] for (k, n, c), v in counts.items()]
    used = [[sid, at, sorted(keys)] for sid, (at, keys) in sessions.items()]
    json.dump({"events": events, "since": earliest[0], "sessions": used}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])

# Dev Install Guide

Quick setup for testing the obsidian-claude-code plugin in your vault.

## Prerequisites

- Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- Claude Code CLI installed (for `claude setup-token`)
- Obsidian desktop app

## 1. Build the Plugin

```bash
cd /path/to/obsidian-claude-code
bun install
bun run build
```

Verify build succeeded:
```bash
ls -la main.js  # Should exist, ~500KB+
```

## 2. Symlink to Your Vault

```bash
# Create plugins directory if needed
mkdir -p /path/to/your/vault/.obsidian/plugins

# Create symlink
ln -sf /path/to/obsidian-claude-code \
       /path/to/your/vault/.obsidian/plugins/obsidian-claude-code

# Verify
ls -la /path/to/your/vault/.obsidian/plugins/
```

## 3. Set Up Authentication

### Option A: Claude Max Subscription (Recommended)

Uses your existing subscription - no API billing:

```bash
claude setup-token
```

Follow the prompts to authenticate. This creates `CLAUDE_CODE_OAUTH_TOKEN` in your environment.

**Important for macOS GUI apps**: Obsidian (launched from Dock/Finder) doesn't inherit shell environment variables. Make them available to GUI apps:

```bash
launchctl setenv CLAUDE_CODE_OAUTH_TOKEN "$(echo $CLAUDE_CODE_OAUTH_TOKEN)"
```

Then restart Obsidian.

### Option B: API Key

Set environment variable before launching Obsidian:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
open -a Obsidian
```

Or enter the key in plugin settings after enabling.

## 4. Enable the Plugin

1. Open Obsidian
2. Settings → Community Plugins
3. Turn off "Restricted Mode" if prompted
4. Find "Claude Code" in the list
5. Toggle it ON

## 5. Verify It Works

1. Click the chat icon in the left ribbon (or `Cmd+Shift+C`)
2. The sidebar should open with "Start a conversation"
3. Send a test message: "What files are in my vault?"

### Check Console for Logs

`Cmd+Option+I` to open DevTools, look for:
```
[AgentController] Session initialized: ...
[AgentController] Available tools: Read, Write, Edit, Bash, ...
```

## 6. Test Key Features

### Built-in Tools (SDK)
```
"Read the file README.md"
"Search for files containing 'TODO'"
"What's in the TaskNotes folder?"
```

### Obsidian-Specific Tools (MCP Server)
```
"Open the file TaskNotes/Tasks/example.md"
"Show me vault statistics"
"What Obsidian commands are available for daily notes?"
"Create a new note called 'test-note.md' with some content"
```

### Skills (if vault-search configured)
```
"Search my notes for anything about project planning"
"Find notes similar to the current file"
```

## 7. Development Workflow

For active development with auto-rebuild:

```bash
# Terminal 1: Watch mode
bun run dev

# Terminal 2: Monitor debug logs
tail -f ~/.obsidian-claude-code/debug.log
```

To reload after changes:
- `Cmd+P` → "Reload app without saving"
- Or: Settings → Community Plugins → Toggle plugin off/on

## Troubleshooting

### Plugin not appearing
```bash
# Check manifest exists
cat /path/to/obsidian-claude-code/manifest.json

# Check symlink is correct
ls -la /path/to/your/vault/.obsidian/plugins/obsidian-claude-code
```

### Auth not working
```bash
# Check env vars are set
echo $ANTHROPIC_API_KEY
echo $CLAUDE_CODE_OAUTH_TOKEN

# If using Max subscription, re-auth
claude setup-token
```

### Build errors
```bash
# Full rebuild
rm -rf node_modules bun.lock
bun install
bun run build
```

### Console errors
Open DevTools (`Cmd+Option+I`) and check for:
- Red error messages
- Network failures to api.anthropic.com
- Missing tools in initialization

### "Claude Code native binary not found"
The plugin needs to find the Claude CLI. It checks:
- `~/.nvm/versions/node/*/bin/claude`
- `/usr/local/bin/claude`
- `/opt/homebrew/bin/claude`

Verify Claude is installed:
```bash
which claude
claude --version
```

### Model not found (404 error)
Use simplified model names in settings:
- `sonnet` - Claude Sonnet 4 (faster)
- `opus` - Claude Opus 4.5 (more capable)
- `haiku` - Claude Haiku (fastest)

Do NOT use full model IDs like `claude-opus-4-5-20251101`.

## Quick Test Checklist

- [ ] Plugin appears in Community Plugins list
- [ ] Chat sidebar opens
- [ ] Auth status shows in settings (API key or env var detected)
- [ ] Basic message gets response
- [ ] Tool calls appear (collapsible blocks)
- [ ] "Open file" command works (file opens in Obsidian)
- [ ] New conversation button works
- [ ] History modal shows previous conversations

## File Locations

| What | Where |
|------|-------|
| Plugin source | Your clone of the repo |
| Built plugin | `main.js` in source dir |
| Symlink | `<vault>/.obsidian/plugins/obsidian-claude-code` |
| Conversations | `<vault>/.obsidian-claude-code/` |
| Debug logs | `~/.obsidian-claude-code/debug.log` |
| Skills | `<vault>/.claude/skills/` |
| SDK sessions | `~/.claude/projects/` |

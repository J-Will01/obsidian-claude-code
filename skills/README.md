# Obsidian Claude Code Skills

This folder contains example skills that extend Claude's capabilities when working with your Obsidian vault.

## What Are Skills?

Skills are specialized prompts that give Claude domain-specific knowledge and allowed tools for particular tasks. They're defined in `SKILL.md` files with YAML frontmatter.

## Installing Skills

Skills must be placed in your **vault's** `.claude/skills/` directory:

```
your-vault/
├── .claude/
│   └── skills/
│       └── vault-search/
│           ├── SKILL.md
│           └── scripts/
│               ├── search.py
│               ├── dataview.py
│               └── index.py
└── ... your notes ...
```

### Quick Install

Copy the vault-search skill to your vault:

```bash
# Replace /path/to/vault with your actual vault path
cp -r skills/vault-search /path/to/vault/.claude/skills/
```

### Setting Up vault-search

The vault-search skill requires a Python environment with dependencies:

```bash
cd /path/to/vault/.claude

# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install sqlite-vec chromadb pyyaml
```

Build the initial index:

```bash
# Still in the venv
python skills/vault-search/scripts/index.py --vault-path /path/to/vault --rebuild
```

### Updating Paths

After copying, update the hardcoded paths in the scripts:

1. **`SKILL.md`**: Update the Python interpreter path
2. **`search.py`**: Update `DEFAULT_DB_PATH`
3. **`dataview.py`**: Update `DEFAULT_DB_PATH`
4. **`index.py`**: Update `DEFAULT_VAULT_PATH` and `DEFAULT_DB_PATH`

## How Skills Are Loaded

The Obsidian Claude Code plugin uses the Claude Agent SDK with `settingSources: ['project']`. This tells the SDK to:

1. Look for `.claude/` directory in the working directory (your vault)
2. Load skills from `.claude/skills/*/SKILL.md`
3. Make skills available to Claude during conversations

## Skill Anatomy

A skill consists of a `SKILL.md` file with:

```markdown
---
name: skill-name
description: When and how to use this skill. Include trigger phrases.
allowed-tools: Read, Write, Bash(python:*)
---

# Skill Title

Instructions, examples, and documentation for Claude.
```

### Frontmatter Fields

- **name**: Unique identifier for the skill
- **description**: Helps Claude decide when to use the skill (include trigger phrases!)
- **allowed-tools**: Tools Claude can use (restricts the default toolset)

## Creating Custom Skills

1. Create a folder in `your-vault/.claude/skills/your-skill-name/`
2. Add a `SKILL.md` with frontmatter and instructions
3. Optionally add scripts in a `scripts/` subfolder
4. Reload Obsidian or restart the plugin

### Example: Simple Note Template Skill

```markdown
---
name: note-templates
description: Create notes from templates. Use when asked to "create a meeting note", "new daily note", or "start a project doc".
allowed-tools: Read, Write
---

# Note Templates

When the user asks to create a templated note:

1. Ask which template type they want
2. Read the template from Templates/ folder
3. Replace placeholders with user-provided values
4. Write to the appropriate folder

## Available Templates

- Meeting Notes: `Templates/meeting.md`
- Daily Notes: `Templates/daily.md`
- Project Docs: `Templates/project.md`
```

## Included Skills

### vault-search

Semantic search and Dataview-style SQL queries across your vault.

**Features:**
- Vector similarity search using embeddings
- SQL queries against frontmatter metadata
- Combine semantic and metadata filters

**Trigger phrases:**
- "search vault for..."
- "find notes about..."
- "list open tasks"
- "what do I have on..."

See `vault-search/SKILL.md` for full documentation.

## Troubleshooting

### Skills Not Loading

1. Ensure skills are in `your-vault/.claude/skills/`
2. Check that each skill has a valid `SKILL.md` with frontmatter
3. Restart Obsidian after adding new skills

### Python Scripts Not Working

1. Verify the Python interpreter path in `SKILL.md`
2. Check that the virtual environment has required packages
3. Test scripts directly from terminal first

### Search Returns No Results

1. Run the indexer: `python index.py --vault-path /path/to/vault --rebuild`
2. Check index stats: `python index.py --stats`
3. Verify excluded folders aren't hiding your notes

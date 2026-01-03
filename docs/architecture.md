# Architecture

This document describes the internal architecture of obsidian-claude-code, covering component responsibilities, data flow, and key design decisions.

## System Overview

The plugin uses the Claude Agent SDK's `query()` function to bridge Obsidian's workspace with Claude. User messages flow through an agent controller that manages sessions and tool execution, while responses stream back through a view layer that renders markdown and tool call visualizations.

```mermaid
graph TB
    subgraph Obsidian
        WS[Workspace]
        Vault[Vault API]
        Settings[Plugin Settings]
    end

    subgraph Plugin
        Main[ClaudeCodePlugin]
        CV[ChatView]
        AC[AgentController]
        OMS[ObsidianMcpServer]
        CM[ConversationManager]
    end

    subgraph "Claude Agent SDK"
        Query[query&#40&#41]
        Tools[Built-in Tools]
        Skills[Skill Loader]
    end

    WS --> Main
    Main --> CV
    Main --> Settings
    CV <--> AC
    AC <--> Query
    Query --> Tools
    Query --> Skills
    Query --> OMS
    AC --> CM
    CM --> Vault
    OMS --> Vault
    OMS --> WS
```

## Component Hierarchy

### ClaudeCodePlugin

The plugin entry point (`src/main.ts`) handles Obsidian lifecycle events. On load, it registers the chat view type, adds ribbon and command palette entries, and initializes the settings tab.

Key responsibilities:
- Register `ChatView` as an `ItemView` type
- Bind keyboard shortcuts (`Cmd+Shift+C` for toggle)
- Persist settings via Obsidian's `loadData`/`saveData`
- Coordinate view lifecycle (create, reveal, detach)
- Check for authentication (API key or env vars)

### ChatView

The primary interface (`src/views/ChatView.ts`) extends Obsidian's `ItemView` to render in the right sidebar. It instantiates the agent controller and conversation manager, wiring them together during initialization.

```mermaid
classDiagram
    class ChatView {
        -agentController: AgentController
        -conversationManager: ConversationManager
        -messageList: MessageList
        -chatInput: ChatInput
        +onOpen()
        +onClose()
        +handleSendMessage(content)
        +startNewConversation()
    }

    class MessageList {
        -messages: ChatMessage[]
        -containerEl: HTMLElement
        +addMessage(message)
        +updateMessage(id, content)
        +clear()
    }

    class ChatInput {
        -textareaEl: HTMLTextAreaElement
        -autocomplete: AutocompletePopup
        +onSend: callback
        +focus()
    }

    ChatView --> MessageList
    ChatView --> ChatInput
    MessageList --> MessageRenderer
    ChatInput --> AutocompletePopup
```

The view decomposes into:
- `MessageList`: Scrollable container for conversation messages
- `MessageRenderer`: Individual message with markdown rendering and tool call display
- `ChatInput`: Textarea with autocomplete for commands and file mentions
- `AutocompletePopup`: Floating suggestion list for `/commands` and `@files`

### AgentController

The SDK orchestrator (`src/agent/AgentController.ts`) manages the Claude Agent SDK query and session state. Each user message triggers a call to `query()`, which handles the entire tool execution loop internally.

```mermaid
sequenceDiagram
    participant User
    participant ChatView
    participant AgentController
    participant "Claude Agent SDK"
    participant ObsidianMcpServer

    User->>ChatView: Send message
    ChatView->>AgentController: sendMessage(content)
    AgentController->>"Claude Agent SDK": query({ prompt, options })

    Note over "Claude Agent SDK": SDK handles tool loop internally

    loop Tool Use (internal to SDK)
        "Claude Agent SDK"->>ObsidianMcpServer: mcp__obsidian__* tool
        ObsidianMcpServer-->>"Claude Agent SDK": Tool result
    end

    "Claude Agent SDK"-->>AgentController: Stream SDKMessage events
    AgentController-->>ChatView: ChatMessage updates
    ChatView->>User: Render response
```

The controller uses the SDK's `query()` function with these key options:
- `settingSources: ['project']` - Load CLAUDE.md and skills from vault
- `tools: { preset: 'claude_code' }` - Use all built-in Claude Code tools
- `systemPrompt: { preset: 'claude_code' }` - Use Claude Code's system prompt
- `mcpServers: { obsidian: obsidianMcp }` - Register custom Obsidian tools
- `resume: sessionId` - Resume previous conversation sessions

### ObsidianMcpServer

Custom tool definitions (`src/agent/ObsidianMcpServer.ts`) using the SDK's `createSdkMcpServer()` and `tool()` helpers. These tools are Obsidian-specific and allow Claude to interact with the Obsidian UI.

```mermaid
graph LR
    subgraph ObsidianMcpServer
        OF[open_file]
        EC[execute_command]
        SN[show_notice]
        GAF[get_active_file]
        RVI[rebuild_vault_index]
        LC[list_commands]
        CN[create_note]
        RIE[reveal_in_explorer]
        GVS[get_vault_stats]
        GRF[get_recent_files]
    end

    subgraph "Obsidian API"
        WS[Workspace]
        Vault[Vault]
        Commands[Commands]
    end

    OF --> WS
    EC --> Commands
    GAF --> WS
    RIE --> WS
    CN --> Vault
    GVS --> Vault
    GRF --> Vault
```

Each tool is defined with:
- Name and description for Claude
- Zod schema for input validation
- Handler function that returns MCP-compliant results

### ConversationManager

Persistence layer (`src/agent/ConversationManager.ts`) stores conversation metadata and message history. The data model separates a lightweight index from full message payloads:

```mermaid
erDiagram
    CONVERSATIONS_INDEX ||--o{ CONVERSATION : contains
    CONVERSATION ||--o{ MESSAGE : has

    CONVERSATIONS_INDEX {
        string path ".obsidian-claude-code/conversations.json"
    }

    CONVERSATION {
        string id "UUID"
        string sessionId "SDK session ID for resumption"
        string title "First message excerpt"
        number createdAt "Unix timestamp"
        number updatedAt "Unix timestamp"
        number messageCount "Total messages"
    }

    MESSAGE {
        string id "UUID"
        string role "user | assistant"
        string content "Message text"
        number timestamp "Unix timestamp"
        array toolCalls "Optional tool invocations"
    }
```

On load, the manager reads the index and can lazily load individual conversation histories. The `sessionId` field stores the SDK session ID for resuming conversations via the SDK's resume feature.

## Tool Architecture

### Three Layers of Tools

The plugin provides tools to Claude through three mechanisms:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Built-in Tools (from SDK preset)                 │
│  Read, Write, Edit, Bash, Grep, Glob, WebFetch, etc.       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Skills (from vault/.claude/skills/)              │
│  vault-search: semantic search + SQL queries               │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Obsidian MCP Server (ObsidianMcpServer.ts)       │
│  open_file, execute_command, show_notice, etc.             │
└─────────────────────────────────────────────────────────────┘
```

**Layer 1** - Built-in tools are provided by the Claude Agent SDK when using `tools: { preset: 'claude_code' }`. These include all standard file, search, and shell operations.

**Layer 2** - Skills are loaded automatically when `settingSources: ['project']` is set. The SDK scans `vault/.claude/skills/*/SKILL.md` and makes those tools available to Claude.

**Layer 3** - Custom Obsidian tools are defined in `ObsidianMcpServer.ts` using the SDK's MCP server API. These provide Obsidian-specific capabilities that aren't available through the file system.

### Permission Handling

Permissions are handled through the SDK's `canUseTool` callback:

```mermaid
flowchart TD
    Call[Tool Call] --> Check{canUseTool callback}
    Check -->|Read-only tool| Allow[Return allow]
    Check -->|Write tool| AutoApprove{autoApproveWrites?}
    AutoApprove -->|Yes| Allow
    AutoApprove -->|No| Modal[Show PermissionModal]
    Check -->|Obsidian UI tool| Allow
    Modal -->|Approve| Allow
    Modal -->|Deny| Deny[Return deny with message]
    Allow --> Execute[SDK executes tool]
    Deny --> Claude[Claude receives denial]
```

Read-only tools (Read, Glob, Grep, get_active_file, etc.) are auto-approved. Write operations check the `autoApproveVaultWrites` setting. Obsidian UI tools (open_file, execute_command, show_notice) are auto-approved since they don't modify vault content.

## Data Flow

### Message Processing Pipeline

```mermaid
flowchart LR
    subgraph Input
        UI[User Input]
        CTX[Context Files]
    end

    subgraph SDK
        Query[query&#40&#41]
        Tools[Tool Execution]
        Skills[Skill Invocation]
    end

    subgraph Response
        Stream[SDKMessage stream]
        Render[Render markdown]
    end

    UI --> Query
    CTX --> Query
    Query --> Tools
    Query --> Skills
    Tools --> Query
    Skills --> Query
    Query --> Stream
    Stream --> Render
```

User input is passed directly to the SDK's `query()` function. The SDK handles:
- Building the full prompt with system instructions
- Managing conversation context via session resumption
- Executing tools and feeding results back to Claude
- Streaming response events

The controller processes the SDKMessage stream, extracting content updates and tool call information for the UI.

### Session Resumption

The SDK maintains session state that can be resumed across plugin reloads:

```mermaid
sequenceDiagram
    participant User
    participant AgentController
    participant SDK
    participant Storage

    Note over User,Storage: First conversation
    User->>AgentController: sendMessage()
    AgentController->>SDK: query({ prompt })
    SDK-->>AgentController: SDKSystemMessage with session_id
    AgentController->>Storage: Save sessionId to conversation

    Note over User,Storage: Plugin reload
    AgentController->>Storage: Load conversation
    Storage-->>AgentController: sessionId
    User->>AgentController: sendMessage()
    AgentController->>SDK: query({ resume: sessionId })
    SDK-->>AgentController: Continues with full context
```

## Extension Points

### Adding Obsidian Tools

Add new tools to `ObsidianMcpServer.ts` using the SDK's `tool()` helper:

```typescript
tool(
  "my_obsidian_tool",
  "Description of what the tool does",
  {
    param: z.string().describe("Parameter description")
  },
  async (args) => {
    // Access Obsidian APIs via `app`
    const result = await app.vault.read(/* ... */);
    return {
      content: [{ type: "text", text: result }]
    };
  }
)
```

### Adding Skills

Create a skill in `vault/.claude/skills/my-skill/`:

```
vault/.claude/skills/my-skill/
├── SKILL.md           # Skill definition and instructions
└── scripts/
    └── action.py      # Executable scripts
```

Skills are automatically loaded when `settingSources: ['project']` is set.

### Adding Slash Commands

Extend `SLASH_COMMANDS` in `AutocompletePopup.ts` and handle in `ChatInput.handleCommand()`:

```typescript
{
  type: "command",
  value: "/mycommand",
  label: "/mycommand [arg]",
  description: "Command description",
  icon: "icon-name"
}
```

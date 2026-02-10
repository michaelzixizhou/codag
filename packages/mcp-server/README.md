# Codag MCP Server

MCP server that gives coding agents (Claude Code, Cursor, etc.) instant context about LLM/AI workflows in your codebase. Instead of searching blindly, the agent queries a pre-analyzed workflow graph to find relevant files, data flow, and function relationships.

## How it works

1. The **Codag VS Code extension** analyzes your codebase and generates `.vscode/codag-graph.json`
2. This MCP server reads that graph and exposes it via the [Model Context Protocol](https://modelcontextprotocol.io/)
3. Your coding agent calls `get_task_context("your task")` to get relevant LLM workflow files before exploring

## Setup

### Prerequisites

- [Codag VS Code extension](https://marketplace.visualstudio.com/items?itemName=codag.codag) installed and run at least once on your workspace
- Node.js 18+

### Install

```bash
cd packages/mcp-server
npm install && npm run build
```

### Configure Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "codag": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

### Configure Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "codag": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js", "/absolute/path/to/workspace"]
    }
  }
}
```

### Configure other MCP clients

Run the server over stdio with:

```bash
node packages/mcp-server/dist/index.js /path/to/workspace
```

The workspace path must contain `.vscode/codag-graph.json`.

## Tools

| Tool | Description |
|------|-------------|
| `get_task_context` | Primary tool. Extracts keywords from your task description, returns relevant files, data flow, and guiding questions. |
| `search_graph` | Keyword search across workflows, nodes, and files. |
| `list_workflows` | List all workflow pipelines sorted by size. |
| `get_workflow` | Full topology of a workflow: nodes, edges, execution order. |
| `get_node` | Details of a specific node: type, source location, connections. |
| `get_file_context` | Workflow context for specific files you plan to read or modify. |

The server also exposes a `codag://graph/summary` resource that MCP clients auto-inject into the system prompt.

## Scope

This graph **only covers LLM/AI workflow code** — files containing LLM API calls and their surrounding pipeline logic. It knows nothing about utilities, configs, tests, or other infrastructure. The server explicitly tells the agent this so it still explores the full codebase.

## Benchmark

Tested on LangChain (319K LOC, 8 tasks, claude-sonnet-4-5). See [BENCHMARK.md](./BENCHMARK.md).

| Metric | No MCP | With MCP | Delta |
|--------|--------|----------|-------|
| Avg turns | 52 | 42 | -19% |
| Avg cost | $2.24 | $1.86 | -17% |
| Avg time | 749s | 361s | -52% |
| Total input tokens | 20.8M | 16.4M | -21% |
| Total output tokens | 172K | 148K | -14% |
| Quality | 86.9% | 87.6% | +0.7pp |

The agent processes 21% fewer input tokens because it navigates directly to relevant files instead of reading through the codebase blindly. The savings are largest on complex cross-cutting tasks where no-MCP agents spend 30+ minutes exploring unrelated files.

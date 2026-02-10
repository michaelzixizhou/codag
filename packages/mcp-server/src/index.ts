#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GraphLoader } from "./graph-loader.js";
import { listWorkflows, getWorkflow, getNode, getFileContext, searchGraph, getTaskContext, graphSummaryResource, wrapResult } from "./tools.js";

const workspacePath = process.argv[2];
if (!workspacePath) {
    process.stderr.write("Usage: codag-mcp <workspace-path>\n");
    process.exit(1);
}

const loader = new GraphLoader(workspacePath);

const server = new McpServer({
    name: "codag",
    version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Resources (auto-injected into system prompt by supporting clients)
// ---------------------------------------------------------------------------

server.resource(
    "graph-summary",
    "codag://graph/summary",
    { description: "Compact summary of all LLM/AI workflows in the codebase. Auto-included in context." },
    async () => ({
        contents: [{
            uri: "codag://graph/summary",
            mimeType: "text/markdown",
            text: graphSummaryResource(loader.getIndex()),
        }],
    })
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
    "get_task_context",
    "Get LLM workflow files and data flow relevant to your task. ONLY covers LLM/AI code — does not know about non-LLM files, utilities, tests, configs, or partner packages. Always explore the full codebase yourself for those.",
    {
        task_description: z.string().describe("Full description of what you need to implement or fix"),
    },
    async ({ task_description }) => ({
        content: [{ type: "text", text: wrapResult("get_task_context", getTaskContext(loader.getIndex(), task_description)) }],
    })
);

server.tool(
    "search_graph",
    "Search for specific workflows, nodes, or files by keyword. Use get_task_context first — only use this if you need to find something specific not covered by the initial context.",
    {
        query: z.string().describe("Search keywords (e.g. 'openai', 'chat model', 'retry')"),
        limit: z.number().optional().default(15).describe("Max results per category (default 15)"),
    },
    async ({ query, limit }) => ({
        content: [{ type: "text", text: wrapResult("search_graph", searchGraph(loader.getIndex(), query, limit)) }],
    })
);

server.tool(
    "list_workflows",
    "List workflow pipelines sorted by size. Use search_graph instead to find specific workflows by keyword.",
    {
        limit: z.number().optional().default(20).describe("Max workflows to return (default 20)"),
        offset: z.number().optional().default(0).describe("Skip first N workflows (for pagination)"),
    },
    async ({ limit, offset }) => ({
        content: [{ type: "text", text: wrapResult("list_workflows", listWorkflows(loader.getIndex(), limit, offset)) }],
    })
);

server.tool(
    "get_workflow",
    "Get full topology of a workflow: nodes, edges, and execution order. Use search_graph first to find the workflow name.",
    { workflow_name: z.string().describe("Workflow name or ID (fuzzy matched)") },
    async ({ workflow_name }) => ({
        content: [{ type: "text", text: wrapResult("get_workflow", getWorkflow(loader.getIndex(), workflow_name)) }],
    })
);

server.tool(
    "get_node",
    "Get details of a specific workflow node: its type, source location, workflow membership, and input/output connections.",
    { node_id: z.string().describe("Node ID (e.g. 'api.ts::analyzeWorkflow::106') or function name") },
    async ({ node_id }) => ({
        content: [{ type: "text", text: wrapResult("get_node", getNode(loader.getIndex(), node_id)) }],
    })
);

server.tool(
    "get_file_context",
    "Get workflow context for specific files you plan to read or modify. Shows which workflows they belong to, what nodes they contain, and connected files.",
    { files: z.array(z.string()).describe("File paths to look up (relative to workspace root)") },
    async ({ files }) => ({
        content: [{ type: "text", text: wrapResult("get_file_context", getFileContext(loader.getIndex(), files)) }],
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);

import { readFileSync, watch, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, WorkflowMetadata } from "./types.js";

export interface GraphIndex {
    graph: WorkflowGraph;
    nodeById: Map<string, WorkflowNode>;
    nodeToWorkflow: Map<string, WorkflowMetadata>;
    fileToNodes: Map<string, WorkflowNode[]>;
    incomingEdges: Map<string, WorkflowEdge[]>;
    outgoingEdges: Map<string, WorkflowEdge[]>;
    timestamp: number;
}

export class GraphLoader {
    private graphPath: string;
    private index: GraphIndex | null = null;
    private watcher: ReturnType<typeof watch> | null = null;

    constructor(private workspacePath: string) {
        this.graphPath = join(workspacePath, ".vscode", "codag-graph.json");
        this.load();
        this.startWatching();
    }

    private load(): void {
        if (!existsSync(this.graphPath)) {
            this.index = null;
            return;
        }

        try {
            const raw = readFileSync(this.graphPath, "utf-8");
            const graph: WorkflowGraph = JSON.parse(raw);
            graph._workspacePath = this.workspacePath;
            this.index = this.buildIndex(graph);
        } catch {
            this.index = null;
        }
    }

    private buildIndex(graph: WorkflowGraph): GraphIndex {
        const nodeById = new Map<string, WorkflowNode>();
        const nodeToWorkflow = new Map<string, WorkflowMetadata>();
        const fileToNodes = new Map<string, WorkflowNode[]>();
        const incomingEdges = new Map<string, WorkflowEdge[]>();
        const outgoingEdges = new Map<string, WorkflowEdge[]>();

        for (const node of graph.nodes) {
            nodeById.set(node.id, node);
            if (node.source?.file) {
                const file = node.source.file;
                if (!fileToNodes.has(file)) fileToNodes.set(file, []);
                fileToNodes.get(file)!.push(node);
            }
        }

        for (const wf of graph.workflows) {
            for (const nodeId of wf.nodeIds) {
                nodeToWorkflow.set(nodeId, wf);
            }
        }

        for (const edge of graph.edges) {
            if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
            outgoingEdges.get(edge.source)!.push(edge);
            if (!incomingEdges.has(edge.target)) incomingEdges.set(edge.target, []);
            incomingEdges.get(edge.target)!.push(edge);
        }

        let timestamp: number;
        try {
            timestamp = statSync(this.graphPath).mtimeMs;
        } catch {
            timestamp = Date.now();
        }

        return { graph, nodeById, nodeToWorkflow, fileToNodes, incomingEdges, outgoingEdges, timestamp };
    }

    private startWatching(): void {
        try {
            // Watch the .vscode directory since the file may not exist yet
            const dir = join(this.workspacePath, ".vscode");
            if (!existsSync(dir)) return;

            this.watcher = watch(dir, (_, filename) => {
                if (filename === "codag-graph.json") {
                    this.load();
                }
            });
            this.watcher.unref(); // Don't keep process alive
        } catch {
            // Watch may fail on some platforms, non-fatal
        }
    }

    getIndex(): GraphIndex | null {
        return this.index;
    }

    close(): void {
        this.watcher?.close();
    }
}

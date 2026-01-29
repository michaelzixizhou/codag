import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import {
    SourceLocation,
    WorkflowNode,
    WorkflowEdge,
    WorkflowMetadata,
    WorkflowGraph,
    LocationMetadata,
    FileMetadata,
    AnalyzeResult,
    FileStructureContext,
    MetadataBundle,
    TokenUsage,
    CostData
} from './types';

// Re-export types for backwards compatibility
export {
    SourceLocation,
    WorkflowNode,
    WorkflowEdge,
    WorkflowMetadata,
    WorkflowGraph,
    LocationMetadata,
    FileMetadata,
    AnalyzeResult,
    FileStructureContext,
    MetadataBundle,
    TokenUsage,
    CostData
};

export class APIClient {
    private client: AxiosInstance;
    private outputChannel: vscode.OutputChannel;
    private baseURL: string;

    constructor(baseURL: string, outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.baseURL = baseURL;
        this.client = axios.create({
            baseURL,
            timeout: 0 // No timeout - analysis can take a while
        });

        this.client.interceptors.request.use(config => {
            this.outputChannel.appendLine(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
            return config;
        });

        this.client.interceptors.response.use(
            response => {
                this.outputChannel.appendLine(`API Response: ${response.status} ${response.config.url}`);
                return response;
            },
            error => {
                this.outputChannel.appendLine(`API Error: ${error.message}`);
                if (error.response) {
                    this.outputChannel.appendLine(`Status: ${error.response.status}`);
                    this.outputChannel.appendLine(`Data: ${JSON.stringify(error.response.data)}`);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * Check if the backend is reachable.
     * Uses a short timeout so it fails fast.
     */
    async checkHealth(): Promise<boolean> {
        try {
            await axios.get(`${this.baseURL}/health`, { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Analyze workflow code.
     * Returns graph data.
     * @param condensedStructure Optional condensed repo structure for cross-batch context
     */
    async analyzeWorkflow(
        code: string,
        filePaths: string[],
        frameworkHint?: string,
        metadata?: FileMetadata[],
        condensedStructure?: string,
        httpConnections?: string
    ): Promise<AnalyzeResult> {
        // If condensed structure provided, prepend it to the code
        let codeWithContext = code;
        if (condensedStructure) {
            codeWithContext = `<workflow_context>\n${condensedStructure}\n</workflow_context>\n\n${code}`;
        }

        const res = await this.client.post('/analyze', {
            code: codeWithContext,
            file_paths: filePaths,
            framework_hint: frameworkHint,
            metadata: metadata || [],
            http_connections: httpConnections
        });

        // Backend returns { graph, usage, cost }
        return {
            graph: res.data.graph,
            usage: res.data.usage as TokenUsage | undefined,
            cost: res.data.cost as CostData | undefined
        };
    }

    /**
     * Fetch metadata (labels, descriptions) for functions.
     * Lightweight endpoint for incremental updates - only needs structure, not full analysis.
     */
    async analyzeMetadataOnly(
        files: FileStructureContext[],
        code?: string
    ): Promise<{
        files: MetadataBundle['files'];
        usage?: TokenUsage;
        cost?: CostData;
    }> {
        const res = await this.client.post('/analyze/metadata-only', {
            files,
            code
        });
        return {
            files: res.data.files,
            usage: res.data.usage as TokenUsage | undefined,
            cost: res.data.cost as CostData | undefined
        };
    }

    /**
     * Condense raw repo structure into workflow-relevant summary.
     * Uses LLM to filter out irrelevant files and identify workflow entry points.
     */
    async condenseStructure(rawStructure: string): Promise<{
        condensed_structure: string;
        usage?: TokenUsage;
        cost?: CostData;
    }> {
        const res = await this.client.post('/condense-structure', {
            raw_structure: rawStructure
        });
        return {
            condensed_structure: res.data.condensed_structure,
            usage: res.data.usage as TokenUsage | undefined,
            cost: res.data.cost as CostData | undefined
        };
    }
}

import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';

export interface SourceLocation {
    file: string;
    line: number;
    function: string;
}

export interface WorkflowNode {
    id: string;
    label: string;
    description?: string;
    type: string;
    source?: SourceLocation;
    metadata?: any;
    isEntryPoint?: boolean;
    isExitPoint?: boolean;
    isCriticalPath?: boolean;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;
    isCriticalPath?: boolean;
}

export interface LocationMetadata {
    line: number;
    type: string;
    description: string;
    function: string;
    variable?: string;
}

export interface FileMetadata {
    file: string;
    locations: LocationMetadata[];
    relatedFiles: string[];
}

export interface WorkflowGraph {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    llms_detected: string[];
}

export class APIClient {
    private client: AxiosInstance;
    private token: string | null = null;
    private outputChannel: vscode.OutputChannel;

    constructor(baseURL: string, outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.client = axios.create({ baseURL });

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

    setToken(token: string) {
        this.token = token;
        this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    }

    clearToken() {
        this.token = null;
        delete this.client.defaults.headers.common['Authorization'];
    }

    async register(email: string, password: string) {
        const res = await this.client.post('/auth/register', { email, password });
        return res.data.access_token;
    }

    async login(email: string, password: string) {
        const res = await this.client.post('/auth/login', { email, password });
        return res.data.access_token;
    }

    async getUser() {
        const res = await this.client.get('/auth/me');
        return res.data;
    }

    async analyzeWorkflow(code: string, filePaths: string[], frameworkHint?: string, metadata?: FileMetadata[]): Promise<WorkflowGraph> {
        const res = await this.client.post('/analyze', {
            code,
            file_paths: filePaths,
            framework_hint: frameworkHint,
            metadata: metadata || []
        });
        return res.data;
    }
}

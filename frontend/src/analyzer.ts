import * as vscode from 'vscode';
import * as path from 'path';
import { staticAnalyzer } from './static-analyzer';

export class WorkflowDetector {
    // LLM Client Detection Patterns
    private static readonly LLM_CLIENT_PATTERNS = [
        // OpenAI
        /from\s+openai\s+import|import\s+.*OpenAI|new\s+OpenAI\s*\(/,
        /import\s+.*from\s+['"]openai['"]/,

        // Anthropic
        /from\s+anthropic\s+import|import\s+.*Anthropic|new\s+Anthropic\s*\(/,
        /import\s+.*from\s+['"]@anthropic-ai\/sdk['"]/,

        // Google Gemini
        /import\s+google\.generativeai|genai\.configure|genai\.GenerativeModel/,
        /from\s+['"]@google\/generative-ai['"]/,
        /GoogleGenerativeAI/,

        // Groq
        /from\s+groq\s+import|import\s+.*Groq|new\s+Groq\s*\(/,
        /import\s+.*from\s+['"]groq-sdk['"]/,

        // Ollama
        /from\s+ollama\s+import|import\s+.*ollama/,
        /import\s+.*from\s+['"]ollama['"]/,

        // Cohere
        /import\s+cohere|cohere\.Client/,
        /from\s+['"]cohere-ai['"]/,

        // Hugging Face
        /from\s+huggingface_hub\s+import|InferenceClient/,
        /from\s+['"]@huggingface\/inference['"]/,
    ];

    // LLM API Call Patterns
    private static readonly LLM_CALL_PATTERNS = [
        /\.chat\.completions\.create/,
        /\.completions\.create/,
        /\.messages\.create/,
        /\.generate_content/,
        /\.generateContent/,
        /\.chat\(/,
        /\.generate\(/,
    ];

    // Tool/Function Patterns
    private static readonly TOOL_PATTERNS = [
        /tools\s*[:=]/,
        /tool_choice\s*[:=]/,
        /@tool\s*\(/,
        /tool_use/,
        /function_call/,
    ];

    // Streaming Patterns
    private static readonly STREAMING_PATTERNS = [
        /stream\s*[:=]\s*[Tt]rue/,
        /\.stream\s*\(/,
        /for\s+.*\s+in\s+.*stream/,
        /for\s+await.*stream/,
    ];

    // Workflow Keywords (data structures, types, classes)
    private static readonly WORKFLOW_KEYWORDS = [
        /WorkflowGraph|AnalyzeRequest|FileMetadata|LocationMetadata/,
        /WorkflowDetector|StaticAnalyzer|MetadataBuilder/,
        /analyze_workflow|analyzeWorkflow/,
        /gemini_client|GeminiClient/,
        /WebviewManager|CacheManager|APIClient/,
        /CodeLocation|FileAnalysis/,
    ];

    // Workflow Filenames
    private static readonly WORKFLOW_FILENAMES = [
        /analyzer\.(py|ts|js)/,
        /workflow\.(py|ts|js)/,
        /gemini[_-]?client\.(py|ts|js)/,
        /api\.(py|ts|js)/,
        /extension\.ts/,
        /webview\.(py|ts|js)/,
        /cache\.(py|ts|js)/,
        /main\.py/,
        /models\.(py|ts|js)/,
    ];

    // Framework Patterns (keep for framework-specific detection)
    private static readonly FRAMEWORK_PATTERNS = {
        langgraph: [
            /from\s+langgraph/,
            /import\s+.*from\s+['"]@langchain\/langgraph['"]/,
            /StateGraph|MessageGraph/,
        ],
        mastra: [
            /from\s+mastra/,
            /import\s+.*from\s+['"]mastra['"]/,
            /@mastra\//,
        ],
        langchain: [
            /from\s+langchain/,
            /import\s+.*from\s+['"]@langchain/,
            /LLMChain|SequentialChain/,
        ],
        crewai: [
            /from\s+crewai/,
            /import\s+.*from\s+['"]crewai['"]/,
            /Crew\s*\(/,
        ]
    };

    private static readonly FILE_EXTENSIONS = ['.py', '.ts', '.js', '.tsx', '.jsx'];

    private static async buildExcludePattern(workspaceUri: vscode.Uri): Promise<string> {
        const patterns: string[] = [];

        // Common patterns (node_modules, build outputs, virtual environments)
        const commonExcludes = [
            '**/node_modules/**',
            '**/out/**',
            '**/dist/**',
            '**/build/**',
            '**/.next/**',           // Next.js build output
            '**/.nuxt/**',           // Nuxt build output
            '**/.vitepress/**',      // VitePress build
            '**/.docusaurus/**',     // Docusaurus build
            '**/.svelte-kit/**',     // SvelteKit build
            '**/.cache/**',          // General cache
            '**/coverage/**',        // Test coverage
            '**/.vscode-test/**',
            '**/venv/**',
            '**/.venv/**',
            '**/env/**',
            '**/__pycache__/**',
            '**/.ruff_cache/**'
        ];
        patterns.push(...commonExcludes);

        // Find all .gitignore files in the workspace
        try {
            const gitignoreFiles = await vscode.workspace.findFiles('**/.gitignore', null, 100);

            for (const gitignoreUri of gitignoreFiles) {
                try {
                    const content = await vscode.workspace.fs.readFile(gitignoreUri);
                    const text = Buffer.from(content).toString('utf8');

                    // Get the directory containing this .gitignore
                    const gitignoreDir = path.dirname(gitignoreUri.fsPath);
                    const workspaceDir = workspaceUri.fsPath;
                    const relativePath = path.relative(workspaceDir, gitignoreDir);

                    const lines = text.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        // Skip empty lines and comments
                        if (!trimmed || trimmed.startsWith('#')) continue;

                        // Skip malformed patterns with commas (these are not valid gitignore syntax)
                        // Example: "*.py,cover" should be two lines: "*.py" and "cover"
                        if (trimmed.includes(',') && !trimmed.startsWith('!')) {
                            continue;
                        }

                        // Convert gitignore pattern to glob pattern
                        let pattern = trimmed;

                        // If .gitignore is in a subdirectory, prefix patterns appropriately
                        const prefix = relativePath && relativePath !== '.' ? `${relativePath}/` : '';

                        // Handle directory patterns (ending with /)
                        if (pattern.endsWith('/')) {
                            pattern = pattern.slice(0, -1);
                            if (pattern.startsWith('/')) {
                                // Absolute path from this .gitignore's directory
                                pattern = `${prefix}${pattern.slice(1)}/**`;
                            } else {
                                // Relative pattern - match anywhere under this directory
                                pattern = `${prefix}**/${pattern}/**`;
                            }
                        }
                        // Handle specific file patterns
                        else if (pattern.startsWith('*.')) {
                            pattern = `${prefix}**/${pattern}`;
                        }
                        // Handle absolute paths from this .gitignore
                        else if (pattern.startsWith('/')) {
                            pattern = `${prefix}${pattern.slice(1)}`;
                            if (!pattern.endsWith('/**')) {
                                pattern = `${pattern}/**`;
                            }
                        }
                        // Handle paths with subdirectories
                        else if (pattern.includes('/')) {
                            if (!pattern.startsWith('**/')) {
                                pattern = `${prefix}**/${pattern}`;
                            }
                            if (!pattern.endsWith('/**')) {
                                pattern = `${pattern}/**`;
                            }
                        }
                        // Handle simple directory/file names
                        else {
                            // ONLY add ** prefix, don't add /** suffix for simple names
                            // This prevents matching file extensions
                            pattern = `${prefix}**/${pattern}`;
                        }

                        patterns.push(pattern);
                    }
                } catch (err) {
                    console.warn(`Could not read .gitignore at ${gitignoreUri.fsPath}:`, err);
                }
            }
        } catch (error) {
            console.warn('Could not find .gitignore files:', error);
        }

        return `{${patterns.join(',')}}`;
    }

    static async detectInWorkspace(): Promise<vscode.Uri[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const files: vscode.Uri[] = [];

        // Build exclusion pattern from .gitignore + common patterns
        const excludePattern = await this.buildExcludePattern(workspaceFolders[0].uri);

        for (const ext of this.FILE_EXTENSIONS) {
            const found = await vscode.workspace.findFiles(
                `**/*${ext}`,
                excludePattern,
                10000  // Increased limit to handle large repositories
            );
            files.push(...found);
        }

        const workflowFiles: vscode.Uri[] = [];

        for (const file of files) {
            const content = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(content).toString('utf8');

            if (this.detectWorkflow(text, file.fsPath)) {
                workflowFiles.push(file);
            }
        }

        // Sort for deterministic results
        workflowFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        return workflowFiles;
    }

    static detectWorkflow(content: string, filePath?: string): boolean {
        // Multi-pass detection: AST → Direct LLM → Keywords → Filename

        // Pass 1: AST-based detection (most accurate)
        if (filePath) {
            try {
                const analysis = staticAnalyzer.analyze(content, filePath);
                // File is a workflow if it has any LLM-related locations
                if (analysis.locations.length > 0) {
                    return true;
                }
                // Or if it has LLM-related variables
                if (analysis.llmRelatedVariables.size > 0) {
                    return true;
                }
            } catch (error) {
                // Fall back to regex if AST parsing fails
                console.warn('AST parsing failed, falling back to regex:', error);
            }
        }

        // Pass 2: Direct LLM usage detection
        const hasLLMClient = this.LLM_CLIENT_PATTERNS.some(pattern => pattern.test(content));
        const hasLLMCalls = this.LLM_CALL_PATTERNS.some(pattern => pattern.test(content));
        const hasFramework = Object.values(this.FRAMEWORK_PATTERNS).some(patterns =>
            patterns.some(pattern => pattern.test(content))
        );

        if ((hasLLMClient && hasLLMCalls) || hasFramework) {
            return true;
        }

        // Pass 3: Workflow data structures and keywords
        const hasWorkflowKeywords = this.WORKFLOW_KEYWORDS.some(pattern => pattern.test(content));
        if (hasWorkflowKeywords) {
            return true;
        }

        // Pass 4: Workflow-related filename
        if (filePath) {
            const filename = filePath.split('/').pop() || '';
            const hasWorkflowFilename = this.WORKFLOW_FILENAMES.some(pattern => pattern.test(filename));
            if (hasWorkflowFilename) {
                return true;
            }
        }

        return false;
    }

    static detectFramework(content: string): string | null {
        // Check for LLM clients FIRST (more specific)
        if (this.LLM_CLIENT_PATTERNS[0].test(content) || this.LLM_CLIENT_PATTERNS[1].test(content)) return 'openai';
        if (this.LLM_CLIENT_PATTERNS[2].test(content) || this.LLM_CLIENT_PATTERNS[3].test(content)) return 'anthropic';
        if (this.LLM_CLIENT_PATTERNS[4].test(content) || this.LLM_CLIENT_PATTERNS[5].test(content) || this.LLM_CLIENT_PATTERNS[6].test(content)) return 'gemini';
        if (this.LLM_CLIENT_PATTERNS[7].test(content) || this.LLM_CLIENT_PATTERNS[8].test(content)) return 'groq';
        if (this.LLM_CLIENT_PATTERNS[9].test(content) || this.LLM_CLIENT_PATTERNS[10].test(content)) return 'ollama';
        if (this.LLM_CLIENT_PATTERNS[11].test(content) || this.LLM_CLIENT_PATTERNS[12].test(content)) return 'cohere';
        if (this.LLM_CLIENT_PATTERNS[13].test(content) || this.LLM_CLIENT_PATTERNS[14].test(content)) return 'huggingface';

        // Then check for specific frameworks (less specific, might have false positives)
        for (const [framework, patterns] of Object.entries(this.FRAMEWORK_PATTERNS)) {
            if (patterns.some(pattern => pattern.test(content))) {
                return framework;
            }
        }

        // Check if it has any LLM patterns
        if (this.detectWorkflow(content)) {
            return 'generic-llm';
        }

        return null;
    }

    static isWorkflowFile(uri: vscode.Uri): boolean {
        const ext = path.extname(uri.fsPath);
        return this.FILE_EXTENSIONS.includes(ext);
    }
}

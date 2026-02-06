/**
 * LLM Provider Definitions
 *
 * Single source of truth for all LLM provider detection patterns.
 * To add a new provider, add an entry to LLM_PROVIDERS array.
 * To add a new framework, add an entry to LLM_FRAMEWORKS array.
 *
 * Design:
 * - Each provider has identifiers (simple strings) and patterns (regex)
 * - Patterns are language-agnostic where possible
 * - Derived exports flatten patterns for different use cases
 */

// =============================================================================
// Types
// =============================================================================

export interface LLMProvider {
    /** Unique identifier (lowercase) */
    id: string;
    /** Display name for UI */
    displayName: string;
    /** Simple strings to match in text/imports (lowercase) */
    identifiers: string[];
    /** Regex patterns for detecting SDK imports */
    importPatterns: RegExp[];
    /** Regex patterns for detecting API calls (optional - some providers use generic methods) */
    callPatterns?: RegExp[];
}

export interface LLMFramework {
    /** Unique identifier (lowercase) */
    id: string;
    /** Display name for UI */
    displayName: string;
    /** Simple strings to match in text/imports (lowercase) */
    identifiers: string[];
    /** Regex patterns for detecting framework imports */
    importPatterns: RegExp[];
}

// =============================================================================
// Provider Definitions
// =============================================================================

export const LLM_PROVIDERS: LLMProvider[] = [
    // -------------------------------------------------------------------------
    // Major Cloud Providers
    // -------------------------------------------------------------------------
    {
        id: 'openai',
        displayName: 'OpenAI',
        identifiers: ['openai'],
        importPatterns: [
            /from\s+openai\s+import/i,
            /import\s+.*OpenAI/i,
            /new\s+OpenAI\s*\(/,
            /import\s+.*from\s+['"]openai['"]/,
        ],
        callPatterns: [
            /\.chat\.completions\.create/,
            /\.completions\.create/,
        ],
    },
    {
        id: 'anthropic',
        displayName: 'Anthropic',
        identifiers: ['anthropic', 'claude'],
        importPatterns: [
            /from\s+anthropic\s+import/i,
            /import\s+.*Anthropic/i,
            /new\s+Anthropic\s*\(/,
            /import\s+.*from\s+['"]@anthropic-ai\/sdk['"]/,
        ],
        callPatterns: [
            /\.messages\.create/,
        ],
    },
    {
        id: 'gemini',
        displayName: 'Google Gemini',
        identifiers: ['gemini', 'genai', 'generativeai'],
        importPatterns: [
            /import\s+google\.generativeai/i,
            /from\s+google\s+import\s+genai/i,
            /genai\.configure/,
            /genai\.Client/,
            /genai\.GenerativeModel/,
            /GoogleGenerativeAI/,
            /from\s+['"]@google\/generative-ai['"]/,
        ],
        callPatterns: [
            /\.generate_content/,
            /\.generateContent/,
        ],
    },
    {
        id: 'azure-openai',
        displayName: 'Azure OpenAI',
        identifiers: ['azure'],
        importPatterns: [
            /AzureOpenAI/,
            /azure\.ai\.openai/i,
            /import\s+.*from\s+['"]@azure\/openai['"]/,
        ],
    },
    {
        id: 'vertex-ai',
        displayName: 'Vertex AI',
        identifiers: ['vertexai', 'aiplatform'],
        importPatterns: [
            /google\.cloud\.aiplatform/i,
            /from\s+vertexai/i,
            /import\s+vertexai/i,
            /import\s+.*from\s+['"]@google-cloud\/vertexai['"]/,
        ],
    },
    {
        id: 'bedrock',
        displayName: 'AWS Bedrock',
        identifiers: ['bedrock'],
        importPatterns: [
            /bedrock-runtime/i,
            /InvokeModel/,
            /BedrockRuntimeClient/,
            /import\s+.*from\s+['"]@aws-sdk\/client-bedrock['"]/,
        ],
    },

    // -------------------------------------------------------------------------
    // Standalone Providers
    // -------------------------------------------------------------------------
    {
        id: 'mistral',
        displayName: 'Mistral AI',
        identifiers: ['mistral', 'mistralai'],
        importPatterns: [
            /from\s+mistralai\s+import/i,
            /MistralClient/,
            /Mistral\s*\(/,
            /import\s+.*from\s+['"]@mistralai\/mistralai['"]/,
        ],
    },
    {
        id: 'xai',
        displayName: 'xAI (Grok)',
        identifiers: ['xai', 'grok'],
        importPatterns: [
            /from\s+xai\s+import/i,
            /import\s+xai/i,
            /import\s+.*from\s+['"]xai['"]/,
            /api\.x\.ai/i,
            /xai\.com/i,
            /XAI_API/i,
            /GROK_API/i,
        ],
    },
    {
        id: 'cohere',
        displayName: 'Cohere',
        identifiers: ['cohere'],
        importPatterns: [
            /import\s+cohere/i,
            /cohere\.Client/,
            /from\s+['"]cohere-ai['"]/,
        ],
    },
    {
        id: 'ollama',
        displayName: 'Ollama',
        identifiers: ['ollama'],
        importPatterns: [
            /from\s+ollama\s+import/i,
            /import\s+.*ollama/i,
            /import\s+.*from\s+['"]ollama['"]/,
        ],
    },
    {
        id: 'together',
        displayName: 'Together AI',
        identifiers: ['together'],
        importPatterns: [
            /from\s+together\s+import/i,
            /Together\s*\(/,
            /import\s+.*from\s+['"]together-ai['"]/,
        ],
    },
    {
        id: 'replicate',
        displayName: 'Replicate',
        identifiers: ['replicate'],
        importPatterns: [
            /import\s+replicate/i,
            /from\s+replicate\s+import/i,
            /replicate\.run/,
            /import\s+.*from\s+['"]replicate['"]/,
        ],
    },
    {
        id: 'fireworks',
        displayName: 'Fireworks AI',
        identifiers: ['fireworks'],
        importPatterns: [
            /from\s+fireworks\s+import/i,
            /fireworks\.client/i,
            /import\s+.*from\s+['"]fireworks-ai['"]/,
        ],
    },
    {
        id: 'ai21',
        displayName: 'AI21 Labs',
        identifiers: ['ai21'],
        importPatterns: [
            /from\s+ai21\s+import/i,
            /AI21Client/,
            /import\s+ai21/i,
            /import\s+.*from\s+['"]ai21['"]/,
        ],
    },
    {
        id: 'deepseek',
        displayName: 'DeepSeek',
        identifiers: ['deepseek'],
        importPatterns: [
            /api\.deepseek\.com/i,
            /DEEPSEEK_API/i,
        ],
    },
    {
        id: 'openrouter',
        displayName: 'OpenRouter',
        identifiers: ['openrouter'],
        importPatterns: [
            /openrouter\.ai/i,
            /OPENROUTER_API/i,
        ],
    },
    {
        id: 'groq',
        displayName: 'Groq',
        identifiers: ['groq'],
        importPatterns: [
            /from\s+groq\s+import/i,
            /import\s+.*Groq/i,
            /import\s+.*from\s+['"]groq['"]/,
        ],
    },
    {
        id: 'huggingface',
        displayName: 'Hugging Face',
        identifiers: ['huggingface', 'huggingface_hub'],
        importPatterns: [
            /from\s+huggingface_hub\s+import/i,
            /InferenceClient/,
            /import\s+.*from\s+['"]@huggingface\/inference['"]/,
        ],
    },

    // -------------------------------------------------------------------------
    // Local/Quantized Model Providers
    // -------------------------------------------------------------------------
    {
        id: 'llama-cpp',
        displayName: 'llama.cpp / GGUF',
        identifiers: ['llama_cpp', 'llama-cpp', 'llama.cpp', 'gguf', 'ggml', 'ctransformers'],
        importPatterns: [
            // Python: llama-cpp-python
            /from\s+llama_cpp\s+import/i,
            /import\s+llama_cpp/i,
            /from\s+llama_cpp\b/i,
            // Python: ctransformers (GGML/GGUF)
            /from\s+ctransformers\s+import/i,
            /import\s+ctransformers/i,
            // Python: gguf package (reader/writer/converter)
            /from\s+gguf\s+import/i,
            /import\s+gguf/i,
            // JS/TS: node-llama-cpp
            /import\s+.*from\s+['"]node-llama-cpp['"]/,
            /require\s*\(\s*['"]node-llama-cpp['"]\s*\)/,
            // LangChain integration
            /from\s+langchain.*import\s+LlamaCpp/i,
            /from\s+langchain_community.*import\s+LlamaCpp/i,
            // LlamaIndex integration
            /from\s+llama_index.*LlamaCPP/i,
        ],
        callPatterns: [
            // llama-cpp-python
            /Llama\s*\(\s*model_path/,
            /Llama\s*\(\s*['"]/,
            /\.create_completion\s*\(/,
            /\.create_chat_completion\s*\(/,
            /\.create_embedding\s*\(/,
            // ctransformers
            /AutoModelForCausalLM\.from_pretrained/,
            // gguf tools
            /GGUFReader\s*\(/,
            /GGUFWriter\s*\(/,
            // node-llama-cpp
            /getLlama\s*\(/,
            /\.loadModel\s*\(/,
            /LlamaChatSession\s*\(/,
            /new\s+LlamaChatSession\s*\(/,
            // GGUF file reference (model loading)
            /['"][\w\-\/\\.]+\.gguf['"]/i,
        ],
    },

    // -------------------------------------------------------------------------
    // MCP (Model Context Protocol) Servers
    // -------------------------------------------------------------------------
    {
        id: 'mcp',
        displayName: 'MCP Server',
        identifiers: ['modelcontextprotocol', 'fastmcp', 'mcp-server', 'mcpserver', 'mcp', 'mcp-go', 'rmcp', 'mcp_server'],
        importPatterns: [
            // JS/TS: Official MCP SDK (matches any subpath like /server/mcp.js)
            /import\s+.*from\s+['"]@modelcontextprotocol\/sdk/,
            /require\s*\(\s*['"]@modelcontextprotocol\/sdk/,
            // JS/TS: Community FastMCP npm package
            /import\s+.*from\s+['"]fastmcp['"]/,
            /require\s*\(\s*['"]fastmcp['"]\s*\)/,
            // Python: Official MCP SDK (high-level, lowlevel, and deep submodules)
            /from\s+mcp\.server\s+import/i,
            /from\s+mcp\.server\./i,
            /from\s+mcp\s+import/i,
            /import\s+mcp\.server/i,
            /import\s+mcp\b/i,
            // Python: FastMCP standalone package
            /from\s+fastmcp\s+import/i,
            /import\s+fastmcp/i,
            // Go: MCP SDK packages
            /["']github\.com\/mark3labs\/mcp-go/,
            /["']github\.com\/modelcontextprotocol\/go-sdk/,
            // Rust: MCP crates
            /use\s+rmcp\b/,
            /use\s+mcp_server\b/,
            /use\s+mcp_sdk\b/,
            // C++: MCP headers and namespace
            /#include\s+["<]mcp_server\.h[">]/,
            /#include\s+["<]mcp_tool\.h[">]/,
            /mcp::server/,
        ],
        callPatterns: [
            // Server instantiation
            /new\s+McpServer\s*\(/,
            /McpServer\s*\(/,
            /MCPServer\s*\(/,
            /FastMCP\s*\(/,
            // Tool/resource/prompt registration (high-level: .tool(), community: .addTool(), Go: .AddTool())
            /\.tool\s*\(/,
            /\.resource\s*\(/,
            /\.prompt\s*\(/,
            /\.addTool\s*\(/,
            /\.addResource\s*\(/,
            /\.addPrompt\s*\(/,
            /\.AddTool\s*\(/,
            /\.AddResource\s*\(/,
            /\.AddPrompt\s*\(/,
            // Go: server/mcp constructors
            /NewMCPServer\s*\(/,
            /mcp\.NewTool\s*\(/,
            /mcp\.NewResource\s*\(/,
            // Python decorators (high-level: @mcp.tool, lowlevel: @app.call_tool, @server.list_prompts)
            /@\w+\.tool\b/,
            /@\w+\.resource\b/,
            /@\w+\.prompt\b/,
            /@\w+\.call_tool\b/,
            /@\w+\.list_tools\b/,
            /@\w+\.list_prompts\b/,
            /@\w+\.get_prompt\b/,
            /@\w+\.list_resources\b/,
            /@\w+\.read_resource\b/,
            // C++: registration and builder patterns
            /register_tool\s*\(/,
            /register_resource\s*\(/,
            /tool_builder\s*\(/,
            // Rust: rmcp serve pattern
            /\.serve\s*\(\s*transport/,
            // Transport setup
            /StdioServerTransport/,
            /SseServerTransport/i,
            // Server lifecycle
            /server\.connect\s*\(/,
        ],
    },

    // -------------------------------------------------------------------------
    // IDE/Editor LLM APIs
    // -------------------------------------------------------------------------
    {
        id: 'vscode-lm',
        displayName: 'VS Code Language Model',
        identifiers: ['vscode.lm', 'languagemodel', 'chatmodel'],
        importPatterns: [
            /vscode\.lm/,
            /selectChatModels/,
            /LanguageModelChat/,
            /LanguageModelChatMessage/,
        ],
        callPatterns: [
            /\.sendRequest\s*\(/,
            /vscode\.lm\.invokeTool/,
            /vscode\.lm\.selectChatModels/,
        ],
    },
];

// =============================================================================
// Framework Definitions
// =============================================================================

export const LLM_FRAMEWORKS: LLMFramework[] = [
    {
        id: 'langchain',
        displayName: 'LangChain',
        identifiers: ['langchain'],
        importPatterns: [
            /from\s+langchain/i,
            /import\s+.*from\s+['"]@langchain/,
            /LLMChain/,
            /SequentialChain/,
        ],
    },
    {
        id: 'langgraph',
        displayName: 'LangGraph',
        identifiers: ['langgraph'],
        importPatterns: [
            /from\s+langgraph/i,
            /import\s+.*from\s+['"]@langchain\/langgraph['"]/,
            /StateGraph/,
            /MessageGraph/,
        ],
    },
    {
        id: 'mastra',
        displayName: 'Mastra',
        identifiers: ['mastra'],
        importPatterns: [
            /from\s+mastra/i,
            /import\s+.*from\s+['"]mastra['"]/,
            /@mastra\//,
        ],
    },
    {
        id: 'crewai',
        displayName: 'CrewAI',
        identifiers: ['crewai'],
        importPatterns: [
            /from\s+crewai/i,
            /import\s+.*from\s+['"]crewai['"]/,
            /Crew\s*\(/,
        ],
    },
    {
        id: 'llamaindex',
        displayName: 'LlamaIndex',
        identifiers: ['llama_index', 'llamaindex'],
        importPatterns: [
            /from\s+llama_index/i,
            /import\s+.*from\s+['"]llamaindex['"]/,
            /import\s+.*from\s+['"]@llama-index/,
        ],
    },
    {
        id: 'autogen',
        displayName: 'AutoGen',
        identifiers: ['autogen', 'pyautogen'],
        importPatterns: [
            /from\s+autogen/i,
            /import\s+.*from\s+['"]autogen['"]/,
            /from\s+pyautogen/i,
        ],
    },
    {
        id: 'haystack',
        displayName: 'Haystack',
        identifiers: ['haystack'],
        importPatterns: [
            /from\s+haystack/i,
            /import\s+.*from\s+['"]@deepset-ai\/haystack['"]/,
        ],
    },
    {
        id: 'semantic-kernel',
        displayName: 'Semantic Kernel',
        identifiers: ['semantic_kernel'],
        importPatterns: [
            /from\s+semantic_kernel/i,
            /import\s+.*from\s+['"]@microsoft\/semantic-kernel['"]/,
        ],
    },
    {
        id: 'pydantic-ai',
        displayName: 'Pydantic AI',
        identifiers: ['pydantic_ai'],
        importPatterns: [
            /from\s+pydantic_ai/i,
            /import\s+.*from\s+['"]pydantic-ai['"]/,
        ],
    },
    {
        id: 'instructor',
        displayName: 'Instructor',
        identifiers: ['instructor'],
        importPatterns: [
            /import\s+instructor/i,
            /from\s+instructor\s+import/i,
        ],
    },
];

// =============================================================================
// AI Service Domains (Voice, Video, Image generation)
// =============================================================================

export const AI_SERVICE_DOMAINS: RegExp[] = [
    // Voice/TTS
    /api\.elevenlabs\.io/i,
    /api\.resemble\.ai/i,
    /api\.play\.ht/i,
    // Video generation
    /api\.(dev\.)?runwayml\.com/i,
    /api\.stability\.ai/i,
    /api\.pika\.art/i,
    // Lip sync/Face
    /api\.sync\.so/i,
    /api\.d-id\.com/i,
    /api\.heygen\.com/i,
    // Image generation
    /api\.leonardo\.ai/i,
    /api\.ideogram\.ai/i,
];

export const AI_ENDPOINT_PATTERNS: RegExp[] = [
    /speech-to-speech|text-to-speech|voice[_-]?clone|\/tts\b/i,
    /image[_-]to[_-]video|video[_-]gen|act[_-]?two/i,
    /lipsync|lip[_-]sync/i,
    /\/v\d+\/generate(?:\/|$)/i,
];

// =============================================================================
// Generic LLM Call Patterns (not provider-specific)
// =============================================================================

export const GENERIC_LLM_CALL_PATTERNS: RegExp[] = [
    /\.chat\s*\(/,
    /\.chats\s*\(/,         // Swift OpenAI SDK: openAI.chats(query:)
    /\.complete\s*\(/,
    /\.generate\s*\(/,
    /ChatCompletion/,        // Go/Java/Python old SDK: CreateChatCompletion, createChatCompletion, ChatCompletion.create
    /\.embeddings\s*\(/,     // Embedding APIs: client.embeddings(), openai.embeddings.create()
];

// =============================================================================
// Derived Exports (flattened for convenience)
// =============================================================================

/** All provider identifiers (lowercase strings for quick text search) */
export const ALL_PROVIDER_IDENTIFIERS: string[] = [
    ...LLM_PROVIDERS.flatMap(p => p.identifiers),
    ...LLM_FRAMEWORKS.flatMap(f => f.identifiers),
];

/** All import patterns (for detecting LLM SDK imports) */
export const ALL_IMPORT_PATTERNS: RegExp[] = [
    ...LLM_PROVIDERS.flatMap(p => p.importPatterns),
    ...LLM_FRAMEWORKS.flatMap(f => f.importPatterns),
];

/** All API call patterns (provider-specific + generic) */
export const ALL_CALL_PATTERNS: RegExp[] = [
    ...LLM_PROVIDERS.flatMap(p => p.callPatterns || []),
    ...GENERIC_LLM_CALL_PATTERNS,
];

/** Simple regex patterns for quick file content scanning */
export const QUICK_SCAN_PATTERNS: RegExp[] = [
    // Provider/framework names (word boundaries to reduce false positives)
    ...ALL_PROVIDER_IDENTIFIERS.map(id => new RegExp(`\\b${id}\\b`, 'i')),
    // Model identifiers
    /gpt-?[34o]/i,
    /GenerativeModel/i,
    /ChatModel/i,
    /LanguageModel/i,
    /ChatCompletion/i,
    // Generic LLM term
    /\bllm\b/i,
    // GGUF model files
    /\.gguf\b/i,
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Identify which LLM provider is being used from an import statement or text.
 * Returns the provider ID or null if not recognized.
 */
export function identifyProvider(text: string): string | null {
    const lowerText = text.toLowerCase();

    // Check providers first (more specific)
    for (const provider of LLM_PROVIDERS) {
        for (const identifier of provider.identifiers) {
            if (lowerText.includes(identifier)) {
                return provider.id;
            }
        }
    }

    // Check frameworks
    for (const framework of LLM_FRAMEWORKS) {
        for (const identifier of framework.identifiers) {
            if (lowerText.includes(identifier)) {
                return framework.id;
            }
        }
    }

    return null;
}

/**
 * Check if an import statement is LLM-related.
 * More precise than simple text matching - uses actual import patterns.
 */
export function isLLMImport(importStatement: string): boolean {
    return ALL_IMPORT_PATTERNS.some(pattern => pattern.test(importStatement));
}

/**
 * Check if a function call is an LLM API call.
 */
export function isLLMCall(callExpression: string): boolean {
    return ALL_CALL_PATTERNS.some(pattern => pattern.test(callExpression));
}

/**
 * Quick check if text might contain LLM-related code.
 * Used for fast filtering before more expensive analysis.
 */
export function mightContainLLM(text: string): boolean {
    return QUICK_SCAN_PATTERNS.some(pattern => pattern.test(text));
}

// =============================================================================
// HTTP Server Framework Detection
// =============================================================================

/** Package identifiers for HTTP server frameworks.
 *  Used to confirm a file is a server (not client) when detecting route handlers.
 *  Adding a new framework = add one string here. */
export const HTTP_SERVER_PACKAGES: string[] = [
    // Python
    'fastapi', 'flask', 'django', 'starlette', 'sanic', 'tornado', 'aiohttp',
    // JS/TS
    'express', 'hono', 'fastify', 'koa', 'koa-router', '@koa/router', 'polka',
    'restify', '@hapi/hapi', 'oak',
    // Go (partial import paths)
    'gin-gonic/gin', 'gofiber/fiber', 'labstack/echo', 'gorilla/mux',
    'chi', 'httprouter',
    // Rust
    'actix-web', 'axum', 'rocket', 'warp',
    // Java
    'spring', 'javalin', 'spark',
];

/** Common variable names used for router/app instances across frameworks.
 *  Used by both Python decorator detection and JS/TS/Go method-call detection. */
export const ROUTER_OBJECT_NAMES: Set<string> = new Set([
    'app', 'router', 'server', 'api',
    'r', 'e', 'g',           // Go conventions (gin: r, echo: e)
    'bp', 'blueprint',        // Flask blueprints
    'fastify',                // Fastify convention
    'group',                  // Go route groups
]);

/** File-convention route detection (Next.js App Router, SvelteKit, etc.)
 *  Files matching these patterns with matching exports = route handlers. */
export const ROUTE_FILE_CONVENTIONS: {
    filePatterns: RegExp[];
    exportNames: string[];
    deriveRoute: (filePath: string) => string | null;
}[] = [
    {
        // Next.js App Router: app/api/chat/route.ts exports POST
        filePatterns: [/\/app\/.*\/route\.[jt]sx?$/],
        exportNames: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        deriveRoute: (fp) => {
            const m = fp.match(/app\/(.*?)\/route\.[jt]sx?$/);
            if (!m) return null;
            return ('/' + m[1])
                .replace(/\/\([^)]+\)/g, '')           // strip route groups
                .replace(/\[\.\.\.([^\]]+)\]/g, ':$1') // [...slug] → :slug
                .replace(/\[([^\]]+)\]/g, ':$1')       // [id] → :id
                || '/';
        },
    },
    {
        // Next.js Pages Router: pages/api/chat.ts
        filePatterns: [/\/pages\/api\/.*\.[jt]sx?$/],
        exportNames: ['default'],
        deriveRoute: (fp) => {
            const m = fp.match(/pages\/(api\/.*?)(?:\/index)?\.[jt]sx?$/);
            return m ? '/' + m[1] : null;
        },
    },
    {
        // SvelteKit: src/routes/api/chat/+server.ts exports GET/POST
        filePatterns: [/\/src\/routes\/.*\/\+server\.[jt]s$/],
        exportNames: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        deriveRoute: (fp) => {
            const m = fp.match(/src\/routes\/(.*?)\/\+server\.[jt]s$/);
            return m ? '/' + m[1].replace(/\([^)]+\)\/?/g, '') : null;
        },
    },
];

/** Check if a file's imports indicate it uses an HTTP server framework */
export function hasHttpServerImport(fileText: string): boolean {
    const lower = fileText.toLowerCase();
    return HTTP_SERVER_PACKAGES.some(pkg => lower.includes(pkg));
}

/** Check if a file path matches a route file convention. Returns matching convention or null. */
export function matchRouteFileConvention(filePath: string): typeof ROUTE_FILE_CONVENTIONS[0] | null {
    for (const conv of ROUTE_FILE_CONVENTIONS) {
        if (conv.filePatterns.some(p => p.test(filePath))) return conv;
    }
    return null;
}


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
    /\.complete\s*\(/,
    /\.generate\s*\(/,
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

/**
 * Get provider display name from ID.
 */
export function getProviderDisplayName(providerId: string): string {
    const provider = LLM_PROVIDERS.find(p => p.id === providerId);
    if (provider) return provider.displayName;

    const framework = LLM_FRAMEWORKS.find(f => f.id === providerId);
    if (framework) return framework.displayName;

    return providerId;
}

/**
 * Centralized configuration constants for the Codag extension
 *
 * All magic numbers and configurable values should be defined here.
 * This makes the codebase easier to tune and maintain.
 */

export const CONFIG = {
    /**
     * Batch processing limits
     */
    BATCH: {
        /** Maximum number of files to include in a single analysis batch */
        MAX_SIZE: 5,
        /** Maximum tokens per batch (limits output size - Gemini output capped at 65k tokens) */
        MAX_TOKENS: 100_000,
    },

    /**
     * API concurrency settings (Gemini Flash: 1500 RPM, 4M TPM)
     */
    CONCURRENCY: {
        /** Maximum parallel Gemini API requests */
        MAX_PARALLEL: 10,
    },

    /**
     * File watching and debouncing
     */
    WATCHER: {
        /** Debounce delay in milliseconds before triggering re-analysis */
        DEBOUNCE_MS: 2000,
    },

    /**
     * Import analysis settings
     */
    IMPORTS: {
        /** Maximum depth to follow when expanding imports */
        MAX_DEPTH: 3,
        /** Maximum number of importers to expand when finding related files */
        MAX_IMPORTERS: 20,
    },

    /**
     * Gemini 2.5 Flash pricing (per 1M tokens)
     * Source: https://ai.google.dev/pricing
     */
    PRICING: {
        /** Input token cost per 1M tokens (prompts ≤128K) */
        INPUT_PER_1M: 0.075,
        /** Output token cost per 1M tokens (prompts ≤128K) */
        OUTPUT_PER_1M: 0.30,
    },

    /**
     * Edge resolution settings
     */
    EDGE_RESOLUTION: {
        /** How many directory levels to try when fuzzy matching cross-file edges */
        PATH_MATCHING_DEPTH: 4,
    },

    /**
     * HTTP endpoint detection settings
     */
    HTTP_DETECTION: {
        /** Minimum path segment length to be considered a valid endpoint (filters form fields) */
        MIN_PATH_SEGMENT_LENGTH: 10,
        /** Lines to search around a URL pattern to find the handler function */
        HANDLER_SEARCH_LINES: 5,
    },

    /**
     * Cache settings
     */
    CACHE: {
        /** Cache format version - increment when format changes (v10: relative path keys for security/portability) */
        VERSION: 10,
        /** Debounce delay for saving cache to disk */
        SAVE_DEBOUNCE_MS: 500,
    },

    /**
     * Analyzer limits
     */
    ANALYZER: {
        /** Maximum number of files to find when searching for LLM files */
        MAX_FILE_FIND: 10000,
        /** Lines of context to search around AI patterns */
        AI_PATTERN_CONTEXT_LINES: 5,
    },

    /**
     * Copilot tool limits
     */
    COPILOT: {
        /** Maximum tool calls per workflow participant turn */
        MAX_TOOL_CALLS: 5,
    },

    /**
     * Workflow detection settings
     */
    WORKFLOW: {
        /** Minimum nodes for initial workflow detection */
        MIN_NODES_INITIAL: 5,
        /** Minimum nodes for rendered workflow */
        MIN_NODES_RENDERED: 3,
    },
} as const;

/**
 * Supported file extensions for analysis
 * Add new languages here to support them across the codebase
 */
export const SUPPORTED_EXTENSIONS = ['.py', '.ts', '.tsx', '.js', '.jsx'] as const;

/**
 * Extended file extensions (including less common variants)
 */
export const ALL_EXTENSIONS = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * File/directory patterns to exclude from analysis
 * Based on gitdiagram's aggressive filtering + common patterns
 */
export const EXCLUDE_PATTERNS = [
    // Package managers & dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/bower_components/**',
    '**/.pnpm/**',

    // Build outputs
    '**/out/**',
    '**/dist/**',
    '**/build/**',
    '**/target/**',
    '**/bin/**',
    '**/obj/**',
    '**/_build/**',

    // Framework build directories
    '**/.next/**',
    '**/.nuxt/**',
    '**/.vitepress/**',
    '**/.docusaurus/**',
    '**/.svelte-kit/**',
    '**/.vercel/**',
    '**/.netlify/**',
    '**/.turbo/**',
    '**/.parcel-cache/**',

    // Caches
    '**/.cache/**',
    '**/__pycache__/**',
    '**/.ruff_cache/**',
    '**/.mypy_cache/**',
    '**/.pytest_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',

    // Virtual environments
    '**/venv/**',
    '**/.venv/**',
    '**/env/**',
    '**/virtualenv/**',
    '**/.virtualenv/**',

    // Version control
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',

    // IDE/Editor directories
    '**/.idea/**',
    '**/.vscode/**',
    '**/.vscode-test/**',
    '**/.vs/**',
    '**/*.xcodeproj/**',
    '**/*.xcworkspace/**',

    // Test coverage
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',

    // Test directories (usually not part of main workflow)
    '**/__tests__/**',
    '**/test/**',
    '**/tests/**',
    '**/spec/**',
    '**/__mocks__/**',
    '**/fixtures/**',

    // Generated/compiled files
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.d.ts',

    // Documentation
    '**/docs/**',
    '**/doc/**',
    '**/documentation/**',

    // Logs
    '**/logs/**',
    '**/log/**',
    '**/*.log',

    // Temporary files
    '**/tmp/**',
    '**/temp/**',
    '**/.tmp/**',

    // Migrations (usually boilerplate)
    '**/migrations/**',
    '**/alembic/**',
] as const;

/**
 * Keywords to filter out when extracting function calls
 * These are language builtins/keywords that shouldn't be treated as function calls
 */
export const KEYWORD_BLACKLISTS = {
    /** Python builtins and keywords to ignore */
    python: [
        'if', 'for', 'while', 'with', 'print', 'len', 'str', 'int',
        'list', 'dict', 'range', 'type', 'set', 'tuple', 'bool',
        'float', 'open', 'input', 'isinstance', 'hasattr', 'getattr',
    ],
    /** JavaScript/TypeScript keywords to ignore */
    javascript: [
        'if', 'else', 'for', 'while', 'switch', 'catch', 'return',
        'const', 'let', 'var', 'new', 'await', 'this', 'constructor',
        'super', 'typeof', 'instanceof', 'delete', 'void',
    ],
} as const;

/**
 * Common form field names to filter out in HTTP endpoint detection
 * These often appear in URLs but aren't actual API endpoints
 */
export const FORM_FIELD_BLACKLIST = [
    'email', 'name', 'password', 'username', 'phone', 'address',
    'message', 'comment', 'title', 'description', 'value', 'data',
    'id', 'type', 'status', 'token', 'key', 'code',
] as const;

/**
 * HTTP methods for endpoint detection
 */
export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

/**
 * Centralized configuration constants for the Codag extension
 *
 * TUNING GUIDELINES:
 * - MAX_BATCH_SIZE: Number of files analyzed together (higher = fewer API calls but larger prompts)
 * - MAX_TOKENS_PER_BATCH: Token limit per batch to avoid Gemini context limits (2M tokens)
 * - MAX_CONCURRENCY: Parallel API requests (Gemini Flash: 1500 RPM ≈ 25 req/sec)
 * - DEBOUNCE_MS: Delay before re-analyzing on file changes (avoid rapid re-triggers)
 * - MAX_IMPORT_DEPTH: How many levels of imports to include in analysis
 */

export const CONFIG = {
    /**
     * Batch processing limits
     */
    BATCH: {
        /** Maximum number of files to include in a single analysis batch */
        MAX_SIZE: 15,

        /** Maximum tokens per batch (safe limit well below Gemini's 2M context) */
        MAX_TOKENS: 800_000,
    },

    /**
     * API concurrency settings
     * Gemini Flash limits: 1500 RPM, 4M TPM
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
    },

    /**
     * Trial and auth defaults
     */
    TRIAL: {
        /** Total free analyses available to trial users */
        TOTAL_ANALYSES: 5,
    },
} as const;

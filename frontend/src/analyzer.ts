import * as vscode from 'vscode';
import * as path from 'path';
import { staticAnalyzer } from './static-analyzer';
import { CONFIG, EXCLUDE_PATTERNS } from './config';
import {
    LLM_PROVIDERS,
    LLM_FRAMEWORKS,
    AI_SERVICE_DOMAINS,
    AI_ENDPOINT_PATTERNS,
    ALL_IMPORT_PATTERNS,
    ALL_CALL_PATTERNS,
} from './providers';

export class WorkflowDetector {
    private static readonly FILE_EXTENSIONS = [
        '.py', '.ts', '.js', '.tsx', '.jsx',
        '.go', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
        '.swift', '.java', '.lua',
    ];

    private static buildExcludePattern(): string {
        // vscode.workspace.findFiles() already respects .gitignore — no need to parse them manually.
        // EXCLUDE_PATTERNS covers additional directories we want to skip (tests, docs, build outputs, etc.)
        return `{${EXCLUDE_PATTERNS.join(',')}}`;
    }

    /**
     * Expand detection to files that import base LLM files (cross-file analysis)
     * This catches files that call LLM wrappers indirectly (e.g., main.py → gemini_client.py)
     */
    private static async expandToImporters(
        baseFiles: vscode.Uri[],
        allFiles: vscode.Uri[],
        processed: Set<string> = new Set(),
        depth: number = 0
    ): Promise<vscode.Uri[]> {
        // Prevent infinite recursion from circular imports
        const MAX_DEPTH = CONFIG.IMPORTS.MAX_DEPTH;
        if (depth >= MAX_DEPTH) {
            return [];
        }

        if (baseFiles.length === 0) return [];

        const importers: vscode.Uri[] = [];
        const baseFilesSet = new Set(baseFiles.map(f => f.fsPath));

        // Extract module names from base files
        // e.g., "gemini_client.py" → "gemini_client"
        // e.g., "gemini-client.ts" → "gemini-client" or "geminiClient"
        const baseModuleNames = baseFiles.map(file => {
            const filename = file.fsPath.split('/').pop() || '';
            const nameWithoutExt = filename.replace(/\.(py|ts|js|tsx|jsx)$/, '');
            return nameWithoutExt;
        });

        // Build import detection patterns for each base file
        const importPatterns: RegExp[] = [];
        for (const moduleName of baseModuleNames) {
            // Python patterns
            importPatterns.push(
                new RegExp(`from\\s+${this.escapeRegex(moduleName)}\\s+import`, 'i'),
                new RegExp(`import\\s+${this.escapeRegex(moduleName)}(?:\\s|$)`, 'i')
            );

            // TypeScript/JavaScript patterns (handle both kebab-case and camelCase)
            // Match: import { X } from './gemini-client' or from '@/gemini-client'
            importPatterns.push(
                new RegExp(`from\\s+['"][^'"]*${this.escapeRegex(moduleName)}['"]`, 'i'),
                new RegExp(`require\\s*\\(['"][^'"]*${this.escapeRegex(moduleName)}['"]\\)`, 'i')
            );
        }

        // Search all files for imports matching base files
        for (const file of allFiles) {
            // Skip files already in base set
            if (baseFilesSet.has(file.fsPath)) continue;

            // Skip files already processed in previous iterations (prevent re-processing)
            if (processed.has(file.fsPath)) continue;
            processed.add(file.fsPath);

            try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf8');

                // Check if file imports any base LLM file
                const hasImport = importPatterns.some(pattern => pattern.test(text));

                if (hasImport) {
                    importers.push(file);
                }
            } catch (error) {
                // Skip files that can't be read
                continue;
            }
        }

        // Optional: Expand one more level (find files that import the importers)
        // This catches chains like: endpoint.py → main.py → gemini_client.py
        if (importers.length > 0 && importers.length < 20) {  // Limit to prevent explosion
            const secondLevelImporters = await this.expandToImporters(importers, allFiles, processed, depth + 1);
            return [...importers, ...secondLevelImporters];
        }

        return importers;
    }

    /**
     * Escape special regex characters in a string
     */
    private static escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static async detectInWorkspace(
        onProgress?: (scanned: number, total: number, found: number) => void
    ): Promise<vscode.Uri[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const files: vscode.Uri[] = [];

        // Build exclusion pattern from .gitignore + common patterns
        const excludePattern = this.buildExcludePattern();

        for (const ext of this.FILE_EXTENSIONS) {
            const found = await vscode.workspace.findFiles(
                `**/*${ext}`,
                excludePattern,
                10000  // Increased limit to handle large repositories
            );
            files.push(...found);
        }

        // Step 1: Detect base LLM files (files with direct LLM SDK usage)
        const baseWorkflowFiles: vscode.Uri[] = [];
        let scanned = 0;

        for (const file of files) {
            const content = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(content).toString('utf8');
            scanned++;

            if (this.detectWorkflow(text, file.fsPath)) {
                baseWorkflowFiles.push(file);
            }

            if (onProgress && (scanned % 50 === 0 || scanned === files.length)) {
                onProgress(scanned, files.length, baseWorkflowFiles.length);
            }
        }

        // Step 2: Expand to files that import base LLM files (cross-file analysis)
        const expandedFiles = await this.expandToImporters(baseWorkflowFiles, files);

        // Combine and deduplicate
        const allWorkflowFiles = [...new Set([...baseWorkflowFiles, ...expandedFiles])];

        // Sort for deterministic results
        allWorkflowFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        return allWorkflowFiles;
    }

    /**
     * Get all source files without analyzing content (fast).
     * Used to show file picker immediately.
     */
    static async getAllSourceFiles(): Promise<vscode.Uri[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const files: vscode.Uri[] = [];
        const excludePattern = this.buildExcludePattern();

        for (const ext of this.FILE_EXTENSIONS) {
            const found = await vscode.workspace.findFiles(
                `**/*${ext}`,
                excludePattern,
                10000
            );
            files.push(...found);
        }

        files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return files;
    }

    static detectWorkflow(content: string, filePath?: string): boolean {
        // Two-pass detection: AST-based (accurate) → Direct LLM patterns (fallback)

        // Pass 1: AST-based detection (most accurate)
        if (filePath) {
            try {
                const analysis = staticAnalyzer.analyze(content, filePath);
                if (analysis.locations.length > 0 || analysis.llmRelatedVariables.size > 0) {
                    return true;
                }
            } catch (error) {
                console.warn('AST parsing failed, falling back to regex:', error);
            }
        }

        // Pass 2: Direct LLM usage detection (regex fallback)
        const hasLLMClient = ALL_IMPORT_PATTERNS.some(pattern => pattern.test(content));
        const hasLLMCalls = ALL_CALL_PATTERNS.some(pattern => pattern.test(content));
        const hasFramework = LLM_FRAMEWORKS.some(f => f.importPatterns.some(p => p.test(content)));

        if ((hasLLMClient && hasLLMCalls) || hasFramework) {
            return true;
        }

        // Pass 3: AI Service API detection (non-LLM AI services using HTTP)
        const hasAIServiceDomain = AI_SERVICE_DOMAINS.some(pattern => pattern.test(content));
        const hasAIEndpoint = AI_ENDPOINT_PATTERNS.some(pattern => pattern.test(content));

        if (hasAIServiceDomain || hasAIEndpoint) {
            return true;
        }

        return false;
    }

    static detectFramework(content: string): string | null {
        // Check each provider's import patterns
        for (const provider of LLM_PROVIDERS) {
            if (provider.importPatterns.some(pattern => pattern.test(content))) {
                return provider.id;
            }
        }

        // Check frameworks
        for (const framework of LLM_FRAMEWORKS) {
            if (framework.importPatterns.some(pattern => pattern.test(content))) {
                return framework.id;
            }
        }

        // Check if it has any LLM patterns
        if (this.detectWorkflow(content)) {
            return 'generic-llm';
        }

        return null;
    }

    /**
     * Detect ALL AI services/APIs in the content (not just the first one)
     * Returns array of detected service names
     */
    static detectAllAIServices(content: string): string[] {
        const detected: string[] = [];

        // Check all LLM providers
        for (const provider of LLM_PROVIDERS) {
            if (provider.importPatterns.some(pattern => pattern.test(content))) {
                detected.push(provider.displayName);
            }
        }

        // AI Service Domains - require API URLs or SDK imports
        if (/api\.elevenlabs\.io|from\s+elevenlabs|import\s+elevenlabs|['"]elevenlabs['"]/i.test(content)) detected.push('ElevenLabs');
        if (/api\.(dev\.)?runwayml\.com|runwayml_sdk|from\s+runwayml|['"]runwayml['"]/i.test(content)) detected.push('Runway');
        if (/api\.sync\.so|sync_labs|synclabs|['"]sync-labs['"]/i.test(content)) detected.push('Sync Labs');
        if (/api\.stability\.ai|stability_sdk|from\s+stability_sdk|['"]stability-sdk['"]/i.test(content)) detected.push('Stability AI');
        if (/api\.d-id\.com|['"]d-id['"]/i.test(content)) detected.push('D-ID');
        if (/api\.heygen\.com|heygen_sdk|['"]heygen['"]/i.test(content)) detected.push('HeyGen');
        if (/api\.leonardo\.ai|leonardo_sdk|['"]leonardo-ai['"]/i.test(content)) detected.push('Leonardo.ai');
        if (/audio2expression|a2e_sdk|['"]a2e['"]/i.test(content)) detected.push('A2E');

        // Check frameworks
        for (const framework of LLM_FRAMEWORKS) {
            if (framework.importPatterns.some(pattern => pattern.test(content))) {
                detected.push(framework.displayName);
            }
        }

        return [...new Set(detected)]; // Remove duplicates
    }

    static isWorkflowFile(uri: vscode.Uri): boolean {
        const ext = path.extname(uri.fsPath);
        return this.FILE_EXTENSIONS.includes(ext);
    }
}

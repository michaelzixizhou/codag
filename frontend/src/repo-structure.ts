/**
 * Repo Structure Extractor
 *
 * Extracts structural information from all files in the repo for cross-batch context.
 * Uses AST parsers (acorn for JS/TS, regex for Python) to build comprehensive structure.
 * HTTP endpoint extraction is AST-based for reliability.
 */

import * as acorn from 'acorn';
import * as jsx from 'acorn-jsx';
const tsParser = require('@typescript-eslint/typescript-estree');

// Re-export types for compatibility
export interface HttpClientCall {
    file: string;
    line: number;
    function: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
    endpoint: string;
    normalizedPath: string;
}

export interface HttpRouteHandler {
    file: string;
    line: number;
    function: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
    path: string;
}

export interface HttpConnection {
    client: HttpClientCall;
    handler: HttpRouteHandler;
    confidence: 'exact' | 'fuzzy';
}

// HTTP client method names to detect
const HTTP_CLIENT_METHODS = ['get', 'post', 'put', 'delete', 'patch'];

// Known LLM API call patterns
const LLM_CALL_PATTERNS = [
    /generate_content/,
    /chat\.completions\.create/,
    /messages\.create/,
    /aio\.models\.generate_content/,
    /\.chat\(/,
    /\.complete\(/,
    /\.generate\(/,
    /openai/i,
    /anthropic/i,
    /gemini/i,
    /cohere/i,
    /groq/i,
];

export interface FunctionDef {
    name: string;
    line: number;
    calls: string[];
    isExported: boolean;
    hasLLMCall: boolean;
    params: string[];
    isAsync: boolean;
    httpCalls: HttpClientCall[];  // HTTP client calls made by this function
}

export interface FileStructure {
    path: string;
    functions: FunctionDef[];
    exports: string[];
    imports: ImportDef[];
    httpRouteHandlers: HttpRouteHandler[];  // Route handlers defined in this file
}

export interface ImportDef {
    source: string;
    symbols: string[];
}

export interface RawRepoStructure {
    files: FileStructure[];
    httpClientCalls: HttpClientCall[];
    httpRouteHandlers: HttpRouteHandler[];
    httpConnections: HttpConnection[];
}

function isLLMCall(callPath: string): boolean {
    return LLM_CALL_PATTERNS.some(p => p.test(callPath));
}

/**
 * Normalize endpoint path (remove protocol/host, ensure leading slash)
 */
function normalizeEndpoint(endpoint: string): string {
    try {
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
            const url = new URL(endpoint);
            return url.pathname;
        }

        // Handle Python f-string interpolation: f"{base_url}/path" → /path
        const fstringMatch = endpoint.match(/\{[^}]+\}(.+)/);
        if (fstringMatch && fstringMatch[1]) {
            endpoint = fstringMatch[1];
        }

        // Handle template literals with ${...}
        endpoint = endpoint.replace(/\$\{[^}]+\}/g, ':param');
        // Ensure starts with /
        if (!endpoint.startsWith('/')) {
            endpoint = '/' + endpoint;
        }
        return endpoint.replace(/\/+$/, '') || '/';
    } catch {
        return endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    }
}

/**
 * Check if an endpoint looks like a valid HTTP path
 * Filters out false positives like form field names
 */
function isValidHttpPath(endpoint: string): boolean {
    // Must contain a slash
    if (!endpoint.includes('/')) {
        return false;
    }

    // Skip single-segment "paths" that are likely form fields
    const segments = endpoint.split('/').filter(s => s.length > 0);
    if (segments.length === 1 && segments[0].length < 10 && !segments[0].includes('-')) {
        const commonFormFields = ['email', 'name', 'password', 'username', 'phone', 'address', 'message', 'comment', 'title', 'description', 'value', 'data', 'id', 'type', 'status', 'confirmpassword'];
        if (commonFormFields.includes(segments[0].toLowerCase())) {
            return false;
        }
    }

    return true;
}

/**
 * Match paths for HTTP connection detection
 */
function matchPaths(
    clientPath: string,
    handlerPath: string,
    clientMethod: string,
    handlerMethod: string
): 'exact' | 'fuzzy' | null {
    // Methods must match
    if (clientMethod.toUpperCase() !== handlerMethod.toUpperCase()) {
        return null;
    }

    // Normalize paths
    const normClient = clientPath.replace(/\/+$/, '') || '/';
    const normHandler = handlerPath.replace(/\/+$/, '') || '/';

    // Exact match
    if (normClient === normHandler) {
        return 'exact';
    }

    // Fuzzy match: handler has path params like /users/:id or /users/{id}
    const handlerRegex = normHandler
        .replace(/:[^/]+/g, '[^/]+')
        .replace(/\{[^}]+\}/g, '[^/]+');

    if (new RegExp(`^${handlerRegex}$`).test(normClient)) {
        return 'fuzzy';
    }

    // Partial match
    if (normClient.startsWith(normHandler) || normHandler.startsWith(normClient)) {
        return 'fuzzy';
    }

    return null;
}

/**
 * Extract structure from JavaScript/JSX file
 */
function extractJavaScriptStructure(code: string, filePath: string): FileStructure {
    const functions: FunctionDef[] = [];
    const exports: string[] = [];
    const imports: ImportDef[] = [];
    const exportedNames = new Set<string>();

    try {
        const parser = acorn.Parser.extend(jsx.default());
        const ast = parser.parse(code, {
            ecmaVersion: 2020,
            sourceType: 'module',
            locations: true
        }) as any;

        // First pass: collect exports
        const walkForExports = (node: any) => {
            if (!node) return;

            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration?.id?.name) {
                    exportedNames.add(node.declaration.id.name);
                }
                if (node.specifiers) {
                    for (const spec of node.specifiers) {
                        if (spec.exported?.name) {
                            exportedNames.add(spec.exported.name);
                        }
                    }
                }
            }

            if (node.type === 'ExportDefaultDeclaration') {
                if (node.declaration?.id?.name) {
                    exportedNames.add(node.declaration.id.name);
                }
                exportedNames.add('default');
            }

            for (const key in node) {
                if (key === 'loc' || key === 'range') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(c => walkForExports(c));
                } else if (child && typeof child === 'object') {
                    walkForExports(child);
                }
            }
        };
        walkForExports(ast);

        // Second pass: collect functions and imports
        let currentFunction: { name: string; calls: string[]; hasLLMCall: boolean; httpCalls: HttpClientCall[] } | null = null;

        const walkNode = (node: any) => {
            if (!node) return;

            // Track imports
            if (node.type === 'ImportDeclaration') {
                const source = node.source.value;
                const symbols = (node.specifiers || []).map((s: any) =>
                    s.imported?.name || s.local?.name || 'default'
                );
                imports.push({ source, symbols });
            }

            // Track function definitions
            if (node.type === 'FunctionDeclaration' ||
                (node.type === 'VariableDeclarator' &&
                 (node.init?.type === 'FunctionExpression' || node.init?.type === 'ArrowFunctionExpression'))) {

                const funcName = node.id?.name;
                if (funcName) {
                    const funcNode = node.type === 'FunctionDeclaration' ? node : node.init;
                    currentFunction = { name: funcName, calls: [], hasLLMCall: false, httpCalls: [] };

                    // Walk function body
                    if (funcNode.body) walkNode(funcNode.body);

                    functions.push({
                        name: funcName,
                        line: node.loc?.start.line || 0,
                        calls: currentFunction.calls,
                        isExported: exportedNames.has(funcName),
                        hasLLMCall: currentFunction.hasLLMCall,
                        params: (funcNode.params || []).map((p: any) => p.name || 'unknown'),
                        isAsync: funcNode.async || false,
                        httpCalls: currentFunction.httpCalls
                    });

                    if (exportedNames.has(funcName)) {
                        exports.push(funcName);
                    }

                    currentFunction = null;
                    return;
                }
            }

            // Track function calls
            if (node.type === 'CallExpression' && currentFunction) {
                let callee = '';
                if (node.callee.type === 'Identifier') {
                    callee = node.callee.name;
                } else if (node.callee.type === 'MemberExpression') {
                    callee = getMemberChain(node.callee);
                }

                if (callee && !currentFunction.calls.includes(callee)) {
                    currentFunction.calls.push(callee);
                    if (isLLMCall(callee)) {
                        currentFunction.hasLLMCall = true;
                    }
                }

                // Check for HTTP client calls (e.g., this.client.post('/path'), axios.get('/path'))
                if (node.callee.type === 'MemberExpression') {
                    const methodName = node.callee.property?.name?.toLowerCase();
                    if (HTTP_CLIENT_METHODS.includes(methodName)) {
                        // Get the first argument (endpoint)
                        const firstArg = node.arguments?.[0];
                        let endpoint = '';
                        if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') {
                            endpoint = firstArg.value;
                        } else if (firstArg?.type === 'TemplateLiteral' && firstArg.quasis?.length === 1) {
                            // Simple template literal with no expressions
                            endpoint = firstArg.quasis[0].value?.cooked || '';
                        }

                        if (endpoint) {
                            const normalizedPath = normalizeEndpoint(endpoint);
                            // Filter out false positives (form fields, etc.)
                            if (isValidHttpPath(normalizedPath)) {
                                currentFunction.httpCalls.push({
                                    file: filePath,
                                    line: node.loc?.start.line || 0,
                                    function: currentFunction.name,
                                    method: methodName.toUpperCase(),
                                    endpoint: endpoint,
                                    normalizedPath: normalizedPath
                                });
                            }
                        }
                    }
                }
            }

            // Walk children
            for (const key in node) {
                if (key === 'loc' || key === 'range') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(c => walkNode(c));
                } else if (child && typeof child === 'object') {
                    walkNode(child);
                }
            }
        };

        walkNode(ast);

    } catch (error) {
        console.warn(`Failed to parse JS ${filePath}:`, error);
    }

    return { path: filePath, functions, exports, imports, httpRouteHandlers: [] };
}

/**
 * Extract structure from TypeScript/TSX file
 */
function extractTypeScriptStructure(code: string, filePath: string): FileStructure {
    const functions: FunctionDef[] = [];
    const exports: string[] = [];
    const imports: ImportDef[] = [];
    const exportedNames = new Set<string>();

    try {
        const isJSX = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
        const ast = tsParser.parse(code, {
            loc: true,
            range: true,
            jsx: isJSX
        });

        // First pass: collect exports
        const walkForExports = (node: any) => {
            if (!node || typeof node !== 'object') return;

            if (node.type === 'ExportNamedDeclaration') {
                if (node.declaration?.id?.name) {
                    exportedNames.add(node.declaration.id.name);
                }
                if (node.declaration?.declarations) {
                    for (const decl of node.declaration.declarations) {
                        if (decl.id?.name) exportedNames.add(decl.id.name);
                    }
                }
                if (node.specifiers) {
                    for (const spec of node.specifiers) {
                        if (spec.exported?.name) exportedNames.add(spec.exported.name);
                    }
                }
            }

            if (node.type === 'ExportDefaultDeclaration') {
                if (node.declaration?.id?.name) exportedNames.add(node.declaration.id.name);
                exportedNames.add('default');
            }

            for (const key in node) {
                if (key === 'loc' || key === 'range' || key === 'parent') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(c => walkForExports(c));
                } else if (child && typeof child === 'object') {
                    walkForExports(child);
                }
            }
        };
        walkForExports(ast);

        // Second pass: collect functions and imports
        let currentFunction: { name: string; calls: string[]; hasLLMCall: boolean; httpCalls: HttpClientCall[] } | null = null;

        const walkNode = (node: any) => {
            if (!node || typeof node !== 'object') return;

            // Track imports
            if (node.type === 'ImportDeclaration' && node.source?.value) {
                const source = node.source.value;
                const symbols = (node.specifiers || []).map((s: any) =>
                    s.imported?.name || s.local?.name || 'default'
                );
                imports.push({ source, symbols });
            }

            // Track function definitions
            if (node.type === 'FunctionDeclaration' ||
                node.type === 'MethodDefinition' ||
                (node.type === 'VariableDeclarator' &&
                 (node.init?.type === 'FunctionExpression' || node.init?.type === 'ArrowFunctionExpression'))) {

                const funcName = node.id?.name || node.key?.name;
                if (funcName) {
                    const funcNode = node.type === 'MethodDefinition' ? node.value :
                                     node.type === 'VariableDeclarator' ? node.init : node;
                    currentFunction = { name: funcName, calls: [], hasLLMCall: false, httpCalls: [] };

                    // Walk function body
                    if (funcNode?.body) walkNode(funcNode.body);

                    functions.push({
                        name: funcName,
                        line: node.loc?.start.line || 0,
                        calls: currentFunction.calls,
                        isExported: exportedNames.has(funcName),
                        hasLLMCall: currentFunction.hasLLMCall,
                        params: (funcNode?.params || []).map((p: any) => p.name || p.left?.name || 'unknown'),
                        isAsync: funcNode?.async || false,
                        httpCalls: currentFunction.httpCalls
                    });

                    if (exportedNames.has(funcName)) {
                        exports.push(funcName);
                    }

                    currentFunction = null;
                    return;
                }
            }

            // Track function calls
            if (node.type === 'CallExpression' && currentFunction) {
                let callee = '';
                if (node.callee?.type === 'Identifier') {
                    callee = node.callee.name;
                } else if (node.callee?.type === 'MemberExpression') {
                    callee = getMemberChain(node.callee);
                }

                if (callee && !currentFunction.calls.includes(callee)) {
                    currentFunction.calls.push(callee);
                    if (isLLMCall(callee)) {
                        currentFunction.hasLLMCall = true;
                    }
                }

                // Check for HTTP client calls (e.g., this.client.post('/path'), axios.get('/path'))
                if (node.callee?.type === 'MemberExpression') {
                    const methodName = node.callee.property?.name?.toLowerCase();
                    if (HTTP_CLIENT_METHODS.includes(methodName)) {
                        // Get the first argument (endpoint)
                        const firstArg = node.arguments?.[0];
                        let endpoint = '';
                        if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') {
                            endpoint = firstArg.value;
                        } else if (firstArg?.type === 'TemplateLiteral' && firstArg.quasis?.length === 1) {
                            endpoint = firstArg.quasis[0].value?.cooked || '';
                        }

                        if (endpoint) {
                            const normalizedPath = normalizeEndpoint(endpoint);
                            // Filter out false positives (form fields, etc.)
                            if (isValidHttpPath(normalizedPath)) {
                                currentFunction.httpCalls.push({
                                    file: filePath,
                                    line: node.loc?.start.line || 0,
                                    function: currentFunction.name,
                                    method: methodName.toUpperCase(),
                                    endpoint: endpoint,
                                    normalizedPath: normalizedPath
                                });
                            }
                        }
                    }
                }
            }

            // Walk children
            for (const key in node) {
                if (key === 'loc' || key === 'range' || key === 'parent') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(c => walkNode(c));
                } else if (child && typeof child === 'object') {
                    walkNode(child);
                }
            }
        };

        walkNode(ast);

    } catch (error) {
        console.warn(`Failed to parse TS ${filePath}:`, error);
    }

    return { path: filePath, functions, exports, imports, httpRouteHandlers: [] };
}

/**
 * Extract structure from Python file
 */
function extractPythonStructure(code: string, filePath: string): FileStructure {
    const functions: FunctionDef[] = [];
    const exports: string[] = [];
    const imports: ImportDef[] = [];
    const httpRouteHandlers: HttpRouteHandler[] = [];

    const lines = code.split('\n');
    let decorators: Array<{ text: string; line: number; fullLine: string }> = [];

    // Match function definitions - params may span multiple lines, so we only require the opening paren
    const funcDefPattern = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)/;
    const decoratorPattern = /^(\s*)@(\w+(?:\.\w+)*)/;
    const importPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/;
    const callPattern = /(\w+(?:\.\w+)*)\s*\(/g;

    // Route handler decorator patterns: @app.post("/path"), @router.get("/path")
    const routeDecoratorPattern = /@(?:app|router)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/i;

    // HTTP client call patterns: httpx.get("/path"), requests.post("/path"), await client.post(f"url")
    const httpClientPattern = /(?:(?:httpx|requests)\s*\.\s*(get|post|put|delete|patch)|await\s+(?:self\.)?(?:client|session|http_client)\s*\.\s*(get|post|put|delete|patch))\s*\(\s*(?:f)?['"`]([^'"`]+)['"`]/gi;

    // Check for __all__ export list
    const allMatch = code.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
    const explicitExports = new Set<string>();
    if (allMatch) {
        const items = allMatch[1].match(/['"](\w+)['"]/g);
        if (items) {
            items.forEach(item => {
                const name = item.replace(/['"]/g, '');
                explicitExports.add(name);
                exports.push(name);
            });
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Track decorators with their full text for route extraction
        const decoratorMatch = line.match(decoratorPattern);
        if (decoratorMatch) {
            decorators.push({ text: decoratorMatch[2], line: lineNum, fullLine: line });
            continue;
        }

        // Track imports
        const importMatch = line.match(importPattern);
        if (importMatch) {
            const source = importMatch[1] || importMatch[2].split(',')[0].trim().split(' ')[0];
            const symbolsPart = importMatch[2];
            const symbols = symbolsPart.split(',').map(s => s.trim().split(' ')[0]).filter(s => s && s !== 'as');
            imports.push({ source, symbols });
            decorators = [];
            continue;
        }

        // Track function definitions
        const funcMatch = line.match(funcDefPattern);
        if (funcMatch) {
            const funcIndent = funcMatch[1].length;
            const funcName = funcMatch[2];
            // Params may be partial (multi-line functions), extract what we can
            const paramsStr = funcMatch[3] || '';
            const params = paramsStr.split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(p => p && p !== 'self');

            // Check for endpoint decorators and extract route info
            let hasEndpoint = false;
            for (const dec of decorators) {
                const routeMatch = dec.fullLine.match(routeDecoratorPattern);
                if (routeMatch) {
                    hasEndpoint = true;
                    httpRouteHandlers.push({
                        file: filePath,
                        line: dec.line,
                        function: funcName,
                        method: routeMatch[1].toUpperCase(),
                        path: routeMatch[2]
                    });
                }
            }

            // Build function data - will collect calls by looking ahead
            const funcData: FunctionDef = {
                name: funcName,
                line: lineNum,
                calls: [],
                isExported: !funcName.startsWith('_') || explicitExports.has(funcName) || hasEndpoint,
                hasLLMCall: false,
                params,
                isAsync: line.includes('async def'),
                httpCalls: []
            };

            // Look ahead to find function body and calls
            let j = i + 1;
            while (j < lines.length) {
                const bodyLine = lines[j];
                const bodyLineNum = j + 1;
                const bodyIndent = bodyLine.search(/\S/);

                if (bodyIndent === -1) { j++; continue; } // Empty line
                if (bodyIndent <= funcIndent) break; // Out of function

                // Find regular calls in this line
                const callMatches = Array.from(bodyLine.matchAll(callPattern));
                for (const match of callMatches) {
                    const callee = match[1];
                    if (!['if', 'for', 'while', 'with', 'print', 'len', 'str', 'int', 'list', 'dict', 'range', 'type', 'super', 'isinstance'].includes(callee)) {
                        if (!funcData.calls.includes(callee)) {
                            funcData.calls.push(callee);
                        }
                        if (isLLMCall(callee)) {
                            funcData.hasLLMCall = true;
                        }
                    }
                }

                // Find HTTP client calls in this line
                const httpMatches = Array.from(bodyLine.matchAll(httpClientPattern));
                for (const match of httpMatches) {
                    // Method can be in group 1 (httpx/requests) or group 2 (await client)
                    const method = (match[1] || match[2]).toUpperCase();
                    const endpoint = match[3];
                    const normalizedPath = normalizeEndpoint(endpoint);
                    if (isValidHttpPath(normalizedPath)) {
                        funcData.httpCalls.push({
                            file: filePath,
                            line: bodyLineNum,
                            function: funcName,
                            method,
                            endpoint,
                            normalizedPath
                        });
                    }
                }

                j++;
            }

            functions.push(funcData);

            if (funcData.isExported && !exports.includes(funcName)) {
                exports.push(funcName);
            }

            decorators = [];
            continue;
        }

        decorators = [];
    }

    return { path: filePath, functions, exports, imports, httpRouteHandlers };
}

/**
 * Get the full member expression chain
 */
function getMemberChain(node: any): string {
    const parts: string[] = [];
    let current = node;

    while (current) {
        if (current.type === 'MemberExpression') {
            const prop = current.property?.name || current.property?.value;
            if (prop) parts.unshift(prop);
            current = current.object;
        } else if (current.type === 'Identifier') {
            parts.unshift(current.name);
            break;
        } else if (current.type === 'CallExpression') {
            current = current.callee;
        } else {
            break;
        }
    }

    return parts.join('.');
}

/**
 * Extract structure from a single file
 */
export function extractFileStructure(code: string, filePath: string): FileStructure {
    if (filePath.endsWith('.py')) {
        return extractPythonStructure(code, filePath);
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        return extractTypeScriptStructure(code, filePath);
    } else if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
        return extractJavaScriptStructure(code, filePath);
    }

    return { path: filePath, functions: [], exports: [], imports: [], httpRouteHandlers: [] };
}

/**
 * Extract structure from multiple files
 */
export function extractRepoStructure(files: { path: string; content: string }[]): RawRepoStructure {
    const fileStructures: FileStructure[] = [];
    const allHttpClientCalls: HttpClientCall[] = [];
    const allHttpRouteHandlers: HttpRouteHandler[] = [];

    for (const file of files) {
        const structure = extractFileStructure(file.content, file.path);
        if (structure.functions.length > 0 || structure.exports.length > 0) {
            fileStructures.push(structure);

            // Collect HTTP client calls from all functions (AST-extracted)
            for (const func of structure.functions) {
                if (func.httpCalls && func.httpCalls.length > 0) {
                    allHttpClientCalls.push(...func.httpCalls);
                }
            }

            // Collect route handlers from file structure (AST-extracted)
            if (structure.httpRouteHandlers && structure.httpRouteHandlers.length > 0) {
                allHttpRouteHandlers.push(...structure.httpRouteHandlers);
            }
        }
    }

    // Match HTTP client calls to route handlers using AST-extracted data
    const httpConnections: HttpConnection[] = [];
    for (const clientCall of allHttpClientCalls) {
        for (const handler of allHttpRouteHandlers) {
            const matchResult = matchPaths(
                clientCall.normalizedPath,
                handler.path,
                clientCall.method,
                handler.method
            );
            if (matchResult) {
                httpConnections.push({
                    client: clientCall,
                    handler,
                    confidence: matchResult
                });
            }
        }
    }

    return {
        files: fileStructures,
        httpClientCalls: allHttpClientCalls,
        httpRouteHandlers: allHttpRouteHandlers,
        httpConnections
    };
}

/**
 * Format raw structure as JSON for LLM condensation
 */
export function formatStructureForLLM(structure: RawRepoStructure): string {
    const simplified = structure.files.map(file => ({
        path: file.path,
        functions: file.functions.map(f => ({
            name: f.name,
            line: f.line,
            calls: f.calls.slice(0, 10), // Limit calls to reduce tokens
            exported: f.isExported,
            hasLLM: f.hasLLMCall,
            async: f.isAsync
        })),
        exports: file.exports,
        imports: file.imports.map(i => i.source)
    }));

    // Include HTTP connections for cross-service workflow detection
    const httpConnections = structure.httpConnections.map(conn => ({
        client: {
            file: conn.client.file,
            function: conn.client.function,
            line: conn.client.line,
            method: conn.client.method,
            endpoint: conn.client.normalizedPath
        },
        handler: {
            file: conn.handler.file,
            function: conn.handler.function,
            line: conn.handler.line,
            method: conn.handler.method,
            path: conn.handler.path
        },
        confidence: conn.confidence
    }));

    return JSON.stringify({
        files: simplified,
        httpConnections
    }, null, 2);
}

/**
 * Format HTTP connections as human-readable text for workflow context
 */
export function formatHttpConnectionsForPrompt(structure: RawRepoStructure): string {
    if (structure.httpConnections.length === 0) {
        return '';
    }

    // Deduplicate connections by unique client→handler pair
    // This prevents the LLM from creating duplicate edges when multiple
    // code paths call the same endpoint
    const seen = new Set<string>();
    const dedupedConnections = structure.httpConnections.filter(conn => {
        const key = `${conn.client.file}::${conn.client.function}→${conn.handler.file}::${conn.handler.function}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    let output = '\n## Cross-Service HTTP Connections\n';
    output += 'These HTTP client calls connect to route handlers in other files:\n\n';

    for (const conn of dedupedConnections) {
        output += `- ${conn.client.file}::${conn.client.function} `;
        output += `--(${conn.client.method} ${conn.client.normalizedPath})--> `;
        output += `${conn.handler.file}::${conn.handler.function}\n`;
    }

    return output;
}

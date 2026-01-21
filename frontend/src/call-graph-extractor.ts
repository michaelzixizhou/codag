/**
 * Call Graph Extractor
 *
 * Extracts function definitions and call relationships for local graph updates.
 * Uses existing parsers (acorn for JS/TS, regex for Python) to build call graphs.
 */

import * as acorn from 'acorn';
import * as jsx from 'acorn-jsx';
const tsParser = require('@typescript-eslint/typescript-estree');
import { ALL_CALL_PATTERNS, isLLMCall as checkLLMCall } from './providers';
import { KEYWORD_BLACKLISTS } from './config';

export interface FunctionInfo {
    name: string;
    startLine: number;
    endLine: number;
    decorators: string[];
    isAsync: boolean;
    params: string[];
}

export interface CallInfo {
    callee: string;         // Function/method being called
    line: number;
    isLLMCall: boolean;     // Is this a known LLM API call?
}

export interface ExtractedCallGraph {
    filePath: string;
    functions: Map<string, FunctionInfo>;       // function name → info
    callGraph: Map<string, string[]>;           // function → functions it calls
    llmCalls: Map<string, CallInfo[]>;          // function → LLM calls within it
    imports: string[];
    hash: string;                               // Structural hash for change detection
}

// LLM API call patterns - imported from centralized providers.ts
function isLLMCall(callPath: string): boolean {
    return checkLLMCall(callPath);
}

/**
 * Create a structural hash for change detection
 * Only includes function names and call relationships, not line numbers
 */
function createStructuralHash(
    functions: Map<string, FunctionInfo>,
    callGraph: Map<string, string[]>
): string {
    const parts: string[] = [];

    // Sort function names for consistency
    const sortedFunctions = Array.from(functions.keys()).sort();
    for (const fn of sortedFunctions) {
        const calls = callGraph.get(fn) || [];
        parts.push(`${fn}:[${calls.sort().join(',')}]`);
    }

    // Simple hash (could use crypto for production)
    let hash = 0;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}

/**
 * Extract call graph from JavaScript/JSX
 */
function extractJavaScript(code: string, filePath: string): ExtractedCallGraph {
    const functions = new Map<string, FunctionInfo>();
    const callGraph = new Map<string, string[]>();
    const llmCalls = new Map<string, CallInfo[]>();
    const imports: string[] = [];

    try {
        const parser = acorn.Parser.extend(jsx.default());
        const ast = parser.parse(code, {
            ecmaVersion: 2020,
            sourceType: 'module',
            locations: true
        }) as any;

        let currentFunction = 'global';

        const walkNode = (node: any) => {
            if (!node) return;

            // Track function definitions
            if (node.type === 'FunctionDeclaration' ||
                node.type === 'FunctionExpression' ||
                node.type === 'ArrowFunctionExpression') {

                const funcName = node.id?.name || `anonymous_${node.loc?.start.line}`;
                const oldFunc = currentFunction;
                currentFunction = funcName;

                functions.set(funcName, {
                    name: funcName,
                    startLine: node.loc?.start.line || 0,
                    endLine: node.loc?.end.line || 0,
                    decorators: [],
                    isAsync: node.async || false,
                    params: (node.params || []).map((p: any) => p.name || 'unknown')
                });

                if (!callGraph.has(funcName)) {
                    callGraph.set(funcName, []);
                }

                // Walk function body
                if (node.body) walkNode(node.body);

                currentFunction = oldFunc;
                return;
            }

            // Track imports
            if (node.type === 'ImportDeclaration') {
                imports.push(node.source.value);
            }

            // Track function calls
            if (node.type === 'CallExpression') {
                let callee = '';

                if (node.callee.type === 'Identifier') {
                    callee = node.callee.name;
                } else if (node.callee.type === 'MemberExpression') {
                    callee = getMemberChain(node.callee);
                }

                if (callee) {
                    // Add to call graph
                    const calls = callGraph.get(currentFunction) || [];
                    if (!calls.includes(callee)) {
                        calls.push(callee);
                        callGraph.set(currentFunction, calls);
                    }

                    // Track LLM calls separately
                    if (isLLMCall(callee)) {
                        const llm = llmCalls.get(currentFunction) || [];
                        llm.push({
                            callee,
                            line: node.loc?.start.line || 0,
                            isLLMCall: true
                        });
                        llmCalls.set(currentFunction, llm);
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

    return {
        filePath,
        functions,
        callGraph,
        llmCalls,
        imports,
        hash: createStructuralHash(functions, callGraph)
    };
}

/**
 * Extract call graph from TypeScript/TSX
 */
function extractTypeScript(code: string, filePath: string): ExtractedCallGraph {
    const functions = new Map<string, FunctionInfo>();
    const callGraph = new Map<string, string[]>();
    const llmCalls = new Map<string, CallInfo[]>();
    const imports: string[] = [];

    try {
        const isJSX = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
        const ast = tsParser.parse(code, {
            loc: true,
            range: true,
            jsx: isJSX
        });

        let currentFunction = 'global';

        const walkNode = (node: any) => {
            if (!node || typeof node !== 'object') return;

            // Track function definitions
            if (node.type === 'FunctionDeclaration' ||
                node.type === 'FunctionExpression' ||
                node.type === 'ArrowFunctionExpression' ||
                node.type === 'MethodDefinition') {

                const funcName = node.id?.name || node.key?.name || `anonymous_${node.loc?.start.line}`;
                const oldFunc = currentFunction;
                currentFunction = funcName;

                functions.set(funcName, {
                    name: funcName,
                    startLine: node.loc?.start.line || 0,
                    endLine: node.loc?.end.line || 0,
                    decorators: [],
                    isAsync: node.async || false,
                    params: (node.params || []).map((p: any) => p.name || p.left?.name || 'unknown')
                });

                if (!callGraph.has(funcName)) {
                    callGraph.set(funcName, []);
                }

                // Walk function body (MethodDefinition has body in node.value.body)
                if (node.body) {
                    walkNode(node.body);
                } else if (node.value?.body) {
                    walkNode(node.value.body);
                }

                currentFunction = oldFunc;
                return;
            }

            // Track imports
            if (node.type === 'ImportDeclaration' && node.source?.value) {
                imports.push(node.source.value);
            }

            // Track function calls
            if (node.type === 'CallExpression') {
                let callee = '';

                if (node.callee?.type === 'Identifier') {
                    callee = node.callee.name;
                } else if (node.callee?.type === 'MemberExpression') {
                    callee = getMemberChain(node.callee);
                }

                if (callee) {
                    const calls = callGraph.get(currentFunction) || [];
                    if (!calls.includes(callee)) {
                        calls.push(callee);
                        callGraph.set(currentFunction, calls);
                    }

                    if (isLLMCall(callee)) {
                        const llm = llmCalls.get(currentFunction) || [];
                        llm.push({
                            callee,
                            line: node.loc?.start.line || 0,
                            isLLMCall: true
                        });
                        llmCalls.set(currentFunction, llm);
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

    return {
        filePath,
        functions,
        callGraph,
        llmCalls,
        imports,
        hash: createStructuralHash(functions, callGraph)
    };
}

/**
 * Extract call graph from Python
 */
function extractPython(code: string, filePath: string): ExtractedCallGraph {
    const functions = new Map<string, FunctionInfo>();
    const callGraph = new Map<string, string[]>();
    const llmCalls = new Map<string, CallInfo[]>();
    const imports: string[] = [];

    const lines = code.split('\n');
    let currentFunction = 'global';
    let currentIndent = 0;
    let functionStack: { name: string; indent: number }[] = [];
    let decorators: string[] = [];

    const funcDefPattern = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/;
    const decoratorPattern = /^(\s*)@(\w+(?:\.\w+)*)/;
    const importPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/;
    const callPattern = /(\w+(?:\.\w+)*)\s*\(/g;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const indent = line.search(/\S/);

        // Track decorators
        const decoratorMatch = line.match(decoratorPattern);
        if (decoratorMatch) {
            decorators.push(decoratorMatch[2]);
            continue;
        }

        // Track imports
        const importMatch = line.match(importPattern);
        if (importMatch) {
            const module = importMatch[1] || importMatch[2].split(',')[0].trim();
            imports.push(module);
            decorators = [];
            continue;
        }

        // Track function definitions
        const funcMatch = line.match(funcDefPattern);
        if (funcMatch) {
            const funcIndent = funcMatch[1].length;
            const funcName = funcMatch[2];
            const params = funcMatch[3].split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(p => p);

            // Pop functions that are no longer in scope
            while (functionStack.length > 0 && functionStack[functionStack.length - 1].indent >= funcIndent) {
                functionStack.pop();
            }

            functionStack.push({ name: funcName, indent: funcIndent });
            currentFunction = funcName;

            // Find end line (next function at same or lower indent, or EOF)
            let endLine = lines.length;
            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j];
                if (nextLine.trim() === '') continue;
                const nextIndent = nextLine.search(/\S/);
                if (nextIndent <= funcIndent && (nextLine.match(funcDefPattern) || nextLine.match(/^class\s/))) {
                    endLine = j;
                    break;
                }
            }

            functions.set(funcName, {
                name: funcName,
                startLine: lineNum,
                endLine: endLine,
                decorators: [...decorators],
                isAsync: line.includes('async def'),
                params
            });

            if (!callGraph.has(funcName)) {
                callGraph.set(funcName, []);
            }

            decorators = [];
            continue;
        }

        // Track function calls within current function
        if (indent === -1) continue; // Empty line

        // Update current function based on indent
        while (functionStack.length > 0 && indent <= functionStack[functionStack.length - 1].indent) {
            functionStack.pop();
        }
        currentFunction = functionStack.length > 0 ? functionStack[functionStack.length - 1].name : 'global';

        // Find all function calls in this line
        const callMatches = Array.from(line.matchAll(callPattern));
        for (const match of callMatches) {
            const callee = match[1];

            // Skip Python keywords and builtins that look like calls
            if ((KEYWORD_BLACKLISTS.python as readonly string[]).includes(callee)) {
                continue;
            }

            const calls = callGraph.get(currentFunction) || [];
            if (!calls.includes(callee)) {
                calls.push(callee);
                callGraph.set(currentFunction, calls);
            }

            if (isLLMCall(callee)) {
                const llm = llmCalls.get(currentFunction) || [];
                llm.push({
                    callee,
                    line: lineNum,
                    isLLMCall: true
                });
                llmCalls.set(currentFunction, llm);
            }
        }

        decorators = [];
    }

    return {
        filePath,
        functions,
        callGraph,
        llmCalls,
        imports,
        hash: createStructuralHash(functions, callGraph)
    };
}

/**
 * Get the full member expression chain (e.g., "client.chat.completions.create")
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
            // Handle chained calls like foo().bar()
            current = current.callee;
        } else {
            break;
        }
    }

    return parts.join('.');
}

/**
 * Main entry point: extract call graph from any supported file
 */
export function extractCallGraph(code: string, filePath: string): ExtractedCallGraph {
    if (filePath.endsWith('.py')) {
        return extractPython(code, filePath);
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
        return extractTypeScript(code, filePath);
    } else if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
        return extractJavaScript(code, filePath);
    }

    // Unsupported file type
    return {
        filePath,
        functions: new Map(),
        callGraph: new Map(),
        llmCalls: new Map(),
        imports: [],
        hash: '0'
    };
}

/**
 * Compute diff between two call graphs
 */
export interface CallGraphDiff {
    addedFunctions: string[];
    removedFunctions: string[];
    modifiedFunctions: string[];  // Functions whose calls changed
    addedEdges: { from: string; to: string }[];
    removedEdges: { from: string; to: string }[];
}

export function diffCallGraphs(
    oldGraph: ExtractedCallGraph,
    newGraph: ExtractedCallGraph
): CallGraphDiff {
    const addedFunctions: string[] = [];
    const removedFunctions: string[] = [];
    const modifiedFunctions: string[] = [];
    const addedEdges: { from: string; to: string }[] = [];
    const removedEdges: { from: string; to: string }[] = [];

    const oldFuncs = new Set(oldGraph.functions.keys());
    const newFuncs = new Set(newGraph.functions.keys());

    // Find added/removed functions
    for (const fn of newFuncs) {
        if (!oldFuncs.has(fn)) {
            addedFunctions.push(fn);
        }
    }

    for (const fn of oldFuncs) {
        if (!newFuncs.has(fn)) {
            removedFunctions.push(fn);
        }
    }

    // Find modified functions (different calls)
    for (const fn of newFuncs) {
        if (oldFuncs.has(fn)) {
            const oldCalls = new Set(oldGraph.callGraph.get(fn) || []);
            const newCalls = new Set(newGraph.callGraph.get(fn) || []);

            let modified = false;

            for (const call of newCalls) {
                if (!oldCalls.has(call)) {
                    addedEdges.push({ from: fn, to: call });
                    modified = true;
                }
            }

            for (const call of oldCalls) {
                if (!newCalls.has(call)) {
                    removedEdges.push({ from: fn, to: call });
                    modified = true;
                }
            }

            if (modified) {
                modifiedFunctions.push(fn);
            }
        }
    }

    return {
        addedFunctions,
        removedFunctions,
        modifiedFunctions,
        addedEdges,
        removedEdges
    };
}

/**
 * Check if structure has changed (quick hash comparison)
 */
export function hasStructureChanged(oldHash: string, newHash: string): boolean {
    return oldHash !== newHash;
}

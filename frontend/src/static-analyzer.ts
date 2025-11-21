import * as acorn from 'acorn';
import * as jsx from 'acorn-jsx';
const tsParser = require('@typescript-eslint/typescript-estree');

export interface CodeLocation {
    line: number;
    column: number;
    type: 'trigger' | 'llm' | 'tool' | 'decision' | 'integration' | 'memory' | 'parser' | 'output';
    description: string;
    function: string;
    variable?: string;
}

export interface FileAnalysis {
    filePath: string;
    locations: CodeLocation[];
    imports: string[];
    exports: string[];
    llmRelatedVariables: Set<string>;
}

export class StaticAnalyzer {
    /**
     * Parse file and extract LLM workflow locations
     */
    analyze(code: string, filePath: string): FileAnalysis {
        try {
            if (filePath.endsWith('.py')) {
                return this.analyzePython(code, filePath);
            } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
                return this.analyzeTypeScript(code, filePath);
            } else if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
                return this.analyzeJavaScript(code, filePath);
            } else {
                // Unsupported file type
                console.warn(`Unsupported file type for AST analysis: ${filePath}`);
                return {
                    filePath,
                    locations: [],
                    imports: [],
                    exports: [],
                    llmRelatedVariables: new Set()
                };
            }
        } catch (error) {
            console.error(`Failed to parse ${filePath}:`, error);
            if (error instanceof Error) {
                console.error(`Error details: ${error.message}`);
            }
            return {
                filePath,
                locations: [],
                imports: [],
                exports: [],
                llmRelatedVariables: new Set()
            };
        }
    }

    private analyzeJavaScript(code: string, filePath: string): FileAnalysis {
        try {
            const parser = acorn.Parser.extend(jsx.default());
            const ast = parser.parse(code, {
                ecmaVersion: 2020,
                sourceType: 'module',
                locations: true
            }) as any;

        const locations: CodeLocation[] = [];
        const imports: string[] = [];
        const exports: string[] = [];
        const llmRelatedVariables = new Set<string>();
        const seenLocations = new Set<string>(); // Track line+type to prevent duplicates
        let currentFunction = 'global';

        // Helper to check if identifier is LLM-related
        const isLLMIdentifier = (name: string): boolean => {
            const llmPatterns = [
                /openai/i, /anthropic/i, /gemini/i, /genai/i,
                /groq/i, /ollama/i, /cohere/i, /gpt/i, /claude/i,
                /llm/i, /model/i, /client/i, /chat/i, /completion/i
            ];
            return llmPatterns.some(pattern => pattern.test(name));
        };

        // Helper to add location without duplicates
        const addLocation = (loc: CodeLocation) => {
            const key = `${loc.line}-${loc.type}`;
            if (!seenLocations.has(key)) {
                seenLocations.add(key);
                locations.push(loc);
            }
        };

        // Walk the AST
        const walkNode = (node: any, parent?: any) => {
            if (!node) return;

            // Track current function context
            if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
                const funcName = node.id?.name || 'anonymous';
                const oldFunc = currentFunction;
                currentFunction = funcName;
                if (node.body) walkNode(node.body, node);
                currentFunction = oldFunc;
                return;
            }

            // Track imports
            if (node.type === 'ImportDeclaration') {
                const source = node.source.value;
                imports.push(source);

                // Track LLM client imports
                if (isLLMIdentifier(source)) {
                    node.specifiers?.forEach((spec: any) => {
                        const name = spec.local?.name || spec.imported?.name;
                        if (name) llmRelatedVariables.add(name);
                    });
                }
            }

            // Track exports
            if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
                const name = node.declaration?.id?.name || node.declaration?.name;
                if (name) exports.push(name);
            }

            // Track variable declarations
            if (node.type === 'VariableDeclaration') {
                node.declarations?.forEach((decl: any) => {
                    const varName = decl.id?.name;
                    const init = decl.init;

                    // Check if initializer is LLM-related
                    if (varName && init) {
                        if (init.type === 'NewExpression' && isLLMIdentifier(init.callee?.name || '')) {
                            llmRelatedVariables.add(varName);
                            addLocation({
                                line: node.loc.start.line,
                                column: node.loc.start.column,
                                type: 'llm',
                                description: `Initialize ${init.callee.name} client`,
                                function: currentFunction,
                                variable: varName
                            });
                        }
                    }
                });
            }

            // Track function/method calls
            if (node.type === 'CallExpression') {
                const callee = node.callee;
                let callDescription = '';
                let callType: CodeLocation['type'] | null = null;

                // LLM API calls
                if (callee.type === 'MemberExpression') {
                    const objName = callee.object?.name || '';
                    const propName = callee.property?.name || '';
                    const chain = this.getMemberExpressionChain(callee);

                    // Detect LLM API calls
                    if (chain.includes('chat.completions.create') || chain.includes('messages.create') || chain.includes('generate_content')) {
                        callType = 'llm';
                        callDescription = `${chain} call`;
                    }
                    // Detect JSON parsing
                    else if (propName === 'parse' && chain.includes('JSON')) {
                        callType = 'parser';
                        callDescription = 'Parse JSON response';
                    }
                    // Detect HTTP calls
                    else if (['fetch', 'axios', 'request', 'post', 'get'].includes(propName)) {
                        callType = 'integration';
                        callDescription = `HTTP ${propName}`;
                    }

                    if (callType && llmRelatedVariables.has(objName)) {
                        addLocation({
                            line: node.loc.start.line,
                            column: node.loc.start.column,
                            type: callType,
                            description: callDescription,
                            function: currentFunction
                        });
                    }
                }
            }

            // Track conditionals (decisions)
            if (node.type === 'IfStatement') {
                // Check if condition involves LLM-related variables
                const hasLLMVar = this.containsLLMVariable(node.test, llmRelatedVariables);
                if (hasLLMVar) {
                    locations.push({
                        line: node.loc.start.line,
                        column: node.loc.start.column,
                        type: 'decision',
                        description: 'Conditional on LLM output',
                        function: currentFunction
                    });
                }
            }

            // Track return statements (output)
            if (node.type === 'ReturnStatement') {
                const hasLLMVar = node.argument && this.containsLLMVariable(node.argument, llmRelatedVariables);
                if (hasLLMVar) {
                    locations.push({
                        line: node.loc.start.line,
                        column: node.loc.start.column,
                        type: 'output',
                        description: 'Return LLM result',
                        function: currentFunction
                    });
                }
            }

            // Recursively walk children
            for (const key in node) {
                if (key === 'loc' || key === 'range' || key === 'parent') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(c => walkNode(c, node));
                } else if (child && typeof child === 'object') {
                    walkNode(child, node);
                }
            }
        };

        walkNode(ast);

            return {
                filePath,
                locations,
                imports,
                exports,
                llmRelatedVariables
            };
        } catch (error) {
            if (error instanceof Error && error.message.includes('Unexpected token')) {
                console.warn(`⚠️  Skipping file with invalid JSX syntax: ${filePath}`);
                console.warn(`    ${error.message}`);
            } else {
                console.error(`Failed to analyze JavaScript for ${filePath}:`, error);
            }
            return {
                filePath,
                locations: [],
                imports: [],
                exports: [],
                llmRelatedVariables: new Set()
            };
        }
    }

    private getMemberExpressionChain(node: any): string {
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
            } else {
                break;
            }
        }

        return parts.join('.');
    }

    private containsLLMVariable(node: any, llmVars: Set<string>): boolean {
        if (!node) return false;

        if (node.type === 'Identifier' && llmVars.has(node.name)) {
            return true;
        }

        // Check children
        for (const key in node) {
            if (key === 'loc' || key === 'range') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                if (child.some(c => this.containsLLMVariable(c, llmVars))) return true;
            } else if (child && typeof child === 'object') {
                if (this.containsLLMVariable(child, llmVars)) return true;
            }
        }

        return false;
    }

    private analyzeTypeScript(code: string, filePath: string): FileAnalysis {
        try {
            // Enable JSX for .tsx and .jsx files
            const isJSX = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

            const ast = tsParser.parse(code, {
                loc: true,
                range: true,
                ecmaVersion: 2020,
                sourceType: 'module',
                jsx: isJSX
            });

            const locations: CodeLocation[] = [];
            const imports: string[] = [];
            const exports: string[] = [];
            const llmRelatedVariables = new Set<string>();
            const seenLocations = new Set<string>();
            let currentFunction = 'global';

            // Helper to check if identifier is LLM-related
            const isLLMIdentifier = (name: string): boolean => {
                const llmPatterns = [
                    /openai/i, /anthropic/i, /gemini/i, /genai/i,
                    /groq/i, /ollama/i, /cohere/i, /gpt/i, /claude/i,
                    /llm/i, /model/i, /client/i, /chat/i, /completion/i
                ];
                return llmPatterns.some(pattern => pattern.test(name));
            };

            // Helper to add location without duplicates
            const addLocation = (loc: CodeLocation) => {
                const key = `${loc.line}-${loc.type}`;
                if (!seenLocations.has(key)) {
                    seenLocations.add(key);
                    locations.push(loc);
                }
            };

            // Walk the AST (TypeScript AST is similar to ESTree)
            const walkNode = (node: any, parent?: any): void => {
                if (!node || typeof node !== 'object') return;

                // Track current function context
                if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression' ||
                    node.type === 'FunctionExpression' || node.type === 'MethodDefinition') {
                    const funcName = node.id?.name || node.key?.name || 'anonymous';
                    const oldFunc = currentFunction;
                    currentFunction = funcName;
                    if (node.body) walkNode(node.body, node);
                    currentFunction = oldFunc;
                    return;
                }

                // Track imports
                if (node.type === 'ImportDeclaration') {
                    const source = node.source?.value;
                    if (source) {
                        imports.push(source);

                        // Track LLM client imports
                        if (isLLMIdentifier(source)) {
                            node.specifiers?.forEach((spec: any) => {
                                const name = spec.local?.name || spec.imported?.name;
                                if (name) llmRelatedVariables.add(name);
                            });
                        }
                    }
                }

                // Track exports
                if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
                    const name = node.declaration?.id?.name || node.declaration?.name;
                    if (name) exports.push(name);
                }

                // Track variable declarations (LLM client initialization)
                if (node.type === 'VariableDeclaration') {
                    node.declarations?.forEach((decl: any) => {
                        const varName = decl.id?.name;
                        const init = decl.init;

                        if (varName && init) {
                            if (init.type === 'NewExpression' && isLLMIdentifier(init.callee?.name || '')) {
                                llmRelatedVariables.add(varName);
                                if (node.loc) {
                                    addLocation({
                                        line: node.loc.start.line,
                                        column: node.loc.start.column,
                                        type: 'llm',
                                        description: `Initialize ${init.callee.name} client`,
                                        function: currentFunction,
                                        variable: varName
                                    });
                                }
                            }
                        }
                    });
                }

                // Track call expressions (LLM API calls)
                if (node.type === 'CallExpression' || node.type === 'AwaitExpression') {
                    const callNode = node.type === 'AwaitExpression' ? node.argument : node;
                    if (callNode?.type === 'CallExpression') {
                        // Extract callee path (e.g., "client.chat.completions.create")
                        let callee = '';
                        if (callNode.callee?.type === 'Identifier') {
                            callee = callNode.callee.name;
                        } else if (callNode.callee?.type === 'MemberExpression') {
                            const parts: string[] = [];
                            let current = callNode.callee;
                            while (current) {
                                if (current.type === 'MemberExpression') {
                                    if (current.property?.name) parts.unshift(current.property.name);
                                    current = current.object;
                                } else if (current.type === 'Identifier') {
                                    parts.unshift(current.name);
                                    break;
                                } else {
                                    break;
                                }
                            }
                            callee = parts.join('.');
                        }

                        if (this.containsLLMVariable(callNode.callee, llmRelatedVariables) || isLLMIdentifier(callee)) {
                            if (callNode.loc) {
                                addLocation({
                                    line: callNode.loc.start.line,
                                    column: callNode.loc.start.column,
                                    type: 'llm',
                                    description: `Call ${callee}()`,
                                    function: currentFunction
                                });
                            }
                        }
                    }
                }

                // Track return statements
                if (node.type === 'ReturnStatement' && node.loc) {
                    addLocation({
                        line: node.loc.start.line,
                        column: node.loc.start.column,
                        type: 'output',
                        description: 'Return statement',
                        function: currentFunction
                    });
                }

                // Track if statements (decisions)
                if (node.type === 'IfStatement' && node.loc) {
                    addLocation({
                        line: node.loc.start.line,
                        column: node.loc.start.column,
                        type: 'decision',
                        description: 'Conditional logic',
                        function: currentFunction
                    });
                }

                // Walk children
                for (const key in node) {
                    if (key === 'loc' || key === 'range' || key === 'parent') continue;
                    const child = node[key];
                    if (Array.isArray(child)) {
                        child.forEach(c => walkNode(c, node));
                    } else if (child && typeof child === 'object') {
                        walkNode(child, node);
                    }
                }
            };

            walkNode(ast);

            return {
                filePath,
                locations,
                imports,
                exports,
                llmRelatedVariables
            };
        } catch (error) {
            console.error(`Failed to parse TypeScript ${filePath}:`, error);
            if (error instanceof Error) {
                console.error(`Error details: ${error.message}`);
            }
            return {
                filePath,
                locations: [],
                imports: [],
                exports: [],
                llmRelatedVariables: new Set()
            };
        }
    }

    private analyzePython(code: string, filePath: string): FileAnalysis {
        try {
            const locations: CodeLocation[] = [];
            const imports: string[] = [];
            const exports: string[] = [];
            const llmRelatedVariables = new Set<string>();
            const seenLocations = new Set<string>(); // Track line+type to prevent duplicates
            const functionsWithLLMCode = new Set<string>(); // Track which functions use LLM code
            const decoratorCandidates: CodeLocation[] = []; // Store decorator triggers to filter later

            const lines = code.split('\n');
            console.log(`[Python Analysis] Analyzing ${filePath} (${lines.length} lines)`);

            // Helper to check if identifier is LLM-related
            const isLLMIdentifier = (name: string): boolean => {
                const llmPatterns = [
                    /genai/i, /gemini/i, /openai/i, /anthropic/i,
                    /groq/i, /ollama/i, /cohere/i, /gpt/i, /claude/i,
                    /llm/i, /model/i, /client/i, /chat/i, /completion/i,
                    /GenerativeModel/i, /Gemini/i
                ];
                return llmPatterns.some(pattern => pattern.test(name));
            };

            // Helper to add location without duplicates
            const addLocation = (loc: CodeLocation) => {
                const key = `${loc.line}-${loc.type}`;
                if (!seenLocations.has(key)) {
                    seenLocations.add(key);
                    locations.push(loc);
                }
            };

            let currentFunction = 'global';

            // Regex patterns for Python
            const importPattern = /^(?:from\s+([\w.]+)\s+)?import\s+(.+)/;
            const funcDefPattern = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
            const decoratorPattern = /^(\s*)@(\w+)/;
            const assignPattern = /^(\s*)(\w+)\s*=\s*(.+)/;
            const callPattern = /(\w+)\.(\w+)\s*\(/g;
            const returnPattern = /^(\s*)return\s+(.+)/;
            const ifPattern = /^(\s*)if\s+(.+):/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNum = i + 1;

                // Track imports
                const importMatch = line.match(importPattern);
                if (importMatch) {
                    const module = importMatch[1];
                    const names = importMatch[2];

                    if (module) {
                        imports.push(module);
                        if (isLLMIdentifier(module)) {
                            const importedNames = names.split(',').map(n => {
                                const parts = n.trim().split(/\s+as\s+/);
                                return parts[parts.length - 1];
                            });
                            importedNames.forEach(name => llmRelatedVariables.add(name.trim()));
                        }
                    } else {
                        const importedNames = names.split(',').map(n => {
                            const parts = n.trim().split(/\s+as\s+/);
                            const importName = parts[0];
                            imports.push(importName);
                            if (isLLMIdentifier(importName)) {
                                return parts[parts.length - 1];
                            }
                            return null;
                        }).filter(n => n);
                        importedNames.forEach(name => llmRelatedVariables.add(name!));
                    }
                }

                // Track function definitions
                const funcMatch = line.match(funcDefPattern);
                if (funcMatch) {
                    currentFunction = funcMatch[2];

                    // Check previous line for decorators
                    if (i > 0) {
                        const prevLine = lines[i - 1];
                        const decoratorMatch = prevLine.match(decoratorPattern);
                        if (decoratorMatch) {
                            addLocation({
                                line: lineNum,
                                column: funcMatch[1].length,
                                type: 'trigger',
                                description: `@${decoratorMatch[2]} endpoint`,
                                function: currentFunction
                            });
                        }
                    }
                }

                // Track assignments
                const assignMatch = line.match(assignPattern);
                if (assignMatch) {
                    const varName = assignMatch[2];
                    const value = assignMatch[3];

                    if (isLLMIdentifier(value)) {
                        llmRelatedVariables.add(varName);
                        functionsWithLLMCode.add(currentFunction); // Mark function as using LLM
                        addLocation({
                            line: lineNum,
                            column: assignMatch[1].length,
                            type: 'llm',
                            description: `Initialize ${value.split('(')[0]}`,
                            function: currentFunction,
                            variable: varName
                        });
                    }
                }

                // Track function calls
                const callMatches = Array.from(line.matchAll(callPattern));
                for (const match of callMatches) {
                    const objName = match[1];
                    const methodName = match[2];

                    if (llmRelatedVariables.has(objName)) {
                        let callType: CodeLocation['type'] | null = null;
                        let description = '';

                        if (['generate_content', 'create', 'chat', 'complete'].includes(methodName)) {
                            callType = 'llm';
                            description = `${objName}.${methodName}() call`;
                        } else if (['parse', 'loads', 'json'].includes(methodName)) {
                            callType = 'parser';
                            description = 'Parse response';
                        } else if (['get', 'post', 'put', 'delete', 'request'].includes(methodName)) {
                            callType = 'integration';
                            description = `HTTP ${methodName}`;
                        }

                        if (callType) {
                            functionsWithLLMCode.add(currentFunction); // Mark function as using LLM
                            addLocation({
                                line: lineNum,
                                column: line.indexOf(objName),
                                type: callType,
                                description,
                                function: currentFunction
                            });
                        }
                    }
                }

                // Track conditionals
                const ifMatch = line.match(ifPattern);
                if (ifMatch) {
                    const condition = ifMatch[2];
                    const hasLLMVar = Array.from(llmRelatedVariables).some(v => condition.includes(v));
                    if (hasLLMVar) {
                        functionsWithLLMCode.add(currentFunction); // Mark function as using LLM
                        addLocation({
                            line: lineNum,
                            column: ifMatch[1].length,
                            type: 'decision',
                            description: 'Conditional on LLM output',
                            function: currentFunction
                        });
                    }
                }

                // Track returns
                const returnMatch = line.match(returnPattern);
                if (returnMatch) {
                    const returnValue = returnMatch[2];
                    const hasLLMVar = Array.from(llmRelatedVariables).some(v => returnValue.includes(v));
                    if (hasLLMVar) {
                        functionsWithLLMCode.add(currentFunction); // Mark function as using LLM
                        addLocation({
                            line: lineNum,
                            column: returnMatch[1].length,
                            type: 'output',
                            description: 'Return LLM result',
                            function: currentFunction
                        });
                    }
                }
            }

            // Filter locations: only keep triggers that are in LLM-related functions
            const filteredLocations = locations.filter(loc => {
                if (loc.type === 'trigger') {
                    return functionsWithLLMCode.has(loc.function);
                }
                return true; // Keep all non-trigger locations
            });

            console.log(`[Python Analysis] Found ${filteredLocations.length} locations (${locations.length - filteredLocations.length} filtered), ${llmRelatedVariables.size} LLM vars, ${imports.length} imports`);
            if (llmRelatedVariables.size > 0) {
                console.log(`[Python Analysis] LLM variables: ${Array.from(llmRelatedVariables).join(', ')}`);
            }
            console.log(`[Python Analysis] Functions with LLM code: ${Array.from(functionsWithLLMCode).join(', ')}`);

            return {
                filePath,
                locations: filteredLocations,
                imports,
                exports,
                llmRelatedVariables
            };
        } catch (error) {
            console.error(`Failed to analyze Python for ${filePath}:`, error);
            return {
                filePath,
                locations: [],
                imports: [],
                exports: [],
                llmRelatedVariables: new Set()
            };
        }
    }
}

export const staticAnalyzer = new StaticAnalyzer();

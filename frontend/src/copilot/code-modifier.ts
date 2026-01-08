import * as vscode from 'vscode';

/**
 * Handles code modifications requested via @codag chat participant
 */
export class CodeModifier {
    /**
     * Insert a new node between two existing nodes
     */
    async insertNodeBetween(
        beforeNodeFile: string,
        beforeNodeLine: number,
        afterNodeFile: string,
        afterNodeLine: number,
        newCode: string,
        description: string
    ): Promise<boolean> {
        try {
            const edit = new vscode.WorkspaceEdit();

            // Determine where to insert the new code
            // Strategy: Insert after the "before" node
            const uri = vscode.Uri.file(beforeNodeFile);
            const document = await vscode.workspace.openTextDocument(uri);

            // Find the end of the function containing the beforeNode
            const insertLine = await this.findInsertionPoint(document, beforeNodeLine);
            const insertPosition = new vscode.Position(insertLine, 0);

            // Format the code with proper indentation
            const indentation = this.getIndentation(document, beforeNodeLine);
            const formattedCode = this.formatCode(newCode, indentation);

            // Add a comment describing the purpose
            const comment = `${indentation}// ${description}\n`;
            const fullInsert = `\n${comment}${formattedCode}\n`;

            edit.insert(uri, insertPosition, fullInsert);

            // Show preview
            const applied = await this.applyWithPreview(edit, `Insert: ${description}`);
            return applied;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to insert node: ${error}`);
            return false;
        }
    }

    /**
     * Modify an existing node's implementation
     */
    async modifyNode(
        file: string,
        line: number,
        nodeLabel: string,
        modifications: string,
        description: string
    ): Promise<boolean> {
        try {
            const edit = new vscode.WorkspaceEdit();
            const uri = vscode.Uri.file(file);
            const document = await vscode.workspace.openTextDocument(uri);

            // Find the function at the given line
            const functionRange = await this.findFunctionRange(document, line);
            if (!functionRange) {
                vscode.window.showErrorMessage(`Could not find function at line ${line}`);
                return false;
            }

            // Get current function content
            const currentContent = document.getText(functionRange);

            // Apply modifications (this would ideally use an LLM to merge changes)
            // For now, append the modifications as a comment + code
            const indentation = this.getIndentation(document, line);
            const formattedMods = this.formatCode(modifications, indentation);
            const comment = `${indentation}// Modified: ${description}\n`;
            const newContent = currentContent.trimEnd() + `\n\n${comment}${formattedMods}`;

            edit.replace(uri, functionRange, newContent);

            // Show preview
            const applied = await this.applyWithPreview(edit, `Modify ${nodeLabel}: ${description}`);
            return applied;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to modify node: ${error}`);
            return false;
        }
    }

    /**
     * Apply workspace edit with diff preview
     */
    private async applyWithPreview(edit: vscode.WorkspaceEdit, label: string): Promise<boolean> {
        // Show diff preview first
        const choice = await vscode.window.showInformationMessage(
            `Ready to apply: ${label}`,
            { modal: true },
            'Apply',
            'Preview Diff',
            'Cancel'
        );

        if (choice === 'Cancel' || !choice) {
            return false;
        }

        if (choice === 'Preview Diff') {
            // Show diff editor for first change
            const entries = edit.entries();
            if (entries.length > 0) {
                const [uri, edits] = entries[0];
                const document = await vscode.workspace.openTextDocument(uri);

                // Create a temp document with changes applied
                const tempContent = this.applyEditsToText(document.getText(), edits);
                const tempUri = uri.with({ scheme: 'untitled', path: uri.path + '.preview' });

                await vscode.commands.executeCommand('vscode.diff', uri, tempUri, `${label} (Preview)`);

                // Ask again after preview
                const applyChoice = await vscode.window.showInformationMessage(
                    'Apply these changes?',
                    { modal: true },
                    'Apply',
                    'Cancel'
                );

                if (applyChoice !== 'Apply') {
                    return false;
                }
            }
        }

        // Apply the edit
        const success = await vscode.workspace.applyEdit(edit);

        if (success) {
            vscode.window.showInformationMessage(`✓ ${label} applied successfully`);
        } else {
            vscode.window.showErrorMessage(`Failed to apply: ${label}`);
        }

        return success;
    }

    /**
     * Find the best insertion point after a given line
     */
    private async findInsertionPoint(document: vscode.TextDocument, line: number): Promise<number> {
        // Look for the end of the current function/block
        let insertLine = line;
        let braceCount = 0;
        let foundOpenBrace = false;

        for (let i = line; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;

            for (const char of lineText) {
                if (char === '{') {
                    braceCount++;
                    foundOpenBrace = true;
                } else if (char === '}') {
                    braceCount--;
                    if (foundOpenBrace && braceCount === 0) {
                        // Found the end of the function
                        return i;
                    }
                }
            }
        }

        // Fallback: insert after current line
        return line + 1;
    }

    /**
     * Find the range of a function at the given line
     */
    private async findFunctionRange(document: vscode.TextDocument, line: number): Promise<vscode.Range | null> {
        // Find function start (look backwards for function keyword)
        let startLine = line;
        for (let i = line; i >= 0; i--) {
            const text = document.lineAt(i).text;
            if (text.match(/^\s*(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*async\s+\w+\s*\(/)) {
                startLine = i;
                break;
            }
        }

        // Find function end (matching braces)
        let braceCount = 0;
        let foundOpenBrace = false;
        let endLine = line;

        for (let i = startLine; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;

            for (const char of lineText) {
                if (char === '{') {
                    braceCount++;
                    foundOpenBrace = true;
                } else if (char === '}') {
                    braceCount--;
                    if (foundOpenBrace && braceCount === 0) {
                        endLine = i;
                        return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
                    }
                }
            }
        }

        return null;
    }

    /**
     * Get indentation at a given line
     */
    private getIndentation(document: vscode.TextDocument, line: number): string {
        const lineText = document.lineAt(line).text;
        const match = lineText.match(/^(\s*)/);
        return match ? match[1] : '';
    }

    /**
     * Format code with proper indentation
     */
    private formatCode(code: string, baseIndentation: string): string {
        const lines = code.split('\n');
        return lines.map(line => {
            if (line.trim() === '') return '';
            return baseIndentation + line;
        }).join('\n');
    }

    /**
     * Apply text edits to a string (for preview)
     */
    private applyEditsToText(text: string, edits: readonly vscode.TextEdit[]): string {
        // Sort edits in reverse order to apply from end to start
        const sortedEdits = [...edits].sort((a, b) => b.range.start.compareTo(a.range.start));

        let result = text;
        const lines = result.split('\n');

        for (const edit of sortedEdits) {
            const startLine = edit.range.start.line;
            const startChar = edit.range.start.character;
            const endLine = edit.range.end.line;
            const endChar = edit.range.end.character;

            // Handle multi-line edits
            if (startLine === endLine) {
                const line = lines[startLine];
                lines[startLine] = line.substring(0, startChar) + edit.newText + line.substring(endChar);
            } else {
                const firstLine = lines[startLine].substring(0, startChar);
                const lastLine = lines[endLine].substring(endChar);
                const newLines = edit.newText.split('\n');

                lines.splice(startLine, endLine - startLine + 1,
                    firstLine + newLines[0],
                    ...newLines.slice(1, -1),
                    newLines[newLines.length - 1] + lastLine
                );
            }
        }

        return lines.join('\n');
    }
}

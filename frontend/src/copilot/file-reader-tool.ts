import * as vscode from 'vscode';

interface FileReaderInput {
    filePath: string;
    lineStart?: number;
    lineEnd?: number;
}

/**
 * Language Model Tool for reading file contents
 * Allows the LLM to request specific file content when needed
 */
class FileReaderTool implements vscode.LanguageModelTool<FileReaderInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FileReaderInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;

        try {
            console.log(`[@codag-file-reader] Reading file: ${input.filePath}`);

            const uri = vscode.Uri.file(input.filePath);
            const document = await vscode.workspace.openTextDocument(uri);

            let content: string;

            if (input.lineStart !== undefined || input.lineEnd !== undefined) {
                // Read specific line range
                const startLine = Math.max(0, (input.lineStart || 1) - 1);
                const endLine = Math.min(document.lineCount - 1, (input.lineEnd || document.lineCount) - 1);

                const lines: string[] = [];
                for (let i = startLine; i <= endLine; i++) {
                    lines.push(`${i + 1}: ${document.lineAt(i).text}`);
                }
                content = lines.join('\n');
            } else {
                // Read entire file
                content = document.getText();
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`File: ${input.filePath}\n\n${content}`)
            ]);
        } catch (error: any) {
            console.error(`[@codag-file-reader] Error reading file:`, error);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error reading file ${input.filePath}: ${error.message}`)
            ]);
        }
    }
}

export function registerFileReaderTool(): vscode.Disposable | null {
    try {
        // Check if Language Model Tool API is available
        if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
            console.warn('Language Model Tool API not available');
            return null;
        }

        const tool = new FileReaderTool();
        const disposable = vscode.lm.registerTool('workflow-file-reader', tool);
        console.log('✅ Registered workflow-file-reader tool');
        return disposable;
    } catch (error) {
        console.error('❌ Failed to register file reader tool:', error);
        return null;
    }
}

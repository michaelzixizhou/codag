import * as vscode from 'vscode';
import { staticAnalyzer, FileAnalysis, CodeLocation } from './static-analyzer';

export interface FileMetadata {
    file: string;
    locations: LocationMetadata[];
    relatedFiles: string[];
}

export interface LocationMetadata {
    line: number;
    type: string;
    description: string;
    function: string;
    variable?: string;
}

export class MetadataBuilder {
    /**
     * Build metadata for all workflow files
     * Includes cross-file dependency tracking
     */
    async buildMetadata(workflowFiles: vscode.Uri[]): Promise<FileMetadata[]> {
        console.log(`\n🔍 buildMetadata: Starting analysis of ${workflowFiles.length} files`);
        const analyses: Map<string, FileAnalysis> = new Map();

        // First pass: Analyze all files
        let fileIndex = 0;
        for (const uri of workflowFiles) {
            fileIndex++;
            try {
                console.log(`\n📝 [${fileIndex}/${workflowFiles.length}] Analyzing: ${uri.fsPath}`);
                const content = await vscode.workspace.fs.readFile(uri);
                const code = Buffer.from(content).toString('utf8');
                const analysis = staticAnalyzer.analyze(code, uri.fsPath);
                analyses.set(uri.fsPath, analysis);
                console.log(`✓ [${fileIndex}/${workflowFiles.length}] Analyzed: ${uri.fsPath} (${analysis.locations.length} locations)`);
            } catch (error) {
                console.warn(`⚠️  [${fileIndex}/${workflowFiles.length}] Skipping file (analysis error): ${uri.fsPath}`, error);
            }
        }

        console.log(`\n✅ buildMetadata: Completed first pass, analyzed ${analyses.size} files successfully`);

        // Second pass: Build dependency graph
        console.log(`\n🔗 buildMetadata: Starting second pass (dependency graph)`);
        const metadata: FileMetadata[] = [];
        for (const [filePath, analysis] of analyses.entries()) {
            const relatedFiles = this.findRelatedFiles(analysis, analyses);

            // Deduplicate locations by line+type
            const uniqueLocations = this.deduplicateLocations(analysis.locations);

            metadata.push({
                file: filePath,
                locations: uniqueLocations.map(loc => ({
                    line: loc.line,
                    type: loc.type,
                    description: loc.description,
                    function: loc.function,
                    variable: loc.variable
                })),
                relatedFiles
            });
        }

        console.log(`\n✅ buildMetadata: Completed! Returning metadata for ${metadata.length} files`);
        return metadata;
    }

    /**
     * Find files related through imports/exports
     */
    private findRelatedFiles(
        analysis: FileAnalysis,
        allAnalyses: Map<string, FileAnalysis>
    ): string[] {
        const related = new Set<string>();

        // Check imports - find files that export what we import
        for (const importPath of analysis.imports) {
            for (const [filePath, otherAnalysis] of allAnalyses.entries()) {
                if (filePath === analysis.filePath) continue;

                // Match by relative import path or file name
                if (filePath.includes(importPath) || importPath.includes(filePath.split('/').pop() || '')) {
                    related.add(filePath);
                }
            }
        }

        // Check exports - find files that import from us
        if (analysis.exports.length > 0) {
            for (const [filePath, otherAnalysis] of allAnalyses.entries()) {
                if (filePath === analysis.filePath) continue;

                // If other file imports something we export
                const ourFileName = analysis.filePath.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '');
                if (ourFileName && otherAnalysis.imports.some(imp => imp.includes(ourFileName))) {
                    related.add(filePath);
                }
            }
        }

        return Array.from(related);
    }

    /**
     * Build metadata for a single file
     */
    async buildSingleFileMetadata(uri: vscode.Uri): Promise<FileMetadata> {
        try {
            const content = await vscode.workspace.fs.readFile(uri);
            const code = Buffer.from(content).toString('utf8');
            const analysis = staticAnalyzer.analyze(code, uri.fsPath);

            // Deduplicate locations by line+type
            const uniqueLocations = this.deduplicateLocations(analysis.locations);

            return {
                file: uri.fsPath,
                locations: uniqueLocations.map(loc => ({
                    line: loc.line,
                    type: loc.type,
                    description: loc.description,
                    function: loc.function,
                    variable: loc.variable
                })),
                relatedFiles: []
            };
        } catch (error) {
            console.warn(`⚠️  Error building metadata for ${uri.fsPath}, returning empty metadata:`, error);
            return {
                file: uri.fsPath,
                locations: [],
                relatedFiles: []
            };
        }
    }

    /**
     * Deduplicate locations by (line, type) key
     * Keeps first occurrence of each unique location
     */
    private deduplicateLocations(locations: CodeLocation[]): CodeLocation[] {
        const seen = new Map<string, CodeLocation>();

        for (const loc of locations) {
            const key = `${loc.line}-${loc.type}`;
            if (!seen.has(key)) {
                seen.set(key, loc);
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Enhance code with location markers for Gemini
     */
    addLocationMarkers(code: string, metadata: FileMetadata): string {
        const lines = code.split('\n');
        const result: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const lineNum = i + 1;
            const location = metadata.locations.find(loc => loc.line === lineNum);

            if (location) {
                result.push(`/* [${location.type.toUpperCase()}] ${location.description} in ${location.function}() */`);
            }

            result.push(lines[i]);
        }

        return result.join('\n');
    }
}

export const metadataBuilder = new MetadataBuilder();

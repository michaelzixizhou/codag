/**
 * Cost tracking utilities for LLM API usage
 */
import * as vscode from 'vscode';
import { CostOperation, CostReport, TokenUsage, CostData } from './types';
import { CONFIG } from './config';

/**
 * Estimate tokens for a string (rough approximation: 1 token ≈ 4 chars)
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Calculate cost for Gemini 2.5 Flash based on input/output tokens
 */
export function calculateCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * CONFIG.PRICING.INPUT_PER_1M;
    const outputCost = (outputTokens / 1_000_000) * CONFIG.PRICING.OUTPUT_PER_1M;
    return inputCost + outputCost;
}

/**
 * Format cost as a string with appropriate precision
 */
export function formatCost(cost: number): string {
    if (cost < 0.01) {
        return `$${cost.toFixed(4)}`;
    }
    return `$${cost.toFixed(2)}`;
}

/**
 * Cost aggregator for tracking LLM costs across an analysis run
 */
export class CostAggregator {
    private operations: CostOperation[] = [];
    private startTime: number = 0;

    start(): void {
        this.operations = [];
        this.startTime = Date.now();
    }

    add(
        type: CostOperation['type'],
        fileCount: number,
        usage?: TokenUsage,
        cost?: CostData,
        batchIndex?: number
    ): void {
        if (!usage || !cost) return;
        this.operations.push({
            type,
            batch_index: batchIndex,
            file_count: fileCount,
            usage,
            cost,
            timestamp: Date.now()
        });
    }

    getReport(): CostReport {
        const totals = this.operations.reduce(
            (acc, op) => ({
                input_tokens: acc.input_tokens + op.usage.input_tokens,
                output_tokens: acc.output_tokens + op.usage.output_tokens,
                total_tokens: acc.total_tokens + op.usage.total_tokens,
                total_cost: acc.total_cost + op.cost.total_cost
            }),
            { input_tokens: 0, output_tokens: 0, total_tokens: 0, total_cost: 0 }
        );

        return {
            operations: this.operations,
            totals,
            duration_ms: Date.now() - this.startTime
        };
    }

    hasOperations(): boolean {
        return this.operations.length > 0;
    }
}

/**
 * Display a detailed cost report in the output channel
 */
export function displayCostReport(report: CostReport, log: (msg: string) => void): void {
    log('');
    log('=== COST REPORT ===');
    log(`Duration: ${(report.duration_ms / 1000).toFixed(1)}s`);
    log(`Operations: ${report.operations.length}`);
    log('');

    if (report.operations.length > 0) {
        log('Breakdown:');
        for (const op of report.operations) {
            const label = op.batch_index !== undefined
                ? `[batch ${op.batch_index + 1}]`
                : `[${op.type}]`;
            const tokens = `${op.usage.input_tokens.toLocaleString()} in / ${op.usage.output_tokens.toLocaleString()} out`;
            log(`  ${label.padEnd(12)} ${tokens} = ${formatCost(op.cost.total_cost)}`);
        }
        log('');
    }

    log('Totals:');
    log(`  Input:  ${report.totals.input_tokens.toLocaleString()} tokens`);
    log(`  Output: ${report.totals.output_tokens.toLocaleString()} tokens`);
    log(`  Total:  ${report.totals.total_tokens.toLocaleString()} tokens`);
    log('');
    log(`TOTAL COST: ${formatCost(report.totals.total_cost)}`);
    log('===================');
    log('');
}

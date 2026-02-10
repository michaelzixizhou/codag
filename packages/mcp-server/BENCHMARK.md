# Codag MCP Benchmark

**Date:** 2026-02-08
**Model:** claude-sonnet-4-5 (both conditions)
**Repo:** LangChain (319K LOC)
**Method:** `claude -p` in isolated git worktrees, `--dangerously-skip-permissions`, no budget cap

---

## Results

8 tasks (4 simple, 4 complex) run with and without MCP.

### Velocity

| # | Task | Category | No MCP | MCP | Speedup |
|---|------|----------|--------|-----|---------|
| s1 | XmlOutputParser | simple | 274s / 45t / $1.74 | 337s / 48t / $2.19 | 0.81x |
| s2 | Rate limiter parallel calls | simple | 283s / 45t / $1.73 | 245s / 32t / $1.13 | 1.15x |
| s3 | Deduplicate messages | simple | 215s / 40t / $1.37 | 203s / 32t / $1.17 | 1.06x |
| s4 | Pydantic streaming | simple | 272s / 36t / $1.59 | 164s / 29t / $1.03 | 1.66x |
| c1 | Cross-provider fallback | complex | 1900s / 68t / $3.77 | 361s / 48t / $2.56 | **5.26x** |
| c2 | RetryAnalyzer | complex | 1894s / 62t / $2.89 | 782s / 51t / $2.34 | 2.42x |
| c3 | PromptOptimizer | complex | 593s / 62t / $2.63 | 488s / 64t / $2.72 | 1.22x |
| c4 | WorkflowGraphTracer | complex | 564s / 60t / $2.16 | 307s / 36t / $1.73 | 1.84x |

### Aggregates

| Metric | No MCP | MCP | Delta |
|--------|--------|-----|-------|
| Total turns | 418 | 340 | **-19%** |
| Total cost | $17.88 | $14.87 | **-17%** |
| Total time | 5995s | 2887s | **-52%** |
| Avg turns | 52.3 | 42.5 | -19% |
| Avg cost | $2.24 | $1.86 | -17% |
| Avg time | 749s | 361s | -52% |

### Quality

Scored on task-specific rubrics (percentage of criteria met).

| Metric | No MCP | MCP |
|--------|--------|-----|
| Avg quality | 86.9% | 87.6% |
| MCP wins | 4/8 | 4/8 |

Quality is tied — MCP does not degrade code quality while being significantly faster and cheaper.

---

## Key Findings

1. **MCP shines on complex, cross-cutting tasks.** The biggest wins (c1: 5.26x, c2: 2.42x, c4: 1.84x) are tasks requiring understanding of how files connect across the codebase. The agent gets relevant files and data flow immediately instead of exploring blindly.

2. **Simple tasks show modest gains.** For single-file tasks (s1-s4), MCP adds slight overhead on some (s1) but speeds up others (s4: 1.66x) — net positive.

3. **Time savings come from fewer dead-end explorations.** The no-MCP agent on c1 and c2 spent 30+ minutes each, largely exploring unrelated files. MCP-guided agents went directly to the right code.

4. **Cost savings track turn reduction.** Fewer turns = less input token repetition = lower cost. The 19% turn reduction maps to 17% cost savings.

5. **Quality is maintained.** The "questions to consider" framing prevents the agent from over-relying on the graph. It still explores non-LLM files (tests, configs, partner packages) on its own.

---

## Methodology

- Each task run in an isolated git worktree (clean langchain checkout)
- `claude -p "<prompt>" --model sonnet --dangerously-skip-permissions --output-format json`
- MCP condition: server configured via `--mcp-config` pointing to codag MCP server
- No-MCP condition: no MCP servers configured
- All prompts prefixed with "Do not enter plan mode. Write code directly."
- Quality scored by a separate evaluation agent against task-specific rubrics

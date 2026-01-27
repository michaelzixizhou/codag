# Real-Time Scaffolding Feature Plan

## Goal
Make Codag the visual component of vibecoding - instant graph updates as AI agents scaffold/modify code.

## Current Blockers
1. `isCached` check - new files ignored until first LLM analysis
2. 500ms debounce adds latency
3. Requires prior cached call graph to diff against
4. No way to create nodes from scratch without LLM

## Architecture: Local-First Graph Building

```
File Created/Changed
       ↓
  Tree-sitter extract (instant)
       ↓
  Build graph structure locally
  (functions → nodes, calls → edges)
       ↓
  Show immediately with function names as labels
       ↓
  Queue for LLM metadata (background)
       ↓
  Hydrate labels/descriptions when ready
```

## Implementation Steps

### Phase 1: Instant Node Creation from New Files
- [ ] Remove `isCached` gate in `handler.ts` for file creation events
- [ ] Add `buildGraphFromCallGraph()` function in new `graph-builder.ts`
- [ ] Convert call graph functions to workflow nodes directly
- [ ] Detect LLM calls → set node type to "llm", otherwise "step"
- [ ] Create edges from function calls within same file

### Phase 2: Cross-File Edge Detection
- [ ] Use existing `extractRepoStructure()` for import/export analysis
- [ ] Match function calls to exported functions in other files
- [ ] Create cross-file edges without LLM

### Phase 3: Visual States for Pending Nodes
- [ ] Add "pending" CSS class for nodes awaiting LLM metadata
- [ ] Subtle visual indicator (dotted border, slight opacity)
- [ ] Remove pending state when labels hydrated

### Phase 4: Optimized Debouncing
- [ ] Reduce debounce for creation events: 100ms
- [ ] Keep 300-500ms for modification events
- [ ] Batch rapid file creates into single metadata request

### Phase 5: Streaming Updates to Webview
- [ ] Send incremental node/edge additions (not full graph replace)
- [ ] Animate node appearance (fade in, scale up)
- [ ] Smooth edge drawing animation

## Node Creation from Call Graph

```typescript
// Input: extractCallGraph result
{
  name: "handleAuth",
  line: 45,
  calls: ["validateToken", "createSession"],
  hasLlmCall: true
}

// Output: workflow node
{
  id: "auth.ts:handleAuth",
  label: "handleAuth()", // placeholder until LLM
  type: "llm", // detected from hasLlmCall
  source: { file: "auth.ts", line: 45, function: "handleAuth" }
}
```

## Visual States

| State | Border | Meaning |
|-------|--------|---------|
| Active | Animated green | Currently being edited |
| Pending | Dotted/dim | Awaiting LLM metadata |
| Changed | Static green | Recently modified |
| Normal | Default | Fully hydrated |

## Files to Modify/Create

- `frontend/src/graph-builder.ts` - NEW: build graph from call graph
- `frontend/src/file-watching/handler.ts` - remove isCached gate, adjust debounce
- `frontend/src/webview-client/nodes.ts` - add pending visual state
- `frontend/src/webview/styles.ts` - pending node CSS
- `frontend/src/metadata-batcher.ts` - batch creation events aggressively

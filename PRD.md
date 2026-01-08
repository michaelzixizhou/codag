# PRD: Codag Launch Refinements

## Vision
Visual component for vibe coding. Show where agents are working in real-time.

---

## Tasks

### 1. Live File Change Detection
**Goal**: Detect and visualize file changes as they happen (agent or human)

- [ ] Implement merkle tree for workspace file state
  - Hash file contents on initial load
  - Detect changes by comparing hashes
  - Efficient: only rehash changed files
- [ ] Watch files via `vscode.workspace.onDidChangeTextDocument`
- [ ] Highlight nodes when their source file changes
  - Pulse/glow animation
  - Fade after ~5 seconds
- [ ] "Agent likely active" indicator when multiple files change rapidly

### 2. Notifications & Progress
**Goal**: More verbose, streamed, animated updates during analysis

- [ ] Stream analysis progress (not just start/end)
  - "Analyzing file 1/5..."
  - "Extracting nodes..."
  - "Building graph..."
- [ ] Animated notification UI
  - Progress bar or spinner
  - Smooth transitions between states
- [ ] Show incremental results as they come in
- [ ] Better error states with recovery suggestions

### 3. Multi-level Visualization
**Goal**: Smooth, seamless workflow expand/collapse with scroll integration

- [ ] Auto-expand on scroll
  - When user scrolls/zooms into a collapsed workflow, auto-expand it
  - Threshold: expand when workflow takes up >X% of viewport
- [ ] Auto-collapse on scroll out
  - Collapse workflows that leave viewport (optional)
- [ ] Toggle: Auto mode vs Manual mode
  - Auto: expand/collapse based on zoom/scroll
  - Manual: user controls all expand/collapse
- [ ] Smooth expand/collapse animations
  - Animate node positions
  - Fade in/out edges
- [ ] Breadcrumb trail for deep nesting

### 4. Git Diff Integration
**Goal**: Show what changed since last commit

- [ ] Get changed files: `git diff --name-status HEAD`
- [ ] Color-code nodes by status:
  - Green outline = added
  - Yellow outline = modified
  - Red outline = deleted
- [ ] Toggle button in HUD: "Show Git Changes"
- [ ] Side panel: show diff preview when clicking modified node

### 5. Auth & Trial System
**Goal**: Complete OAuth flow and trial tracking

- [ ] Fix OAuth callback handling
- [ ] Trial tag in header: "TRIAL 3/5"
- [ ] Auth panel UI polish
- [ ] Token refresh handling
- [ ] Device linking after OAuth

---

## Priority Order

1. **Notifications & Progress** - Low effort, high UX impact
2. **Multi-level Visualization** - Core to the experience
3. **Live File Change Detection** - The "agent visibility" feature
4. **Git Diff Integration** - Nice to have for launch
5. **Auth** - Required for monetization

---

## Files to Touch

| Area | Files |
|------|-------|
| File watching | `extension.ts`, new `file-watcher.ts` |
| Merkle tree | new `merkle.ts` |
| Notifications | `extension.ts`, `messages.ts`, `styles.css` |
| Multi-level | `visibility.ts`, `layout.ts`, `controls.ts`, `state.ts` |
| Git diff | new `git.ts`, `nodes.ts`, `state.ts` |
| Auth | `auth.ts`, `webview-client/auth.ts`, `api.ts` |

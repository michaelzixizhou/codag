# Webview Static Files Refactoring

**Status:** Ready to implement
**Approach:** Static files (HTML/CSS/compiled JS)

## Target Structure

```
frontend/
├── media/webview/
│   ├── index.html          # Static HTML template
│   └── styles.css          # Static CSS
├── src/
│   ├── webview.ts          # Extension-side only (~250 lines)
│   └── webview-client/     # Client-side TypeScript
│       ├── main.ts         # Entry point
│       ├── types.ts        # Type declarations (d3, dagre, vscode)
│       ├── state.ts        # Shared state (svg, g, zoom, etc.)
│       ├── setup.ts        # SVG/defs/patterns/zoom
│       ├── layout.ts       # Workflow stacking
│       ├── groups.ts       # Group rendering
│       ├── nodes.ts        # Node rendering
│       ├── edges.ts        # Edge rendering
│       ├── drag.ts         # Drag handlers
│       ├── minimap.ts      # Minimap
│       ├── panel.ts        # Side panel
│       ├── controls.ts     # HUD controls
│       ├── incremental.ts  # Incremental updates
│       └── messages.ts     # Message handler
└── tsconfig.webview.json   # Separate TS config for webview
```

---

## Phase 1: Create Static HTML

1. **Create `frontend/media/webview/index.html`**
   - Extract from `template.ts`
   - Use placeholders: `{{nonce}}`, `{{cspSource}}`, `{{stylesUri}}`, `{{scriptUri}}`, `{{graphData}}`
   - Keep D3/Dagre CDN links

2. **Update `webview.ts` getHtml():**
   ```typescript
   private getHtml(graph: WorkflowGraph): string {
       const htmlPath = vscode.Uri.joinPath(
           this.context.extensionUri, 'media', 'webview', 'index.html'
       );
       let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

       const stylesUri = this.panel!.webview.asWebviewUri(
           vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'styles.css')
       );
       const scriptUri = this.panel!.webview.asWebviewUri(
           vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-client', 'main.js')
       );
       const nonce = this.getNonce();

       html = html
           .replace(/{{nonce}}/g, nonce)
           .replace(/{{cspSource}}/g, this.panel!.webview.cspSource)
           .replace(/{{stylesUri}}/g, stylesUri.toString())
           .replace(/{{scriptUri}}/g, scriptUri.toString())
           .replace(/{{graphData}}/g, JSON.stringify(graph));

       return html;
   }
   ```

3. **Update webview panel localResourceRoots:**
   ```typescript
   localResourceRoots: [
       vscode.Uri.joinPath(this.context.extensionUri, 'media'),
       vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview-client')
   ]
   ```

4. **Test:** Verify webview loads

5. **Delete:** `frontend/src/webview/template.ts`

---

## Phase 2: Create Static CSS

1. **Create `frontend/media/webview/styles.css`**
   - Extract from `styles.ts`
   - Remove template string wrapping
   - VSCode CSS variables work in webviews

2. **Update `index.html`:**
   ```html
   <link rel="stylesheet" href="{{stylesUri}}">
   ```

3. **Test:** Verify styling renders

4. **Delete:** `frontend/src/webview/styles.ts`

---

## Phase 3: Create webview-client TypeScript

### 3.1 Create tsconfig.webview.json

```json
{
  "compilerOptions": {
    "outDir": "out/webview-client",
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020", "DOM"],
    "strict": false,
    "skipLibCheck": true,
    "moduleResolution": "node"
  },
  "include": ["src/webview-client/**/*"]
}
```

### 3.2 Create type declarations (types.ts)

```typescript
declare const d3: any;
declare const dagre: any;
declare const acquireVsCodeApi: () => any;

interface Window {
  __GRAPH_DATA__: any;
}
```

### 3.3 Create shared state (state.ts)

```typescript
// Global state shared across modules
export let vscode: any;
export let svg: any;
export let g: any;
export let zoom: any;
export let currentGraphData: any;
export let workflowGroups: any[];
// ... etc

export function initState(vs: any, s: any, grp: any, z: any) {
  vscode = vs;
  svg = s;
  g = grp;
  zoom = z;
}
```

### 3.4 Create main.ts (entry point)

```typescript
import './types';
import { initState } from './state';
import { setupSVG } from './setup';
import { renderGraph } from './layout';
// ... other imports

const vscode = acquireVsCodeApi();
const graphData = window.__GRAPH_DATA__;

// Initialize and render
const { svg, g, zoom } = setupSVG();
initState(vscode, svg, g, zoom);
renderGraph(graphData);
```

### 3.5 Extract each module

Move functions from `webview.ts` mainRendererScript to separate files:
- `setup.ts` - SVG setup, defs, patterns, zoom behavior
- `layout.ts` - Dagre layout, workflow stacking
- `groups.ts` - Group rendering, expand/collapse
- `nodes.ts` - Node rendering, icons
- `edges.ts` - Edge paths, labels, hover
- `drag.ts` - Drag handlers
- `minimap.ts` - Minimap rendering
- `panel.ts` - Side panel
- `controls.ts` - HUD controls
- `incremental.ts` - Incremental graph updates
- `messages.ts` - VSCode message handling

Each file exports functions, imports from `state.ts` for shared variables.

---

## Phase 4: Update build process

### package.json scripts

```json
{
  "compile": "tsc -p ./ && tsc -p tsconfig.webview.json",
  "watch": "concurrently \"tsc -w -p ./\" \"tsc -w -p tsconfig.webview.json\""
}
```

### Verify output

- `out/extension.js` (extension code)
- `out/webview-client/main.js` (webview entry)
- `out/webview-client/*.js` (modules)

---

## Phase 5: Cleanup

Delete obsolete files:
- `webview/template.ts`
- `webview/styles.ts`
- `webview/script-loader.ts`
- `webview/scripts/*` (moved to webview-client)

---

## Execution Order

1. **Phase 1 (HTML)** - test loads
2. **Phase 2 (CSS)** - test styled
3. **Phase 3 (JS)** - extract incrementally, test after each module
4. **Phase 4 (build)** - verify both configs work
5. **Phase 5 (cleanup)** - remove old files

---

## Verification Checklist

- [ ] Webview panel opens without errors
- [ ] Graph visualization renders
- [ ] Nodes are draggable
- [ ] Edges have hover effects
- [ ] Side panel opens on node click
- [ ] Code navigation works
- [ ] Minimap renders
- [ ] HUD controls function
- [ ] Incremental updates work
- [ ] Both `tsc` commands succeed
- [ ] No console errors

---

## Rollback

If anything breaks, revert to previous commit. All changes isolated to:
- `media/webview/`
- `src/webview-client/`
- `tsconfig.webview.json`
- `package.json` scripts

---

## Benefits

- **~250 line webview.ts** instead of ~2900 lines
- Real HTML/CSS files with IDE support
- Separate TypeScript modules for each concern
- Easier debugging with source maps
- Standard web dev workflow

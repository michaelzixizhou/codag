"""Parse Mermaid+Metadata format into WorkflowGraph."""

import re
import yaml
from typing import List, Dict, Any, Tuple, Optional
from models import (
    WorkflowGraph, GraphNode, GraphEdge, SourceLocation,
    WorkflowMetadata
)


def strip_markdown(text: str) -> str:
    """Remove markdown code block wrappers from text.

    Handles: ```mermaid, ```yaml, ```, and variations.
    """
    text = text.strip()

    # Remove leading code block markers
    if text.startswith("```"):
        # Find end of first line (```mermaid, ```yaml, etc)
        first_newline = text.find("\n")
        if first_newline > 0:
            text = text[first_newline + 1:]
        else:
            text = text[3:]

    # Remove trailing code block markers
    if text.rstrip().endswith("```"):
        text = text.rstrip()[:-3].rstrip()

    # Handle case where metadata section is wrapped separately
    # e.g., "flowchart...\n```\n\n```yaml\nmetadata:..."
    text = re.sub(r'\n```\s*\n+```(?:yaml|mermaid)?\s*\n', '\n', text)

    # Remove any remaining ``` markers
    text = re.sub(r'^```(?:mermaid|yaml)?\s*\n', '', text, flags=re.MULTILINE)
    text = re.sub(r'\n```\s*$', '', text)

    return text.strip()


def parse_mermaid_response(response: str) -> WorkflowGraph:
    """Parse Mermaid+Metadata response into WorkflowGraph.

    Expected format (raw, no markdown):

    flowchart TD
        %% Workflow: Pipeline Name
        A[Label] --> B([LLM Label])
        B --> C{Decision?}
        C -->|yes| D[Result]

    ---
    metadata:
    A: {file: "main.py", line: 55, function: "handler", type: "step"}
    B: {file: "client.py", line: 42, function: "call_llm", type: "llm", model: "gemini-2.5-flash"}

    Also handles markdown-wrapped responses gracefully.
    """
    # Strip any markdown wrappers (defense in depth)
    response = strip_markdown(response)

    # Check for "no LLM workflow" response
    response_upper = response.strip().upper()
    if response_upper.startswith("NO_LLM") or response_upper.startswith("NO LLM"):
        # Return empty graph - caller should handle this
        return WorkflowGraph(nodes=[], edges=[], llms_detected=[], workflows=[])

    # Split diagram from metadata
    # Look for "---" followed by "metadata:" (possibly with whitespace)
    # This pattern separates the mermaid diagrams from the YAML metadata
    metadata_pattern = re.search(r'\n---\s*\n\s*metadata:', response)

    if metadata_pattern:
        # Found the exact separator pattern
        split_pos = metadata_pattern.start()
        diagram_part = response[:split_pos]
        metadata_part = response[metadata_pattern.end():]
    elif "---" in response and "metadata:" in response:
        # Fallback: find metadata: and work backwards to find ---
        metadata_marker = response.find("metadata:")
        # Find the closest --- before metadata:
        sep_before_meta = response.rfind("---", 0, metadata_marker)
        if sep_before_meta != -1:
            diagram_part = response[:sep_before_meta]
            metadata_part = response[metadata_marker + 9:]  # Skip "metadata:"
        else:
            # No valid separator found - raise with context
            print(f"[mermaid_parser] ERROR: No --- before metadata:")
            print(f"[mermaid_parser] Response preview: {response[:500]}")
            raise ValueError(f"No separator (---) found before 'metadata:' marker. Response starts with: {response[:200]}")
    elif "---" in response:
        # Has --- but no metadata: marker - use last ---
        last_sep = response.rfind("---")
        diagram_part = response[:last_sep]
        metadata_part = response[last_sep + 3:]
    else:
        # No separator at all - raise with context
        print(f"[mermaid_parser] ERROR: Missing --- separator")
        print(f"[mermaid_parser] Response preview: {response[:500]}")
        raise ValueError(f"Response missing metadata separator (---). Response starts with: {response[:200]}")

    # Clean up metadata part - strip markdown and whitespace
    metadata_part = strip_markdown(metadata_part).strip()
    if metadata_part.startswith("metadata:"):
        metadata_part = metadata_part[9:].strip()

    # Remove NO_LLM_WORKFLOW lines that may have been included (with or without filenames)
    metadata_part = re.sub(r'^NO_LLM_WORKFLOW.*$', '', metadata_part, flags=re.MULTILINE)
    metadata_part = re.sub(r'^NO_LLM\s.*$', '', metadata_part, flags=re.MULTILINE)
    metadata_part = re.sub(r'^NO_LLM\s*$', '', metadata_part, flags=re.MULTILINE)

    # Handle multiple --- separators (take only first section)
    if '\n---' in metadata_part:
        metadata_part = metadata_part.split('\n---')[0]

    # Remove standalone --- that might cause YAML multi-document issues
    metadata_part = re.sub(r'^---\s*$', '', metadata_part, flags=re.MULTILINE)
    metadata_part = metadata_part.strip()

    try:
        node_metadata = yaml.safe_load(metadata_part) or {}
    except yaml.YAMLError as e:
        # Malformed YAML metadata - log and raise with context
        print(f"[mermaid_parser] ERROR: Invalid metadata YAML")
        print(f"[mermaid_parser] Metadata part preview: {metadata_part[:500]}")
        raise ValueError(f"Invalid metadata YAML: {e}\nMetadata starts with: {metadata_part[:200]}")

    # Parse mermaid diagrams (can be multiple flowchart TD blocks)
    workflows = parse_workflows(diagram_part)

    # Extract nodes and edges from all workflows
    all_nodes: Dict[str, GraphNode] = {}
    all_edges: List[GraphEdge] = []
    workflow_metadata: List[WorkflowMetadata] = []

    for workflow_name, lines in workflows:
        workflow_nodes, workflow_edges = parse_flowchart(lines, node_metadata)

        # Add nodes (dedup by id)
        for node in workflow_nodes:
            if node.id not in all_nodes:
                all_nodes[node.id] = node

        # Add edges
        all_edges.extend(workflow_edges)

        # Create workflow metadata
        node_ids = [n.id for n in workflow_nodes]
        if node_ids:
            workflow_id = f"workflow_{sanitize_id(workflow_name)}"
            workflow_metadata.append(WorkflowMetadata(
                id=workflow_id,
                name=workflow_name,
                nodeIds=node_ids
            ))

    # Extract LLMs detected
    llms = [n.model for n in all_nodes.values() if n.model]

    return WorkflowGraph(
        nodes=list(all_nodes.values()),
        edges=all_edges,
        llms_detected=list(set(llms)),
        workflows=workflow_metadata
    )


def parse_workflows(diagram: str) -> List[Tuple[str, List[str]]]:
    """Split diagram into separate workflow blocks.

    Returns list of (workflow_name, lines) tuples.
    """
    workflows = []
    current_name = "Main Workflow"
    current_lines = []

    for line in diagram.strip().split("\n"):
        line = line.strip()

        # New flowchart block
        if line.startswith("flowchart"):
            if current_lines:
                workflows.append((current_name, current_lines))
            current_lines = []
            current_name = "Main Workflow"
            continue

        # Workflow name comment
        if line.startswith("%% Workflow:"):
            current_name = line.replace("%% Workflow:", "").strip()
            continue

        if line and not line.startswith("%%"):
            current_lines.append(line)

    # Don't forget last workflow
    if current_lines:
        workflows.append((current_name, current_lines))

    return workflows


def parse_flowchart(lines: List[str], metadata: Dict[str, Any]) -> Tuple[List[GraphNode], List[GraphEdge]]:
    """Parse flowchart lines into nodes and edges.

    Only creates nodes from proper shape definitions (not from edge references).
    Only includes edges where both endpoints are properly defined nodes.
    """
    nodes: Dict[str, GraphNode] = {}
    raw_edges: List[Tuple[str, str, Optional[str]]] = []  # (source, target, label)

    # Patterns for node shapes - ORDER MATTERS (more specific first)
    # [label] = step, ([label]) = llm, {label} = decision
    # Node ID pattern: matches path::function or path::function::line format
    # Uses [^\s\[\](){}]+ to match IDs like "main.py::handle", "backend/client.py::call_llm::42"
    node_id = r'([^\s\[\](){}]+)'
    node_patterns = [
        (node_id + r'\[\[([^\]]+)\]\]', 'step'),      # A[[label]] - subroutine
        (node_id + r'\(\[([^\]]+)\]\)', 'llm'),       # A([label]) - stadium/llm
        (node_id + r'\{([^}]+)\}', 'decision'),       # A{label} - diamond
        (node_id + r'\[([^\]]+)\]', 'step'),          # A[label] - rectangle
        (node_id + r'\(([^)]+)\)', 'step'),           # A(label) - rounded
    ]

    # Edge pattern: A --> B, A -->|label| B
    # Node IDs can contain path/function/line separators (. / :: -)
    # Match ID chars including '-', relying on shape suffix or whitespace to delimit
    edge_id = r'[^\s\[\](){}|>]+'
    edge_pattern = rf'({edge_id})(?:\[[^\]]*\]|\(\[[^\]]*\]\)|\{{[^}}]*\}}|\([^)]*\))?\s*-->\s*(?:\|([^|]*)\|)?\s*({edge_id})'

    for line in lines:
        # First pass: Extract node definitions with shapes
        for pattern, node_type in node_patterns:
            for match in re.finditer(pattern, line):
                node_id = match.group(1)
                label = match.group(2).strip()
                # Strip any remaining square/curly brackets from label (but NOT parentheses - used in model names)
                label = label.strip('[]{}')

                # Create node (first match wins - patterns are ordered specific to general)
                if node_id not in nodes:
                    nodes[node_id] = GraphNode(id=node_id, label=label, type=node_type)

        # Second pass: Extract edges
        edge_matches = re.findall(edge_pattern, line)
        for match in edge_matches:
            source = match[0]
            label = match[1] if len(match) > 1 and match[1] else None
            target = match[2] if len(match) > 2 else None

            if source and target:
                raw_edges.append((source, target, label.strip() if label else None))

    # Valid node types - normalize anything else to 'step'
    VALID_TYPES = {'step', 'llm', 'decision'}

    # Enrich nodes with metadata
    for node_id, node in nodes.items():
        if node_id in metadata:
            meta = metadata[node_id]
            if isinstance(meta, dict):
                # Override type if specified in metadata (normalize invalid types to 'step')
                if "type" in meta:
                    meta_type = meta["type"]
                    if meta_type not in VALID_TYPES:
                        print(f"[mermaid_parser] Normalizing invalid type '{meta_type}' to 'step' for {node_id}")
                        meta_type = "step"
                    node.type = meta_type
                if "model" in meta:
                    node.model = meta["model"]
                if "description" in meta:
                    node.description = meta["description"]

                # Set source location
                if "file" in meta and "line" in meta:
                    node.source = SourceLocation(
                        file=meta["file"],
                        line=meta["line"],
                        function=meta.get("function")
                    )

        # If no metadata, try to infer source from node ID format: path::function or path::function::line
        if not node.source and '::' in node_id:
            parts = node_id.split('::')
            if len(parts) >= 2:
                inferred_file = parts[0]
                inferred_func = parts[1]
                inferred_line = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else 0
                node.source = SourceLocation(
                    file=inferred_file,
                    line=inferred_line,
                    function=inferred_func
                )

    # Include edges where source is defined
    # Target may not be defined if it's a cross-batch reference (will be resolved later)
    valid_edges: List[GraphEdge] = []
    cross_batch_targets: List[str] = []
    for source, target, label in raw_edges:
        if source in nodes:
            valid_edges.append(GraphEdge(
                source=source,
                target=target,
                label=label
            ))
            if target not in nodes:
                cross_batch_targets.append(target)
        else:
            print(f"[mermaid_parser] Skipping edge {source} -> {target}: source not defined")

    if cross_batch_targets:
        print(f"[mermaid_parser] Cross-batch edge targets (to be resolved): {cross_batch_targets}")

    # Warn about nodes without source locations (missing metadata)
    nodes_without_source = [n.id for n in nodes.values() if not n.source]
    if nodes_without_source:
        print(f"[mermaid_parser] Warning: {len(nodes_without_source)} node(s) have no source location: {nodes_without_source[:5]}")

    return list(nodes.values()), valid_edges


def sanitize_id(name: str) -> str:
    """Convert workflow name to valid ID."""
    return re.sub(r'[^a-z0-9_]', '_', name.lower()).strip('_')


# Test with benchmark output
if __name__ == "__main__":
    # Test with new deterministic ID format
    test_response = """flowchart TD
    %% Workflow: Code Analysis Pipeline
    main_py__analyze[Receive Request] --> client_py__call_llm([Gemini 2.5 Flash])
    client_py__call_llm --> main_py__parse__85{Valid?}
    main_py__parse__85 -->|yes| main_py__respond[Return Result]
    main_py__parse__85 -->|no| main_py__error[Return Error]

---
metadata:
main_py__analyze: {file: "main.py", line: 55, function: "analyze", type: "step"}
client_py__call_llm: {file: "client.py", line: 42, function: "call_llm", type: "llm", model: "gemini-2.5-flash"}
main_py__parse__85: {file: "main.py", line: 85, function: "parse", type: "decision"}
main_py__respond: {file: "main.py", line: 110, function: "respond", type: "step"}
main_py__error: {file: "main.py", line: 120, function: "error", type: "step"}
"""

    graph = parse_mermaid_response(test_response)
    print(f"Nodes: {len(graph.nodes)}")
    for n in graph.nodes:
        print(f"  {n.id}: {n.label} ({n.type}) - {n.source}")
    print(f"\nEdges: {len(graph.edges)}")
    for e in graph.edges:
        label = f" [{e.label}]" if e.label else ""
        print(f"  {e.source} -> {e.target}{label}")
    print(f"\nWorkflows: {len(graph.workflows)}")
    for w in graph.workflows:
        print(f"  {w.name}: {w.nodeIds}")

    # Test cross-batch edge (target not in this batch)
    print("\n--- Test Cross-Batch Edge ---")
    cross_batch_response = """flowchart TD
    %% Workflow: Analysis Handler
    main_py__handler[Receive request] --> gemini_client_py__analyze_workflow

---
metadata:
main_py__handler: {file: "main.py", line: 10, function: "handler", type: "step"}
"""
    graph2 = parse_mermaid_response(cross_batch_response)
    print(f"Nodes: {len(graph2.nodes)}")
    print(f"Edges: {len(graph2.edges)}")
    for e in graph2.edges:
        print(f"  {e.source} -> {e.target} (cross-batch: {e.target not in [n.id for n in graph2.nodes]})")

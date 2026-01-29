from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import json

from models import (
    AnalyzeRequest, WorkflowGraph,
    MetadataRequest, MetadataBundle, FileMetadataResult, FunctionMetadata,
    CondenseRequest, CondenseResponse,
    TokenUsage, CostData, AnalyzeResponse
)
from prompts import build_metadata_only_prompt, USE_MERMAID_FORMAT
from mermaid_parser import parse_mermaid_response
from gemini_client import gemini_client
from analyzer import static_analyzer
from config import settings

app = FastAPI(title="Codag")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Analysis Endpoint
# =============================================================================

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_workflow(
    request: AnalyzeRequest,
    response: Response,
):
    """
    Analyze code for LLM workflow patterns.
    """
    # Track cumulative cost across retries
    total_usage = TokenUsage(input_tokens=0, output_tokens=0, total_tokens=0, cached_tokens=0)
    total_cost = CostData(input_cost=0.0, output_cost=0.0, total_cost=0.0)

    # Input validation
    MAX_CODE_SIZE = 5_000_000  # 5MB limit
    MAX_FILES = 50  # Reasonable limit on number of files

    if len(request.code) > MAX_CODE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Code size ({len(request.code)} bytes) exceeds maximum allowed size ({MAX_CODE_SIZE} bytes). Try analyzing fewer files or smaller files."
        )

    if request.file_paths and len(request.file_paths) > MAX_FILES:
        raise HTTPException(
            status_code=413,
            detail=f"Number of files ({len(request.file_paths)}) exceeds maximum allowed ({MAX_FILES}). Try analyzing fewer files at once."
        )

    # Static analysis
    framework = request.framework_hint or static_analyzer.detect_framework(
        request.code,
        request.file_paths[0] if request.file_paths else ""
    )

    # Convert metadata to dict format
    metadata_dicts = [m.dict() for m in request.metadata] if request.metadata else None

    # Helper to accumulate usage/cost
    def accumulate_cost(usage: TokenUsage, cost: CostData):
        nonlocal total_usage, total_cost
        total_usage = TokenUsage(
            input_tokens=total_usage.input_tokens + usage.input_tokens,
            output_tokens=total_usage.output_tokens + usage.output_tokens,
            total_tokens=total_usage.total_tokens + usage.total_tokens,
            cached_tokens=total_usage.cached_tokens + usage.cached_tokens
        )
        total_cost = CostData(
            input_cost=total_cost.input_cost + cost.input_cost,
            output_cost=total_cost.output_cost + cost.output_cost,
            total_cost=total_cost.total_cost + cost.total_cost
        )

    # LLM analysis
    try:
        result, usage, cost = await gemini_client.analyze_workflow(
            request.code,
            framework,
            metadata_dicts,
            http_connections=request.http_connections
        )
        accumulate_cost(usage, cost)
        result = result.strip()

        # Helper to fix file paths from LLM (handles both relative and mangled absolute paths)
        def fix_file_path(path: str, file_paths: list) -> str:
            if not path:
                return path
            if path in file_paths:
                return path
            filename = path.split('/')[-1]
            for input_path in file_paths:
                if input_path.endswith('/' + filename):
                    return input_path
            return path

        # Parse response based on format
        if USE_MERMAID_FORMAT:
            # Parse Mermaid + Metadata format with retry on failure
            MAX_RETRIES = 2

            for attempt in range(MAX_RETRIES + 1):
                # Strip markdown wrappers if present
                clean_result = result
                if clean_result.startswith("```"):
                    clean_result = clean_result.split("\n", 1)[1] if "\n" in clean_result else clean_result[3:]
                if clean_result.endswith("```"):
                    clean_result = clean_result.rsplit("```", 1)[0]

                try:
                    graph = parse_mermaid_response(clean_result.strip())
                    break  # Success - exit retry loop
                except ValueError as e:
                    if attempt < MAX_RETRIES:
                        # Retry with a correction prompt
                        correction_prompt = f"""Your previous response could not be parsed. Error: {str(e)[:200]}

CRITICAL FORMAT REMINDER:
1. Output RAW TEXT only - NO markdown backticks
2. Mermaid diagram(s) FIRST, then "---" separator, then "metadata:" section
3. The metadata section must be valid YAML

Example format:
flowchart TD
    %% Workflow: Example
    A[Step] --> B([LLM])

---
metadata:
A: {{file: "file.py", line: 1, function: "func", type: "step"}}
B: {{file: "file.py", line: 10, function: "llm", type: "llm"}}

Please re-analyze the code and output in the CORRECT format."""
                        try:
                            result, retry_usage, retry_cost = await gemini_client.analyze_workflow(
                                request.code,
                                framework,
                                metadata_dicts,
                                correction_prompt
                            )
                            accumulate_cost(retry_usage, retry_cost)
                            result = result.strip()
                        except Exception as retry_err:
                            raise HTTPException(
                                status_code=500,
                                detail=f"Analysis failed after retry: {str(e)}"
                            )
                    else:
                        # All retries exhausted
                        raise HTTPException(
                            status_code=500,
                            detail=f"Analysis failed after {MAX_RETRIES + 1} attempts: Could not parse Mermaid response. {str(e)}"
                        )

            # Empty graph is valid - code has no LLM calls
            if not graph.nodes:
                return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)

            # Fix file paths in nodes
            for node in graph.nodes:
                if node.source and node.source.file:
                    node.source.file = fix_file_path(node.source.file, request.file_paths)

            return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)
        else:
            # Parse JSON format (legacy)
            if result.startswith("```json"):
                result = result[7:]
            if result.startswith("```"):
                result = result[3:]
            if result.endswith("```"):
                result = result[:-3]

            try:
                graph_data = json.loads(result.strip())
            except json.JSONDecodeError as json_err:
                result_clean = result.strip()
                if not result_clean.endswith('}'):
                    open_braces = result_clean.count('{') - result_clean.count('}')
                    open_brackets = result_clean.count('[') - result_clean.count(']')
                    last_comma = result_clean.rfind(',')
                    if last_comma > result_clean.rfind('}') and last_comma > result_clean.rfind(']'):
                        result_clean = result_clean[:last_comma]
                    result_clean += ']' * max(0, open_brackets)
                    result_clean += '}' * max(0, open_braces)
                    try:
                        graph_data = json.loads(result_clean)
                    except:
                        raise HTTPException(
                            status_code=500,
                            detail=f"Analysis failed: Response was truncated. {str(json_err)}"
                        )
                else:
                    raise

            # Empty graph is valid - return early
            if not graph_data.get('nodes'):
                empty_graph = WorkflowGraph(nodes=[], edges=[], llms_detected=[], workflows=[])
                return AnalyzeResponse(graph=empty_graph, usage=total_usage, cost=total_cost)

            for node in graph_data.get('nodes', []):
                if node.get('source') and node['source'].get('file'):
                    node['source']['file'] = fix_file_path(node['source']['file'], request.file_paths)

            graph = WorkflowGraph(**graph_data)
            return AnalyzeResponse(graph=graph, usage=total_usage, cost=total_cost)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")


@app.post("/analyze/metadata-only")
async def analyze_metadata_only(request: MetadataRequest):
    """Generate metadata (labels, descriptions) for functions.

    This is a lightweight endpoint for incremental updates.
    Structure is already known from local tree-sitter analysis.
    Only needs LLM for human-readable labels and descriptions.
    """
    # Build prompt from structure context
    files_data = [f.model_dump() for f in request.files]
    prompt = build_metadata_only_prompt(files_data)

    # Add code context if provided
    if request.code:
        prompt += f"\n\nFull code for context:\n{request.code[:8000]}"

    try:
        # Use gemini for metadata generation (simple prompt, no workflow system instruction)
        result, usage, cost = await gemini_client.generate_metadata(prompt)

        # Clean markdown if present
        result = result.strip()
        if result.startswith("```json"):
            result = result[7:]
        if result.startswith("```"):
            result = result[3:]
        if result.endswith("```"):
            result = result[:-3]

        # Parse response
        try:
            metadata_data = json.loads(result.strip())
        except json.JSONDecodeError:
            # Try to recover
            result_clean = result.strip()
            open_braces = result_clean.count('{') - result_clean.count('}')
            open_brackets = result_clean.count('[') - result_clean.count(']')
            result_clean += ']' * max(0, open_brackets)
            result_clean += '}' * max(0, open_braces)
            metadata_data = json.loads(result_clean)

        # Convert to response model
        files_result = []
        for file_data in metadata_data.get('files', []):
            functions = [
                FunctionMetadata(
                    name=f.get('name', ''),
                    label=f.get('label', f.get('name', '')),
                    description=f.get('description', '')
                )
                for f in file_data.get('functions', [])
            ]
            files_result.append(FileMetadataResult(
                filePath=file_data.get('filePath', ''),
                functions=functions,
                edgeLabels=file_data.get('edgeLabels', {})
            ))

        return {
            "files": [f.model_dump() for f in files_result],
            "usage": usage.model_dump(),
            "cost": cost.model_dump()
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Metadata analysis failed: {str(e)}")


@app.post("/condense-structure")
async def condense_structure(request: CondenseRequest):
    """Condense raw repo structure into workflow-relevant summary.

    Uses LLM to:
    1. Filter out irrelevant files (tests, configs, utilities)
    2. Identify LLM/AI workflow entry points
    3. Create condensed structure for cross-batch context
    """
    try:
        condensed, usage, cost = await gemini_client.condense_repo_structure(request.raw_structure)
        return {
            "condensed_structure": condensed,
            "usage": usage.model_dump(),
            "cost": cost.model_dump()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Structure condensation failed: {str(e)}")


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=52104)

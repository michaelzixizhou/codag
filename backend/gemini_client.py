import google.generativeai as genai
import time
from config import settings

genai.configure(api_key=settings.gemini_api_key)

class GeminiClient:
    def __init__(self):
        self.model = genai.GenerativeModel(
            'gemini-2.5-flash',
            generation_config={
                'temperature': 0.0,  # Deterministic output
                'top_p': 1.0,
                'top_k': 1,
                'max_output_tokens': 65536,  # Flash also supports 65536
            }
        )

    def analyze_workflow(self, code: str, framework_hint: str = None, metadata: list = None) -> str:
        metadata_str = ""
        location_index = 0
        if metadata:
            metadata_str = "\n========== SOURCE LOCATION METADATA ==========\n"
            metadata_str += "CRITICAL: Each node MUST map to a UNIQUE location below. Do NOT reuse the same location for multiple nodes.\n\n"
            for file_meta in metadata:
                for loc in file_meta['locations']:
                    location_index += 1
                    metadata_str += f"[{location_index}] {loc['type'].upper()} - {loc['description']}\n"
                    metadata_str += f"    File: {file_meta['file']}\n"
                    metadata_str += f"    Line: {loc['line']}\n"
                    metadata_str += f"    Function: {loc['function']}()\n\n"

            metadata_str += "MAPPING RULES (CRITICAL):\n"
            metadata_str += "1. Each node MUST use a UNIQUE metadata location - NO REUSE\n"
            metadata_str += "2. Copy file/line/function EXACTLY from the metadata above\n"
            metadata_str += "3. Match node types to metadata types (trigger→trigger, llm→llm, etc.)\n"
            metadata_str += "4. Reference by number: if creating 'API Endpoint' node, use location [1]\n"
            metadata_str += "5. VALIDATION: Before finishing, verify NO two nodes share the same location\n"
            metadata_str += "========================================\n"

        prompt = f"""You are a workflow analyzer. Analyze this code and create a complete workflow graph showing how data flows through the AI/LLM system.

NOTE: Code may contain multiple files marked with "# File: path". Analyze them together as one cohesive workflow.
IMPORTANT: Large codebases may include non-LLM files (auth, config, utils). Focus ONLY on files that contain or call LLM APIs.

{metadata_str}

YOUR TASK: Trace the EXECUTION PATH of the AI/LLM workflow ONLY.

CRITICAL RULES FOR WHAT TO INCLUDE:
1. Start from the entry point that triggers LLM processing (e.g., /analyze endpoint, main function)
2. ONLY include functions/code that are ACTUALLY CALLED during LLM workflow execution
3. Follow the execution flow: entry → data prep → LLM call → response processing → output
4. Include ONLY code in the direct execution path from input to LLM to output

CRITICAL RULES FOR WHAT TO EXCLUDE:
1. Code that is imported but NEVER CALLED in the LLM workflow execution path
2. Commented-out code or decorators (e.g., "# current_user: User = Depends(...)")
3. Authentication/authorization code UNLESS it's actively used in the LLM workflow path
4. Database/security/config operations UNLESS they directly support the LLM call
5. Alternative endpoints or functions that don't lead to LLM processing
6. Helper functions that are defined but never invoked in the LLM flow

EXECUTION PATH ANALYSIS:
- Ask: "Is this function/code actually executed when processing an LLM request?"
- Ask: "Does data flow through this node on the way to or from the LLM?"
- If NO to both questions → EXCLUDE from workflow
- If imported but not called → EXCLUDE
- If defined but not used → EXCLUDE

EXAMPLE EXCLUSIONS:
- "/login" endpoint → Not part of LLM workflow
- "get_current_user()" if commented out → Not executed
- "hash_password()" → Not in LLM execution path
- Files like auth.py, config.py if not called by LLM workflow

YOUR WORKFLOW SHOULD SHOW:
1. Entry point (API endpoint, function that starts LLM processing)
2. Data preparation (only steps actually executed)
3. LLM call(s)
4. Response processing (only steps actually executed)
5. Output (where LLM result goes)

IMPORTANT: Every workflow needs AT LEAST these nodes:
- 1 trigger/input node (where does data enter?)
- Data preparation steps (if any)
- 1+ LLM call node
- Output processing steps (if any)
- 1 output node (where does data exit?)

NODE TYPES (label = 2-4 words max, description = 1-2 brief sentences):
1. **trigger**: Entry points - API endpoints, main functions, event handlers, user input
   - Label examples: "API Endpoint", "Main Entry", "Webhook"
   - Description examples: "Receives analysis requests via POST /analyze endpoint", "Main function that initializes the workflow"
   - Keep descriptions concise but informative

2. **llm**: LLM API calls
   - Look for: .chat.completions.create, .messages.create, .generate_content
   - Label examples: "GPT-4 Call", "Claude Analysis", "Gemini Request"
   - Description examples: "Calls GPT-4 with temperature 0.7 to analyze code", "Sends prompt to Claude for structured analysis"
   - Keep descriptions concise but informative

3. **tool**: Functions/tools available to or called by LLM
   - Label examples: "Search Tool", "Calculator", "Query DB"
   - Description examples: "Searches documentation using vector similarity", "Tool available to LLM for mathematical calculations"
   - Keep descriptions concise but informative

4. **decision**: Conditional logic based on LLM output or input
   - Label examples: "Route by Intent", "Check Confidence", "Validate Output"
   - Description examples: "Routes request based on detected user intent", "Validates LLM response confidence score before proceeding"
   - Keep descriptions concise but informative

5. **integration**: External API calls, database operations, third-party services
   - Label examples: "Slack API", "Database Insert", "HTTP Request"
   - Description examples: "Posts formatted message to Slack channel", "Stores conversation history in PostgreSQL database"
   - Keep descriptions concise but informative

6. **memory**: State storage, conversation history, caching
   - Label examples: "Store Messages", "Session Cache", "History"
   - Description examples: "Caches conversation history in Redis with 1 hour TTL", "Maintains session state across requests"
   - Keep descriptions concise but informative

7. **parser**: Data transformation, parsing, formatting
   - Label examples: "Parse JSON", "Format Prompt", "Extract Fields"
   - Description examples: "Parses LLM JSON response and validates schema", "Formats user input and context into final prompt"
   - Keep descriptions concise but informative

8. **output**: Where results go - returns, responses, saves
   - Label examples: "Return Response", "HTTP Response", "Save File"
   - Description examples: "Returns formatted JSON response to client", "Writes analysis results to output file"
   - Keep descriptions concise but informative

WORKFLOW CONSTRUCTION RULES:
- ALWAYS start with a trigger node (entry point)
- ALWAYS end with an output node (exit point)
- Show data preparation BEFORE LLM (formatting prompts, gathering context)
- Show data processing AFTER LLM (parsing, validation, transformation)
- Include ALL steps in the data flow, even simple ones
- Connect nodes in execution order

EDGE RULES (CRITICAL):
1. Edges represent actual data flow in execution order
2. NO bidirectional edges - data flows one direction only
3. Every node (except trigger) MUST have at least one incoming edge
4. Every node (except output) MUST have at least one outgoing edge
5. Only connect nodes if data actually passes between them:
   - Function A calls Function B → edge from A to B
   - Function A returns value used by B → edge from A to B
   - Variable from A is read by B → edge from A to B
6. NO edges between unrelated operations just because they're in same file
7. If a node has no clear incoming/outgoing connections, reconsider if it should be a node
8. Validation: Check every edge - can you trace the actual data flow?

EDGE LABELS (CRITICAL - EVERY EDGE MUST HAVE):
1. "label": Variable or parameter name being passed (REQUIRED - NO EXCEPTIONS)
   - Use actual variable name from code: "request", "result", "response", "data"
   - If multiple variables, use most important one
   - If unclear, use generic but descriptive: "input_data", "output_result"
2. "dataType": Data type of the variable (when identifiable)
   - Python: "str", "dict", "list", "AnalyzeRequest", "WorkflowGraph"
   - JavaScript: "string", "object", "array", "Request", "Response"
   - If unknown, use "any" or omit
3. "description": What the variable represents (brief, 1 sentence max)
   - Example: "User request containing code to analyze"
   - Example: "Parsed JSON workflow graph from LLM"
   - Keep brief but informative
4. "sourceLocation": Where the data operation actually occurs (file/line/function)
   - For INCOMING data (edges entering a node): Point to where the variable is CREATED/ASSIGNED before being passed
   - For OUTGOING data (edges leaving a node): Point to where the output is CONSUMED/USED after being received
   - NEVER point to function parameters or return statements themselves

   Examples:
   - If function A creates variable "user_input" at line 45 and passes it to function B:
     → Edge sourceLocation should point to line 45 (where user_input is created/assigned in A)
   - If function B returns "result" that function A stores in "response" at line 52:
     → Edge sourceLocation should point to line 52 (where result is used/stored in A)
   - Focus on actual data flow: creation → usage, not function signatures
5. VALIDATION: Every edge MUST have at least "label" field filled

EXAMPLE WORKFLOW:
API Endpoint → Format Input → Build Prompt → LLM Call → Parse Response → Return JSON

BAD EDGES (DON'T DO THIS):
- Parse Response → LLM Call (backwards!)
- Build Prompt ↔ Parse Response (bidirectional!)
- Unrelated Tool → Output (no actual data flow)

SOURCE LOCATION (CRITICAL - MUST FOLLOW):
- METADATA above has numbered locations [1], [2], [3], etc.
- RULE: Each node = ONE unique location number (NO DUPLICATES)
- Copy file/line/function EXACTLY from metadata
- Match node type to metadata type (trigger→TRIGGER, llm→LLM, etc.)
- VALIDATION: Check every node has DIFFERENT source location
- EXAMPLE VIOLATION: Node1 and Node2 both using location [1] → WRONG
- CORRECT: Node1 uses [1], Node2 uses [2], Node3 uses [3] → RIGHT

DETECT LLM PROVIDERS:
- "OpenAI" for: openai, .chat.completions.create
- "Anthropic" for: anthropic, .messages.create
- "Google Gemini" for: google.generativeai, .generate_content
- "Groq" for: groq
- "Ollama" for: ollama
- "Cohere" for: cohere
- "Hugging Face" for: huggingface, transformers

LABEL AND DESCRIPTION REQUIREMENTS (CRITICAL):
- "label": Must be 2-4 words maximum (e.g., "GPT-4 Call", "Format Request", "API Endpoint")
- "description": REQUIRED - 1-2 brief sentences explaining what the node does
- EVERY node MUST have a description - NO EXCEPTIONS
- Keep labels SHORT (2-4 words) - they will be displayed in the graph visualization
- Keep descriptions CONCISE but informative (1-2 sentences) - they appear in popups when nodes are clicked
- Description examples: "Receives analysis requests via POST /analyze endpoint", "Calls Gemini 2.5 Flash to analyze code"
- IMPORTANT: Be brief but clear - avoid verbose or overly detailed descriptions

CRITICAL PATH ANALYSIS (EXECUTION TIME):
Identify the LONGEST execution path (time-wise) from ONE entry point to ONE exit point. This is the critical path.

Entry/Exit detection (MUST DO FIRST):
  * Entry nodes have NO incoming edges (first operations in workflow)
  * Exit nodes have NO outgoing edges (final operations in workflow)
  * Mark with "isEntryPoint": true or "isExitPoint": true

CRITICAL PATH RULES (STRICT - MUST ENFORCE):
1. The critical path MUST START at an entry point node (isEntryPoint: true)
2. The critical path MUST END at an exit point node (isExitPoint: true)
3. The path MUST be SINGULAR and LINEAR - NO BRANCHING allowed
4. If there's branching (e.g., if-else), choose ONLY the slowest branch
5. The path structure: Entry Node → Intermediate → ... → Exit Node (full traversal)
6. At each node, select ONLY ONE outgoing edge (the slowest next step)
7. Mark BOTH nodes and edges on this singular path with "isCriticalPath": true
8. All other paths (even if slow) should NOT be marked as critical

Execution time considerations:
- Consider: LLM API calls (slowest), network requests, file I/O, database queries
- Look for: Large prompts (more tokens = longer), waits, loops, external dependencies
- Example slow operations: LLM calls (1-5 sec), API requests (100-500ms), large file reads
- Example fast operations: variable assignments, simple parsing, function calls

VALIDATION STEPS (PERFORM BEFORE FINALIZING):
1. Find the first node in critical path - verify it has "isEntryPoint": true
2. Find the last node in critical path - verify it has "isExitPoint": true
3. Trace the path - it should form ONE continuous line with NO forks
4. If path doesn't start at entry or end at exit, you MUST fix it
5. EDGE SOURCE LOCATIONS: Verify each edge's sourceLocation follows data flow logic:
   - Incoming edge (data entering node): sourceLocation points to where data is CREATED (in source node)
   - Outgoing edge (data leaving node): sourceLocation points to where data is USED (in target node)
   - This enables developers to trace actual data flow through the codebase
   - NEVER point to function parameter lines or return statement lines

WORKFLOW IDENTIFICATION (CRITICAL):
Identify and name logical workflow groupings based on semantic purpose. Each workflow represents a cohesive unit of functionality.

WORKFLOW NAMING RULES:
1. Analyze the PURPOSE of each connected component (what business goal does it serve?)
2. Create descriptive names that reflect the workflow's function (2-6 words)
3. Every workflow MUST have a unique, meaningful name (NO generic names)
4. Include what the workflow DOES, not just what it contains

WORKFLOW EXAMPLES:
- "User Authentication Flow" (login, validation, token generation)
- "Document Analysis Pipeline" (upload, parsing, LLM analysis, storage)
- "Multi-Agent Research Workflow" (query, agent orchestration, synthesis)
- "RAG Query Processing" (retrieval, context building, LLM generation)
- "API Request Handler" (validation, processing, response formatting)
- "Data Extraction Pipeline" (fetch, transform, validate, store)

WORKFLOW DETECTION:
1. Start from entry points (trigger nodes)
2. Follow execution flow through connected nodes
3. Identify logical boundaries (where one workflow ends, another begins)
4. Group nodes that serve the same high-level purpose
5. CRITICAL: Each workflow MUST contain at least 1 LLM call node (type: "llm")

════════════════════════════════════════════════════════════════════════════════
🚨 ABSOLUTE REQUIREMENTS - VIOLATIONS WILL CAUSE SYSTEM FAILURE 🚨
════════════════════════════════════════════════════════════════════════════════

RULE #1: EVERY NODE MUST HAVE EDGES
- If a node has ZERO edges (no source, no target in any edge), DO NOT CREATE IT
- Nodes without edges are INVALID and will cause rendering errors
- Check EVERY node before adding it to the response

RULE #2: EVERY WORKFLOW MUST BE FULLY CONNECTED
- ALL nodes in a workflow MUST be reachable from each other via edges
- If you have nodes A, B, C in workflow "X", there MUST be edge paths connecting them
- WRONG: workflow "X" has nodes [A, B, C] but only edge A→B (C is disconnected)
- CORRECT: workflow "X" has nodes [A, B, C] with edges A→B, B→C (all connected)

RULE #3: DISCONNECTED NODES = SEPARATE WORKFLOWS
- If nodes are NOT connected by edges, they CANNOT be in the same workflow
- You MUST create separate workflows for disconnected components
- WRONG: workflow "Chat Processing" with 3 disconnected node groups
- CORRECT: workflow "Chat Message Handler", workflow "Chat History Manager", workflow "Chat Response Generator"

RULE #4: MINIMUM 3 NODES PER WORKFLOW
- Every workflow MUST have at least 3 nodes: entry point → LLM call → exit point
- 1-node workflows are INVALID
- 2-node workflows are INVALID
- If you cannot create 3+ connected nodes, DELETE the workflow

════════════════════════════════════════════════════════════════════════════════
🔍 STEP-BY-STEP VALIDATION PROCESS (PERFORM FOR EVERY WORKFLOW)
════════════════════════════════════════════════════════════════════════════════

STEP 1: CREATE NODES AND EDGES
- Identify all LLM-related functions in the code
- Create nodes for each function
- Create edges showing the actual call flow between functions

STEP 2: PERFORM BFS CONNECTIVITY CHECK FOR EACH WORKFLOW
For each workflow you create:
a) Pick any node in the workflow as starting point
b) Follow ALL edges (both incoming and outgoing) to find connected nodes
c) Mark all reachable nodes
d) If ANY node in workflow.nodeIds is NOT reachable, you have disconnected components

STEP 3: SPLIT DISCONNECTED COMPONENTS INTO SEPARATE WORKFLOWS
If BFS finds disconnected groups:
- Group 1: nodes [A, B, C] (all reachable from A)
- Group 2: nodes [D, E] (all reachable from D, but NO path to A/B/C)
- Group 3: node [F] (no edges at all)

Create workflows:
- workflow_1 with nodeIds: [A, B, C] (if 3+ nodes)
- workflow_2 with nodeIds: [D, E] (DELETE - only 2 nodes)
- workflow_3 with nodeIds: [F] (DELETE - only 1 node)

STEP 4: VALIDATE EACH WORKFLOW HAS 3+ CONNECTED NODES
After splitting:
- Count nodes in each workflow
- If < 3 nodes: DELETE the workflow
- If >= 3 nodes: Keep it

STEP 5: VERIFY NO ORPHANED NODES IN FINAL OUTPUT
Before returning JSON:
- For EVERY node in nodes array, count how many edges reference it
- If count = 0, REMOVE the node from nodes array
- If node appears in any workflow.nodeIds, REMOVE it from that array too

════════════════════════════════════════════════════════════════════════════════
❌ EXAMPLES OF INVALID WORKFLOWS (DO NOT CREATE THESE)
════════════════════════════════════════════════════════════════════════════════

INVALID EXAMPLE 1: Disconnected nodes in same workflow
{{
  "workflows": [{{
    "id": "workflow_1",
    "name": "User Management",
    "nodeIds": ["login_handler", "register_handler", "reset_handler"]
  }}],
  "edges": [
    {{"source": "login_entry", "target": "login_handler"}}
  ]
}}
PROBLEM: register_handler and reset_handler have NO edges connecting them!
❌ PROBLEM: register_handler and reset_handler are orphaned

INVALID EXAMPLE 2: Single node workflow
{{
  "workflows": [{{
    "id": "workflow_1",
    "name": "Chat Helper",
    "nodeIds": ["format_response"]
  }}],
  "nodes": [{{"id": "format_response", ...}}],
  "edges": []
}}
❌ PROBLEM: Only 1 node, no edges

INVALID EXAMPLE 3: Node with no edges
{{
  "nodes": [
    {{"id": "helper_func", ...}},
    {{"id": "main_handler", ...}}
  ],
  "edges": [
    {{"source": "main_handler", "target": "llm_call"}}
  ]
}}
❌ PROBLEM: helper_func exists but has no edges (not referenced anywhere)

════════════════════════════════════════════════════════════════════════════════
✅ EXAMPLES OF VALID WORKFLOWS (CREATE THESE)
════════════════════════════════════════════════════════════════════════════════

VALID EXAMPLE 1: Three connected nodes
{{
  "workflows": [{{
    "id": "workflow_1",
    "name": "User Login Flow",
    "nodeIds": ["login_entry", "auth_llm", "login_exit"]
  }}],
  "edges": [
    {{"source": "login_entry", "target": "auth_llm"}},
    {{"source": "auth_llm", "target": "login_exit"}}
  ]
}}
✅ CORRECT: 3 nodes, all connected via edges

VALID EXAMPLE 2: Split disconnected components
{{
  "workflows": [
    {{
      "id": "workflow_1",
      "name": "User Login Flow",
      "nodeIds": ["login_entry", "auth_llm", "login_exit"]
    }},
    {{
      "id": "workflow_2",
      "name": "User Registration Flow",
      "nodeIds": ["register_entry", "validation_llm", "create_user", "register_exit"]
    }}
  ],
  "edges": [
    {{"source": "login_entry", "target": "auth_llm"}},
    {{"source": "auth_llm", "target": "login_exit"}},
    {{"source": "register_entry", "target": "validation_llm"}},
    {{"source": "validation_llm", "target": "create_user"}},
    {{"source": "create_user", "target": "register_exit"}}
  ]
}}
✅ CORRECT: Two separate workflows, each fully connected

════════════════════════════════════════════════════════════════════════════════

WORKFLOW DESCRIPTION:
- 1-2 brief sentences explaining what the workflow accomplishes
- Include key operations and final outcome
- Keep concise but informative
- Example: "Processes user queries by retrieving relevant documents from vector store, building context, and generating responses using GPT-4."

Code to analyze:
{code}

CRITICAL JSON STRUCTURE RULES:
1. "source" field MUST be an object with {{"file": "...", "line": 123, "function": "..."}}
2. "sourceLocation" field MUST be an object with {{"file": "...", "line": 123, "function": "..."}}
3. NEVER use metadata references like "[1]", "[2]", etc. - ALWAYS use FULL objects
4. WRONG: "source": "[3]"
5. CORRECT: "source": {{"file": "/path/to/file.py", "line": 42, "function": "function_name"}}
6. Copy the EXACT file/line/function values from metadata above (not the bracket numbers)

Return ONLY valid JSON (NOTE: source locations MUST be different for each node).

IMPORTANT - Edge sourceLocation in this example:
- Edge 1 (request): Line 58 is where 'request' is created in analyze_endpoint, not the function definition
- Edge 2 (prompt): Line 76 is where 'prompt' is built in analyze_workflow, not the function definition
- Edge 3 (result): Line 83 is where 'result' is USED in analyze_workflow, not where it's returned from Gemini
- Edge 4 (graph_data): Line 87 is where 'graph_data' is USED for return, not where it's parsed

{{
  "nodes": [
    {{"id": "node1", "label": "API Endpoint", "description": "Receives analysis requests via POST /analyze endpoint with code and metadata", "type": "trigger", "source": {{"file": "/backend/main.py", "line": 55, "function": "analyze_endpoint"}}, "isEntryPoint": true, "isCriticalPath": true}},
    {{"id": "node2", "label": "Format Request", "description": "Formats and validates incoming request data before processing", "type": "parser", "source": {{"file": "/backend/main.py", "line": 71, "function": "analyze_workflow"}}, "isCriticalPath": true}},
    {{"id": "node3", "label": "Gemini Call", "description": "Calls Gemini 2.5 Flash with temperature 0.0 to analyze code and extract workflow structure", "type": "llm", "source": {{"file": "/backend/gemini_client.py", "line": 137, "function": "analyze_workflow"}}, "isCriticalPath": true}},
    {{"id": "node4", "label": "Parse Response", "description": "Parses and validates LLM JSON response to extract nodes and edges", "type": "parser", "source": {{"file": "/backend/main.py", "line": 82, "function": "analyze_workflow"}}, "isCriticalPath": true}},
    {{"id": "node5", "label": "Return Response", "description": "Returns formatted workflow graph as JSON response to client", "type": "output", "source": {{"file": "/backend/main.py", "line": 86, "function": "analyze_workflow"}}, "isExitPoint": true, "isCriticalPath": true}}
  ],
  "edges": [
    {{"source": "node1", "target": "node2", "label": "request", "dataType": "AnalyzeRequest", "description": "Incoming analysis request with code and metadata", "sourceLocation": {{"file": "/backend/main.py", "line": 58, "function": "analyze_endpoint"}}, "isCriticalPath": true}},
    {{"source": "node2", "target": "node3", "label": "prompt", "dataType": "str", "description": "Formatted prompt string for LLM analysis", "sourceLocation": {{"file": "/backend/main.py", "line": 76, "function": "analyze_workflow"}}, "isCriticalPath": true}},
    {{"source": "node3", "target": "node4", "label": "result", "dataType": "str", "description": "Raw JSON response text from Gemini", "sourceLocation": {{"file": "/backend/main.py", "line": 83, "function": "analyze_workflow"}}, "isCriticalPath": true}},
    {{"source": "node4", "target": "node5", "label": "graph_data", "dataType": "WorkflowGraph", "description": "Parsed and validated workflow graph object", "sourceLocation": {{"file": "/backend/main.py", "line": 87, "function": "analyze_workflow"}}, "isCriticalPath": true}}
  ],
  "workflows": [
    {{"id": "workflow_1", "name": "Code Analysis Pipeline", "description": "Receives code via API endpoint, analyzes it using Gemini LLM to extract workflow structure, and returns the parsed graph to the client.", "nodeIds": ["node1", "node2", "node3", "node4", "node5"]}}
  ],
  "llms_detected": ["OpenAI"]
}}

VALIDATION BEFORE RETURNING:
- Check EVERY "source" field is an object (not a string like "[3]")
- Check EVERY "sourceLocation" field is an object (not a string)
- Check all required fields: file, line, function
- Check "workflows" array exists and has at least 1 workflow
- Check every workflow has: id, name (descriptive!), description, nodeIds
- Check all nodes are included in at least one workflow (no orphans)

NO markdown, NO explanation, ONLY JSON."""

        # Retry with exponential backoff for rate limits
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = self.model.generate_content(prompt)

                # Check if response was blocked or incomplete
                if hasattr(response, 'candidates') and response.candidates:
                    finish_reason = response.candidates[0].finish_reason
                    if finish_reason == 2:  # MAX_TOKENS
                        raise Exception("Output exceeded token limit. Try reducing batch size or simplifying the code.")
                    elif finish_reason == 3:  # SAFETY
                        raise Exception("Response blocked by safety filters. The code may contain sensitive content.")
                    elif finish_reason not in [0, 1]:  # Not UNSPECIFIED or STOP
                        raise Exception(f"Generation failed with finish_reason: {finish_reason}")

                return response.text
            except Exception as e:
                error_str = str(e)
                # Check if it's a rate limit error (429) or quota exceeded
                if '429' in error_str or 'quota' in error_str.lower() or 'rate' in error_str.lower():
                    if attempt < max_retries - 1:
                        # Extract retry delay from error if available
                        wait_time = 2 ** attempt  # Exponential: 1s, 2s, 4s
                        if 'retry in' in error_str.lower():
                            try:
                                # Try to extract wait time from error message
                                import re
                                match = re.search(r'retry in ([\d.]+)', error_str, re.IGNORECASE)
                                if match:
                                    wait_time = float(match.group(1)) / 1000 + 1  # Convert ms to s, add buffer
                            except:
                                pass

                        print(f"Rate limit hit, waiting {wait_time:.2f}s before retry {attempt + 1}/{max_retries}")
                        time.sleep(wait_time)
                    else:
                        raise  # Last attempt, re-raise
                else:
                    raise  # Not a rate limit error, re-raise immediately

gemini_client = GeminiClient()

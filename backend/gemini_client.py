import google.generativeai as genai
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

NODE TYPES (label = 2-4 words max, description = 1-2 sentences):
1. **trigger**: Entry points - API endpoints, main functions, event handlers, user input
   - Label examples: "API Endpoint", "Main Entry", "Webhook"
   - Description examples: "Receives analysis requests via POST /analyze endpoint", "Main function that initializes the workflow"

2. **llm**: LLM API calls
   - Look for: .chat.completions.create, .messages.create, .generate_content
   - Label examples: "GPT-4 Call", "Claude Analysis", "Gemini Request"
   - Description examples: "Calls GPT-4 with temperature 0.7 to analyze code", "Sends prompt to Claude for structured analysis"

3. **tool**: Functions/tools available to or called by LLM
   - Label examples: "Search Tool", "Calculator", "Query DB"
   - Description examples: "Searches documentation using vector similarity", "Tool available to LLM for mathematical calculations"

4. **decision**: Conditional logic based on LLM output or input
   - Label examples: "Route by Intent", "Check Confidence", "Validate Output"
   - Description examples: "Routes request based on detected user intent", "Validates LLM response confidence score before proceeding"

5. **integration**: External API calls, database operations, third-party services
   - Label examples: "Slack API", "Database Insert", "HTTP Request"
   - Description examples: "Posts formatted message to Slack channel", "Stores conversation history in PostgreSQL database"

6. **memory**: State storage, conversation history, caching
   - Label examples: "Store Messages", "Session Cache", "History"
   - Description examples: "Caches conversation history in Redis with 1 hour TTL", "Maintains session state across requests"

7. **parser**: Data transformation, parsing, formatting
   - Label examples: "Parse JSON", "Format Prompt", "Extract Fields"
   - Description examples: "Parses LLM JSON response and validates schema", "Formats user input and context into final prompt"

8. **output**: Where results go - returns, responses, saves
   - Label examples: "Return Response", "HTTP Response", "Save File"
   - Description examples: "Returns formatted JSON response to client", "Writes analysis results to output file"

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
3. "description": What the variable represents (1 sentence)
   - Example: "User request containing code to analyze"
   - Example: "Parsed JSON workflow graph from LLM"
4. "sourceLocation": Where variable is passed (file/line/function)
   - Use source node's location if variable is output
   - Use target node's location if variable is input
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
- "description": REQUIRED - Must be 1-2 complete sentences explaining what the node does in detail
- EVERY node MUST have a description - NO EXCEPTIONS
- Keep labels SHORT and concise - they will be displayed in the graph visualization
- Use descriptions for detailed explanations - they appear in popups when nodes are clicked
- Description examples: "Receives analysis requests via POST /analyze endpoint", "Calls Gemini 2.5 Flash to analyze code"

Code to analyze:
{code}

Return ONLY valid JSON (NOTE: source locations MUST be different for each node):
{{
  "nodes": [
    {{"id": "node1", "label": "API Endpoint", "description": "Receives analysis requests via POST /analyze endpoint with code and metadata", "type": "trigger", "source": {{"file": "/backend/main.py", "line": 55, "function": "analyze_endpoint"}}}},
    {{"id": "node2", "label": "Format Request", "description": "Formats and validates incoming request data before processing", "type": "parser", "source": {{"file": "/backend/main.py", "line": 71, "function": "analyze_workflow"}}}},
    {{"id": "node3", "label": "Gemini Call", "description": "Calls Gemini 2.5 Flash with temperature 0.0 to analyze code and extract workflow structure", "type": "llm", "source": {{"file": "/backend/gemini_client.py", "line": 137, "function": "analyze_workflow"}}}},
    {{"id": "node4", "label": "Parse Response", "description": "Parses and validates LLM JSON response to extract nodes and edges", "type": "parser", "source": {{"file": "/backend/main.py", "line": 82, "function": "analyze_workflow"}}}},
    {{"id": "node5", "label": "Return Response", "description": "Returns formatted workflow graph as JSON response to client", "type": "output", "source": {{"file": "/backend/main.py", "line": 86, "function": "analyze_workflow"}}}}
  ],
  "edges": [
    {{"source": "node1", "target": "node2", "label": "request", "dataType": "AnalyzeRequest", "description": "Incoming analysis request with code and metadata", "sourceLocation": {{"file": "/backend/main.py", "line": 55, "function": "analyze_endpoint"}}}},
    {{"source": "node2", "target": "node3", "label": "prompt", "dataType": "str", "description": "Formatted prompt string for LLM analysis", "sourceLocation": {{"file": "/backend/main.py", "line": 74, "function": "analyze_workflow"}}}},
    {{"source": "node3", "target": "node4", "label": "result", "dataType": "str", "description": "Raw JSON response text from Gemini", "sourceLocation": {{"file": "/backend/gemini_client.py", "line": 172, "function": "analyze_workflow"}}}},
    {{"source": "node4", "target": "node5", "label": "graph_data", "dataType": "WorkflowGraph", "description": "Parsed and validated workflow graph object", "sourceLocation": {{"file": "/backend/main.py", "line": 85, "function": "analyze_workflow"}}}}
  ],
  "llms_detected": ["OpenAI"]
}}

NO markdown, NO explanation, ONLY JSON."""

        response = self.model.generate_content(prompt)
        return response.text

gemini_client = GeminiClient()

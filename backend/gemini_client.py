import asyncio
import re
from google import genai
from google.genai import types
from config import settings
from prompts import SYSTEM_INSTRUCTION, build_user_prompt, CONDENSATION_SYSTEM_PROMPT
from models import TokenUsage, CostData

client = genai.Client(api_key=settings.gemini_api_key)

# Gemini 2.5 Flash pricing (per 1M tokens)
INPUT_PRICE_PER_1M = 0.075
OUTPUT_PRICE_PER_1M = 0.30


def extract_usage(response) -> TokenUsage:
    """Extract token usage from Gemini API response."""
    meta = response.usage_metadata
    return TokenUsage(
        input_tokens=meta.prompt_token_count or 0,
        output_tokens=meta.candidates_token_count or 0,
        total_tokens=meta.total_token_count or 0,
        cached_tokens=getattr(meta, 'cached_content_token_count', 0) or 0
    )


def calculate_cost(usage: TokenUsage) -> CostData:
    """Calculate cost from token usage."""
    input_cost = (usage.input_tokens / 1_000_000) * INPUT_PRICE_PER_1M
    output_cost = (usage.output_tokens / 1_000_000) * OUTPUT_PRICE_PER_1M
    return CostData(
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=input_cost + output_cost
    )


class GeminiClient:
    def __init__(self):
        self.model = 'gemini-2.5-flash'

    async def analyze_workflow(
        self,
        code: str,
        framework_hint: str = None,
        metadata: list = None,
        correction_prompt: str = None,
        http_connections: str = None
    ) -> tuple[str, TokenUsage, CostData]:
        """Analyze code for LLM workflow patterns using Gemini."""
        user_prompt = build_user_prompt(code, metadata, http_connections)

        # If correction prompt provided, append it for retry
        if correction_prompt:
            user_prompt = f"{user_prompt}\n\n{correction_prompt}"

        # Use system_instruction parameter (not concatenated into content)
        # This is cached/optimized by the API and prevents verbose output
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.0,
            top_p=1.0,
            top_k=1,
            max_output_tokens=65536,
        )

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = await client.aio.models.generate_content(
                    model=self.model,
                    contents=user_prompt,
                    config=config,
                )

                # Check finish reason
                if response.candidates:
                    finish_reason = response.candidates[0].finish_reason
                    if finish_reason == 'MAX_TOKENS':
                        raise Exception("Output exceeded token limit. Try reducing batch size.")
                    elif finish_reason == 'SAFETY':
                        raise Exception("Response blocked by safety filters.")
                    elif finish_reason not in ['STOP', 'UNSPECIFIED', None]:
                        raise Exception(f"Generation failed: {finish_reason}")

                # Extract usage and calculate cost
                usage = extract_usage(response)
                cost = calculate_cost(usage)
                return response.text, usage, cost

            except Exception as e:
                error_str = str(e)
                if '429' in error_str or 'quota' in error_str.lower() or 'rate' in error_str.lower():
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        match = re.search(r'retry in ([\d.]+)', error_str, re.IGNORECASE)
                        if match:
                            wait_time = float(match.group(1)) / 1000 + 1
                        print(f"Rate limit hit, waiting {wait_time:.2f}s before retry {attempt + 1}/{max_retries}")
                        await asyncio.sleep(wait_time)
                    else:
                        raise
                else:
                    raise


    async def condense_repo_structure(self, raw_structure: str) -> tuple[str, TokenUsage, CostData]:
        """Condense raw repo structure into workflow-relevant summary.

        Takes tree-sitter extracted structure and returns a condensed version
        containing only LLM/AI workflow-relevant files and functions.
        """
        config = types.GenerateContentConfig(
            system_instruction=CONDENSATION_SYSTEM_PROMPT,
            temperature=0.0,
            top_p=1.0,
            top_k=1,
            max_output_tokens=8192,
        )

        user_prompt = f"""Analyze this codebase structure and identify LLM/AI workflows.

<raw_structure>
{raw_structure}
</raw_structure>

Output a condensed workflow structure following the system instructions."""

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = await client.aio.models.generate_content(
                    model=self.model,
                    contents=user_prompt,
                    config=config,
                )
                # Extract usage and calculate cost
                usage = extract_usage(response)
                cost = calculate_cost(usage)
                return response.text, usage, cost
            except Exception as e:
                error_str = str(e)
                if '429' in error_str or 'quota' in error_str.lower():
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        await asyncio.sleep(wait_time)
                    else:
                        raise
                else:
                    raise


    async def generate_metadata(self, prompt: str) -> tuple[str, TokenUsage, CostData]:
        """Generate metadata using a simple prompt (no workflow analysis).

        Used for incremental updates where we just need labels/descriptions.
        """
        config = types.GenerateContentConfig(
            temperature=0.0,
            top_p=1.0,
            top_k=1,
            max_output_tokens=8192,
        )

        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = await client.aio.models.generate_content(
                    model=self.model,
                    contents=prompt,
                    config=config,
                )

                # Check finish reason
                if response.candidates:
                    finish_reason = response.candidates[0].finish_reason
                    if finish_reason == 'SAFETY':
                        raise Exception("Response blocked by safety filters.")
                    elif finish_reason not in ['STOP', 'UNSPECIFIED', None, 'MAX_TOKENS']:
                        raise Exception(f"Generation failed: {finish_reason}")

                usage = extract_usage(response)
                cost = calculate_cost(usage)
                return response.text, usage, cost

            except Exception as e:
                error_str = str(e)
                if '429' in error_str or 'quota' in error_str.lower():
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        await asyncio.sleep(wait_time)
                    else:
                        raise
                else:
                    raise


gemini_client = GeminiClient()

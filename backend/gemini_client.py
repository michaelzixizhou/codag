import asyncio
import re
import google.generativeai as genai
from config import settings
from prompts import SYSTEM_INSTRUCTION, build_user_prompt

genai.configure(api_key=settings.gemini_api_key)


class GeminiClient:
    def __init__(self):
        self.model = genai.GenerativeModel(
            'gemini-2.5-flash',
            generation_config={
                'temperature': 0.0,
                'top_p': 1.0,
                'top_k': 1,
                'max_output_tokens': 65536,
            }
        )

    def _generate_sync(self, full_prompt: str):
        """Synchronous Gemini call - runs in thread pool."""
        response = self.model.generate_content(full_prompt)

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

    async def analyze_workflow(self, code: str, framework_hint: str = None, metadata: list = None) -> str:
        """Async wrapper - runs blocking Gemini call in thread pool with retry."""
        user_prompt = build_user_prompt(code, metadata)
        full_prompt = f"{SYSTEM_INSTRUCTION}\n\n{user_prompt}"

        max_retries = 3
        for attempt in range(max_retries):
            try:
                # Run blocking call in thread pool
                return await asyncio.to_thread(self._generate_sync, full_prompt)
            except Exception as e:
                error_str = str(e)
                if '429' in error_str or 'quota' in error_str.lower() or 'rate' in error_str.lower():
                    if attempt < max_retries - 1:
                        wait_time = 2 ** attempt
                        match = re.search(r'retry in ([\d.]+)', error_str, re.IGNORECASE)
                        if match:
                            wait_time = float(match.group(1)) / 1000 + 1
                        print(f"Rate limit hit, waiting {wait_time:.2f}s before retry {attempt + 1}/{max_retries}")
                        await asyncio.sleep(wait_time)  # Non-blocking sleep
                    else:
                        raise
                else:
                    raise


gemini_client = GeminiClient()

"""
Shared Groq/Cerebras key pool — imported by all workers that call LLM APIs.

Key priority order per worker type:
  signal_engine    → GROQ_API_KEY first
  intelligence     → GROQ_API_KEY_2 first
  others           → GROQ_BACKUP_API_KEY first
  all              → Cerebras as final fallback

Cerebras uses the same OpenAI-compatible API format as Groq,
just a different base URL.
"""
import os
import logging
import httpx
from datetime import datetime, timezone

log = logging.getLogger("groq_pool")

GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions"
CEREBRAS_BASE = "https://api.cerebras.ai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"
# Cerebras free tier only exposes gpt-oss-120b and zai-glm-4.7 (no Llama models).
CEREBRAS_MODEL = "gpt-oss-120b"


def _is_cerebras(key: str) -> bool:
    return key.startswith("csk-")


def _endpoint_and_model(key: str, model: str) -> tuple[str, str]:
    if _is_cerebras(key):
        return CEREBRAS_BASE, CEREBRAS_MODEL
    return GROQ_BASE, model


def _extract_content(data: dict) -> str | None:
    """Extract text from a chat completion response.

    Groq returns it in message.content. Cerebras gpt-oss-120b is a reasoning
    model that may put the answer in message.reasoning when content is empty.
    """
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None
    content = (msg.get("content") or "").strip()
    if content:
        return content
    reasoning = (msg.get("reasoning") or "").strip()
    return reasoning or None


def _load_keys(primary_names: list[str]) -> list[str]:
    """
    Build ordered key list: requested primaries first, then all others, Cerebras last.
    Deduplicates automatically.
    """
    all_names = (
        primary_names
        + ["GROQ_API_KEY", "GROQ_BACKUP_API_KEY"]
        + [f"GROQ_API_KEY_{i}" for i in range(2, 6)]
        + ["CEREBRAS_API_KEY", "CEREBRAS_API_KEY_2"]
    )
    keys = []
    seen = set()
    for name in all_names:
        k = os.environ.get(name, "").strip()
        if k and k not in seen:
            keys.append(k)
            seen.add(k)
    return keys


async def call_llm(
    prompt: str,
    *,
    primary_env_vars: list[str],
    max_tokens: int = 500,
    temperature: float = 0.3,
    model: str = DEFAULT_MODEL,
    system: str | None = None,
) -> str | None:
    """
    Call Groq or Cerebras with automatic key rotation and fallback.

    Args:
        prompt: User message
        primary_env_vars: Env var names to try first (e.g. ["GROQ_API_KEY_2"])
        max_tokens: Max tokens to generate
        temperature: Sampling temperature
        model: Groq model name (Cerebras equivalent auto-selected)
        system: Optional system message
    """
    keys = _load_keys(primary_env_vars)
    if not keys:
        log.warning("No LLM keys available")
        return None

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    for key in keys:
        is_cere = _is_cerebras(key)
        provider = "Cerebras" if is_cere else "Groq"
        url, m = _endpoint_and_model(key, model)
        try:
            async with httpx.AsyncClient(timeout=45) as c:
                r = await c.post(
                    url,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json={"model": m, "messages": messages, "max_tokens": max_tokens, "temperature": temperature},
                )
            if r.status_code == 200:
                content = _extract_content(r.json())
                if content:
                    return content
                log.warning(f"{provider} returned empty content — trying next key")
                continue
            if r.status_code == 429:
                log.debug(f"{provider} rate limited — trying next key")
                continue
            # Surface real errors (401 bad key, 404 bad model, etc.) so they aren't silent
            log.warning(f"{provider} error {r.status_code}: {r.text[:150]}")
        except Exception as e:
            log.warning(f"{provider} call failed: {e}")

    log.warning("All LLM keys exhausted")
    return None

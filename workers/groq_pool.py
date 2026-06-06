"""
Shared Groq/Cerebras key pool — imported by all workers that call LLM APIs.

Uses a global round-robin counter so calls are spread evenly across all
available Groq keys instead of piling onto one key until it's rate-limited.
Cerebras is always the final fallback.
"""
import os
import logging
import httpx
import itertools
import threading

log = logging.getLogger("groq_pool")

GROQ_BASE      = "https://api.groq.com/openai/v1/chat/completions"
CEREBRAS_BASE  = "https://api.cerebras.ai/v1/chat/completions"
DEFAULT_MODEL  = "llama-3.3-70b-versatile"
CEREBRAS_MODEL = "gpt-oss-120b"

# ── Global round-robin state ──────────────────────────────────────────────────
# Loaded once at first call, shared across all workers in the same process.
_groq_keys:    list[str] = []
_cerebras_keys: list[str] = []
_rr_counter   = itertools.count()   # thread-safe incrementing counter
_lock         = threading.Lock()
_keys_loaded  = False


def _load_all_keys() -> None:
    global _groq_keys, _cerebras_keys, _keys_loaded
    groq_names = (
        ["GROQ_API_KEY", "GROQ_BACKUP_API_KEY"]
        + [f"GROQ_API_KEY_{i}" for i in range(2, 8)]
    )
    cerebras_names = ["CEREBRAS_API_KEY", "CEREBRAS_API_KEY_2", "CEREBRAS_API_KEY_3"]

    groq_keys, cerebras_keys = [], []
    seen: set[str] = set()

    for name in groq_names:
        k = os.environ.get(name, "").strip()
        if k and k not in seen:
            groq_keys.append(k)
            seen.add(k)

    for name in cerebras_names:
        k = os.environ.get(name, "").strip()
        if k and k not in seen:
            cerebras_keys.append(k)
            seen.add(k)

    _groq_keys     = groq_keys
    _cerebras_keys = cerebras_keys
    _keys_loaded   = True
    log.info(f"groq_pool loaded: {len(_groq_keys)} Groq keys, {len(_cerebras_keys)} Cerebras keys")


def _ensure_loaded() -> None:
    global _keys_loaded
    if not _keys_loaded:
        with _lock:
            if not _keys_loaded:
                _load_all_keys()


def _extract_content(data: dict) -> str | None:
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None
    content = (msg.get("content") or "").strip()
    if content:
        return content
    reasoning = (msg.get("reasoning") or "").strip()
    return reasoning or None


async def call_llm(
    prompt: str,
    *,
    primary_env_vars: list[str] | None = None,
    max_tokens: int = 500,
    temperature: float = 0.3,
    model: str = DEFAULT_MODEL,
    system: str | None = None,
) -> str | None:
    """
    Call Groq with true round-robin load distribution across all keys,
    falling back to Cerebras if all Groq keys are rate-limited.

    primary_env_vars is accepted for backwards compatibility but ignored —
    the round-robin spreads load evenly regardless of which worker calls this.
    """
    _ensure_loaded()

    if not _groq_keys and not _cerebras_keys:
        log.warning("No LLM keys available")
        return None

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    # Round-robin starting index — each call gets a different starting key
    n = len(_groq_keys)
    start = next(_rr_counter) % n if n > 0 else 0

    # Try all Groq keys starting from round-robin offset
    for i in range(n):
        key = _groq_keys[(start + i) % n]
        try:
            async with httpx.AsyncClient(timeout=45) as c:
                r = await c.post(
                    GROQ_BASE,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json=payload,
                )
            if r.status_code == 200:
                content = _extract_content(r.json())
                if content:
                    log.debug(f"Groq key[{(start+i)%n}] succeeded")
                    return content
                log.warning(f"Groq key[{(start+i)%n}] returned empty content")
                continue
            if r.status_code == 429:
                log.debug(f"Groq key[{(start+i)%n}] rate limited — trying next")
                continue
            log.warning(f"Groq key[{(start+i)%n}] error {r.status_code}: {r.text[:120]}")
        except Exception as e:
            log.warning(f"Groq key[{(start+i)%n}] call failed: {e}")

    # All Groq keys exhausted — fall back to Cerebras
    for key in _cerebras_keys:
        try:
            async with httpx.AsyncClient(timeout=45) as c:
                r = await c.post(
                    CEREBRAS_BASE,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json={**payload, "model": CEREBRAS_MODEL},
                )
            if r.status_code == 200:
                content = _extract_content(r.json())
                if content:
                    log.info("Cerebras fallback succeeded")
                    return content
            if r.status_code == 429:
                log.debug("Cerebras rate limited")
                continue
            log.warning(f"Cerebras error {r.status_code}: {r.text[:120]}")
        except Exception as e:
            log.warning(f"Cerebras call failed: {e}")

    log.warning("All LLM keys exhausted")
    return None

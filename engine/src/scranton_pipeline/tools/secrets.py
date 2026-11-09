"""Best-effort credential filtering shared by all outward text boundaries."""
import re
import threading
from collections.abc import Iterable

_PATTERNS = {
    "private_key": re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)", re.DOTALL),
    "authorization": re.compile(r"(?i)\bauthorization\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+"),
    "bearer": re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"),
    "credential": re.compile(r'''(?i)(?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|(?![A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?=\s|[,};&]|$))[A-Za-z0-9_./+~-]+(?=\s|[,};&]|$))'''),
    "provider_key": re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b"),
    "url_credentials": re.compile(r"https?://[^\s/@:]+:[^\s/@]+@"),
}
_KNOWN: set[str] = set()
_LOCK = threading.RLock()


class Redactor:
    def __init__(self, secret_values: Iterable[str] = ()) -> None:
        with _LOCK:
            _KNOWN.update(value for value in secret_values if value)

    def redact(self, text: str) -> str:
        with _LOCK:
            known = sorted(_KNOWN, key=len, reverse=True)
        for value in known:
            text = text.replace(value, "[REDACTED]")
        for pattern in _PATTERNS.values():
            text = pattern.sub("[REDACTED]", text)
        return text

    def scan(self, text: str) -> list[str]:
        result = [name for name, pattern in _PATTERNS.items() if pattern.search(text)]
        with _LOCK:
            if any(value in text for value in _KNOWN):
                result.append("known_secret")
        return result

"""Best-effort credential filtering shared by all outward text boundaries."""
import re
import threading
from collections.abc import Iterable, Iterator

_PATTERNS = {
    "private_key": re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)", re.DOTALL),
    "authorization": re.compile(r"(?i)\bauthorization[ \t]*:[ \t]*(?:basic|bearer|token)[ \t]+[^\s\"'{};,&]+"),
    "bearer": re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"),
    "credential": re.compile(
        r'''(?im)(?P<line>^[ \t]*+(?:export[ \t]+)?)?(?P<pair>[?&;])?(?<!\w)["']?'''
        r'''(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)["']?'''
        r'''(?P<before>[ \t]*+)(?P<separator>[:=])(?P<after>[ \t]*+)'''
        r'''(?P<value>"(?:[^"\\\r\n]|\\[^\r\n])*+"|'(?:[^'\\\r\n]|\\[^\r\n])*+'|[^\s"'{}\[\],; &()]+)'''
    ),
    "provider_key": re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b"),
    "url_credentials": re.compile(r"https?://[^\s/@:]+:[^\s/@]+@"),
}
_KNOWN: set[str] = set()
_LOCK = threading.RLock()


_NAME = re.compile(r"[A-Za-z_$][\w$]*")
_ATTRIBUTE = re.compile(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+")
_CONSTANTS = {"none", "true", "false", "null", "undefined"}
_TYPES = {"str", "string", "int", "float", "bool", "boolean", "bytes", "object", "any", "number"}


def _credential_is_secret(match: re.Match[str], *, in_parentheses: bool = False) -> bool:
    value = match["value"]
    if value[0] in "\"'":
        return True
    if value.casefold() in _CONSTANTS:
        return False
    end = match.end()
    text = match.string
    while end < len(text) and text[end] in " \t":
        end += 1
    following = text[end:end + 1]
    if following in ("(", "[") or _ATTRIBUTE.fullmatch(value):
        return False
    if match["separator"] == ":" and (value.casefold() in _TYPES or following == "|"):
        return False
    if not _NAME.fullmatch(value) or any(char.isdigit() for char in value) or len(value) >= 32:
        return True
    # Compact free-text pairs are data; call keyword arguments remain code bindings.
    return match["pair"] is not None or following in (";", "&") or (
        match["separator"] == "=" and not match["before"] and not match["after"]
        and not in_parentheses
    ) or (match["separator"] == ":" and match["line"] is not None)


def _secret_credentials(text: str) -> Iterator[re.Match[str]]:
    cursor = 0
    brackets: list[str] = []
    parentheses = 0
    quote = ""
    escaped = False
    for match in _PATTERNS["credential"].finditer(text):
        # Advance once across the input, retaining call context across line breaks.
        while cursor < match.start():
            char = text[cursor]
            cursor += 1
            if escaped:
                escaped = False
            elif quote:
                if char == "\\":
                    escaped = True
                elif char == quote or char in "\r\n":
                    quote = ""
            elif char in "\"'":
                quote = char
            elif char in "([{":
                brackets.append(char)
                parentheses += char == "("
            elif (char in ")]}" and brackets
                  and brackets[-1] == {")": "(", "]": "[", "}": "{"}[char]):
                parentheses -= brackets.pop() == "("
        if _credential_is_secret(match, in_parentheses=parentheses > 0):
            yield match


def _redact_credentials(text: str) -> str:
    parts: list[str] = []
    end = 0
    for match in _secret_credentials(text):
        parts.extend((text[end:match.start()], "[REDACTED]"))
        end = match.end()
    parts.append(text[end:])
    return "".join(parts)


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
            text = (_redact_credentials(text) if pattern is _PATTERNS["credential"]
                    else pattern.sub("[REDACTED]", text))
        return text

    def scan(self, text: str) -> list[str]:
        result = [name for name, pattern in _PATTERNS.items()
                  if (next(_secret_credentials(text), None) is not None
                      if name == "credential" else pattern.search(text))]
        with _LOCK:
            if any(value in text for value in _KNOWN):
                result.append("known_secret")
        return result

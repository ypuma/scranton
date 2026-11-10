"""Value-aware credential regressions, including legacy data-pair syntax."""
import time

import pytest

from scranton_pipeline.tools.secrets import Redactor

MUST_REDACT = [
    ('password="actual credential"', 'actual credential'),
    ('password = "correct horse battery"', 'correct horse battery'),
    ("password = 'correct horse battery'", 'correct horse battery'),
    ('password = "escaped \\"quote\\" value"', 'quote'),
    ('password=p@ssw0rd', 'p@ssw0rd'),
    ('password = p@ssw0rd', 'p@ssw0rd'),
    ('secret:1', '1'),
    ('password=hidden', 'hidden'),
    ('registered-value Bearer abcdef password=hidden sk-abcdefghijklmnop', 'hidden'),
    ('log password=hidden next=value', 'hidden'),
    ('run --api_key=key --verbose', 'key'),
    ('connected token=opaquevalue successfully', 'opaquevalue'),
    ('result (ready) password=hidden done', 'hidden'),
    ('f(x) password=hidden done', 'hidden'),
    ('log password=hidden api_key=opaquevalue end', 'opaquevalue'),
    ('log "(" password=hidden done', 'hidden'),
    ('password=x;', 'x'),
    ('api_key=x&', 'x'),
    ('?password=hidden&next=ok', 'hidden'),
    ('https://example.test/?password=opaquevalue', 'opaquevalue'),
    ('API_KEY=opaquevalue\nNEXT=value', 'opaquevalue'),
    ('API_KEY=opaquevalue\r\nNEXT=value', 'opaquevalue'),
    ('Cookie: secret=hidden; next=ok', 'hidden'),
    ('API_KEY=sk_live_123456789abcdef', 'sk_live_123456789abcdef'),
    ('export API_KEY=opaquevalue', 'opaquevalue'),
    ('  API_KEY=opaquevalue', 'opaquevalue'),
    ('access_token = abc123', 'abc123'),
    ('token = abc123', 'abc123'),
    ('secret = AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf', 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf'),
    ('password: p@ssw0rd', 'p@ssw0rd'),
    ('password: "correct horse battery"', 'correct horse battery'),
    ('{"password": "correct horse battery"}', 'correct horse battery'),
    ('{"api_key": "key with spaces"}', 'key with spaces'),
    ('const config = {password: "p@ssw0rd"};', 'p@ssw0rd'),
    ('Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'),
    ('Authorization: Token abc123opaque', 'abc123opaque'),
    ('Authorization: Bearer <token>', '<token>'),
    ('Authorization: Bearer abc123opaque', 'abc123opaque'),
    ('{"Authorization": "Token abc123opaque"}', 'abc123opaque'),
    ('password = 123456;', '123456'),
    ('api-key: abc-xyz', 'abc-xyz'),
]

MUST_KEEP = [
    'password: str',
    'api_key: str | None = None',
    'f(password=password, x)',
    'f(password=password)',
    'Client(api_key=key)',
    'Client(\n    api_key=key,\n)',
    'f(\n    password=password,\n    x=x,\n)',
    'outer(\n    inner(password=password),\n    api_key=key,\n)',
    'f(items=[value], password=password, x=x)',
    'f(label=")", password=password)',
    'def f(password: str = None): pass',
    'f(password = password, x)',
    'password: string;',
    'interface Config { password: string; }',
    'token = None',
    'secret=True',
    'password = False',
    'password = null',
    'password = undefined',
    'API_KEY=None',
    'secret: true',
    'password = True',
    'password = None',
    'password = True;',
    'token = False',
    'token = null',
    'token = undefined',
    '{"secret": false}',
    '{"password": null}',
    'self.api_key = api_key',
    'password = password',
    'api_key = key',
    'secret = settings.secret',
    'password = get_password()',
    "api_key = os.getenv('KEY')",
    'password = get_password() and self.token.value',
    'self.token.value',
    'password = settings.password',
    'password = get_password (argument)',
    'password: Optional[str]',
    'api_key: str | None',
    'const password = credentials.password;',
    'let token = undefined;',
    'let secret = true;',
    'f(api_key=api_key, secret=False)',
    'notpassword = "ordinary text"',
]


@pytest.mark.parametrize('text,secret', MUST_REDACT)
def test_secret_values_redact(text, secret):
    # Guard: restoring the old credential regex leaks special characters, spaces and Token headers.
    redactor = Redactor()
    assert secret not in redactor.redact(text)
    assert '[REDACTED]' in redactor.redact(text)
    assert 'credential' in redactor.scan(text)


@pytest.mark.parametrize('text', MUST_KEEP)
def test_redact_keeps_code_values(text):
    # Guard: removing _credential_is_secret's value checks masks annotations, constants and names.
    redactor = Redactor()
    assert redactor.redact(text) == text
    assert redactor.scan(text) == []


@pytest.mark.parametrize('text', [
    'password = "' + '\\' * 200_000,
    'password = ' + 'a' * 200_000 + '(',
    'password' * 25_000 + ' = name',
    'password=' + 'a' * 200_000,
])
def test_redact_adversarial_line_linear(text):
    start = time.perf_counter()
    redactor = Redactor()
    redactor.redact(text)
    redactor.scan(text)
    assert time.perf_counter() - start < 0.5

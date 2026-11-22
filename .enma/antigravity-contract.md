# Google Antigravity integration (own runtime)

Provider ID google-antigravity; label Google Antigravity; OAuth only. google/Gemini remains an independent API-key provider. CLI login antigravity uses the same credentials facade as Accounts. No Pi native-provider registration, extension loading, Docker inference broker or token projection remains.

OAuth/PKCE, complete redirect URL and state validation live in src/core/antigravity/oauth.js, adapted by src/core/credentials/oauth.js. Callback is http://localhost:51121/oauth-callback. Project assignment comes from Google's service; missing assignment fails closed, never invent a project. Login timeout/cancellation and sanitized status follow `.enma/auth-contract.md`. Credentials and refresh share the own store's cross-process lock, never a Pi runtime lock. Pi profiles are one-time read-only import sources only.

Inference is src/core/llm/google-antigravity.js, using the shared canonical message/block/usage contract in `.enma/llm-contract.md`. Tool IDs and thought signatures survive request/result round-trips. The catalogue includes gemini-3-pro and gemini-3-flash; listing does not guarantee endpoint compatibility, entitlement or free quota. Own LLM calls remain on the host in native, Docker and explicit trusted-host modes. Docker executes tools only, with no inference capability token.

The connection is an unofficial third-party client. Offline fake HTTP/credential/stream tests do not prove real Google login, service acceptance, quota, native browser behavior or model entitlement. Historical Pi-extension/broker probes are not tests of this runtime. Refresh of imported credentials can require signing in again in the separate Pi CLI.

# Scranton authentication contract

Own-runtime revision, 2026-11-21. This supersedes the Pi storage/runtime semantics of the original subscription sign-in contract. HTTP/CLI method names and public shapes remain stable. No real-provider acceptance, entitlement, native browser or Docker execution is implied by offline tests.

## Storage and ownership

- `src/core/auth.js` is the synchronous-construction integration facade over `createCredentials()` in `src/core/credentials/index.js`. Its asynchronous operations wait for initialization and the one-time import. `listAccounts`, `listProviders`, `getLogin` and `startLogin` remain synchronous and network-free (login starts asynchronous work).
- Credentials and custom declarations live in `store.json` under `%APPDATA%\dev.scranton.desktop\credentials` on Windows, `~/Library/Application Support/dev.scranton.desktop/credentials` on macOS, or `$XDG_DATA_HOME/dev.scranton.desktop/credentials` on Linux (default `~/.local/share`). `SCRANTON_CREDENTIALS_DIR` overrides the directory. See `src/core/credentials/README.md` for locking, permissions, metadata and import format.
- Only the credentials module's one-time import reads Pi `auth.json`/`models.json`, honoring `PI_CODING_AGENT_DIR`. Existing Scranton entries win. The marker and imported state commit together. No subsequent auth/provider/model-window operation reads or writes a Pi profile. Legacy `authPath` and `runtimeFactory` integration options are rejected; tests inject `dir`/`store`/`oauth` instead.
- Writes, refresh and custom-provider/key mutations use the own store's cross-process lock and atomic replacement. Permanent renewal metadata (`expires`, `failedAt` only) lives in the same transaction. The store is private app data, not an encrypted OS keychain.
- Corrupt own-store data fails closed without overwrite. `listAccounts()` returns safe error rows for the five primary accounts. JSONC is accepted on one-time import only, never for normal own-store writes. Legacy provider files and backups are no longer managed.

## Providers and accounts

Always listed:

| id | label | methods |
|---|---|---|
| anthropic | Claude (Pro/Max) | oauth, api_key |
| openai | ChatGPT | oauth, api_key |
| google | Gemini | api_key |
| google-antigravity | Google Antigravity | oauth |
| google-vertex | Google Vertex AI | api_key |

`listAccounts()` returns `[{ id, label, status:'signed_in'|'signed_out'|'expired'|'error', kind:'oauth'|'api_key'|null, methods:string[], mode?:'direct'|'chatgpt', expiresAt?:ISO, renewsOnUse?:boolean, renewFailedAt?:ISO, detail?:string, custom?:boolean, baseUrl?:string, api?:string }]`.

- Also includes stored credential IDs and all own custom declarations. A stored unsupported credential can be inspected/logout, but does not advertise an unsupported built-in client or models.
- Stored credentials win over environment keys. Malformed stored credentials block ambient fallback. API keys are literal: trim surrounding spaces, reject empty, embedded whitespace, controls, `!`/`$` prefixes and more than 4096 characters. No command execution or environment interpolation in stored keys.
- Renewable expired OAuth access remains `signed_in` with `renewsOnUse:true`. Only refresh-specific 400/401 or permanent OpenAI direct-grant errors mark `expired`/`renewFailedAt`. Temporary network, timeout, lock and insufficient-validity failures do not. Successful refresh/login/key/logout clears failure metadata; changed expiry invalidates stale metadata.
- `listProviders()` -> `{providers:[{id,label,methods}]}` lists only built-ins supported by the own LLM catalogue plus declared custom providers. The former broad Pi picker (Bedrock, Cloudflare, etc.) is no longer offered as built-in support. Configure compatible endpoints as explicit custom providers. Some imported names reserved by the credentials layer remain reserved there; auth integration validates against the supported built-in catalogue.
- `listModels()` -> `{providers:[{id,label,signedIn:true,models:[{id,name,reasoning?,contextWindow?}]}]}` joins signed-in accounts with `src/core/llm/catalogue.js` and custom declarations. No network discovery or token refresh; rejected/error/signed-out credentials do not advertise available models. Custom model names default to their IDs. Catalogue order is not an Automatic selection rule.
- `createModelRuntime()` remains an offline compatibility adapter exporting `getModel`, `getModels`, `getAllModels`, `getAvailable`, `close`; it is not a Pi runtime and cannot register extensions or perform Pi login.

## Login lifecycle and token minting

- `startLogin(provider,{method='browser'}={})` -> `{id}`. One login/credential mutation at a time. Supported OAuth providers are anthropic, openai and google-antigravity. OpenAI additionally supports `device_code` through the service API.
- Session: `{id,provider,state:'starting'|'waiting_browser'|'waiting_code'|'completing'|'done'|'failed'|'cancelled',authUrl?,userCode?,verificationUri?,message?,error?,startedAt}`.
- `getLogin()`, `waitForLogin()`, `input(id,value)`, `cancel(id)`, `openLogin(id)` retain their shapes. Input is 1..4096 characters; wrong/stale session or wrong state gives 409. Timeout ten minutes; cancel aborts OAuth and closes callback listeners. Saved credentials win cancellation after the save completes. Browser opening never blocks login completion/cancellation; only validated stored URLs may be reopened, at most once per two seconds.
- Browser launches use argv only, no shell; HTTPS authorization hosts are allowlisted (`claude.ai`, `auth.openai.com`, `accounts.google.com`). URL credentials, nondefault ports, fragments and token/secret query keys are rejected. Provider diagnostics, entered codes and secrets never appear in session/status results.
- Anthropic PKCE callback port 53692; manual input requires `code#state` or a complete redirect URL with matching state, never a bare code. OpenAI direct dynamic-client callback port 1455; complete redirect URL and issued client ID required. Device/Codex grants carry explicit ChatGPT backend mode, distinct from direct Responses grants.
- Antigravity PKCE callback port 51121 and complete state-matching redirect URL. Project assignment comes from Google's service; no project is invented. OAuth stays in `antigravity/oauth.js`, adapters in credentials, inference in llm. No Gemini-key fallback and no cross-provider logout.
- `mintAccessToken(provider,{minExpiryMs})` returns a raw OAuth access-token string (including Antigravity), never refresh data. `minExpiryMs` must be finite and nonnegative. Credentials errors retain fixed safe codes including `SCRANTON_OAUTH_TEMPORARY`, `SCRANTON_OAUTH_REJECTED`, `SCRANTON_AUTH_MISSING`. Consumers must not assume Pi's serialized Antigravity `{token,projectId}` envelope.
- `checkRenewals(accounts?)` explicitly starts background renewal: one pending request and five-minute cooldown per provider, twenty-second caller deadline, suppressed while login/key operations run and after close. GET snapshots never await renewal. `close()` cancels pending login and joins renewals.

## Custom providers and discovery

- `addProvider({id,label?,baseUrl,api,models,key})` atomically commits definition and literal key to the own store. Duplicate or unmanaged credential IDs conflict (409); no repair-by-overwrite. `removeProvider(id)` removes only a declared own provider and its credential/renewal metadata; unknown IDs give 409.
- ID `^[a-z][a-z0-9-]{1,31}$`, not a supported built-in. APIs: openai-completions, openai-responses, anthropic-messages. HTTPS required except loopback HTTP; no URL credentials/query/fragment. Label <=120 characters. Declare 1..256 unique models, IDs <=256 without whitespace/controls, optional positive safe-integer contextWindow/maxTokens, boolean reasoning, input text/image. Unexpected fields are rejected. Metadata must not contain the key.
- `discoverModels({baseUrl,api,key})` -> `{models:[{id,contextWindow?,maxTokens?}]}` fetches `<baseUrl>/models`. Ten-second timeout includes streamed body; 1 MiB advertised/streamed cap, at most 256 models. Key only in Authorization, never echoed. Redirects require identical origin including scheme/port; no URL credentials/query/fragment. Network/response errors give sanitized 502. No automatic discovery on add.
- `createProviderStore(dir)` remains a network-free metadata adapter over own `store.json`, not Pi models.json. Missing/corrupt data yields an empty list plus safe `getDetail()`; mutations use the own lock and cannot overwrite conflicting entries.

## HTTP control routes (unchanged)

Behind loopback peer/Host, matching Origin when present, `X-Scranton-Client: 1`, JSON and existing size limits. All are 404 without control and for wrong methods. POST bodies must be objects with no unexpected fields.

- `GET /api/auth` -> `{accounts:[...],login:session|null}`; snapshots first, then starts background renewal.
- `POST /api/auth/login {provider}` -> `202 {id}`; unknown 400, busy 409.
- `POST /api/auth/login/input {id,value}` -> 202.
- `POST /api/auth/login/cancel {id}` -> 202.
- `POST /api/auth/login/open {id}` -> `202 {ok:true}`; no caller URL; stale 409, throttle 429, sanitized spawn failure 500.
- `POST /api/auth/logout {provider}`, `POST /api/auth/key {provider,key}` -> `202 {ok:true}`.
- `GET /api/auth/providers` -> `{providers:[{id,label,methods}]}`.
- `GET /api/models` -> listModels result.
- `POST /api/providers/discover {baseUrl,api,key}` -> `200 {models:[...]}`.
- `POST /api/providers {id,label?,baseUrl,api,models,key}`, `POST /api/providers/remove {id}` -> `202 {ok:true}`.
- `GET /api/control` retains `defaults.models` for configured agent refs; `POST /api/runs` model overrides continue validating against listModels and THINKING_LEVELS, producing per-role environment IDs, not config writes.

## CLI and UI consumers

`login <claude|chatgpt|antigravity>` uses the same OAuth session. `login gemini` and `login <provider> --api-key` read keys from hidden prompt/stdin, never argv. `logout`, `accounts`, and `provider add/remove` retain their external forms. Accounts/UI selectors use metadata only. Dark monochrome UI, browser retry, manual input and poll semantics remain unchanged; no UI files are changed by this port.

`doctor` reports Node, credential metadata, the exact runner Automatic rule (Claude -> OpenAI -> Gemini -> Antigravity -> Vertex, explicit newest-per-provider markers in `llm/catalogue.js`; ChatGPT mode uses user-chosen `gpt-6.2-sol`, while direct OAuth/API keys use the API catalogue. Markers require updates for new releases), rg/fd PATH availability with native fallbacks, shells, and native sandbox `available()`. Active configured/default model availability is checked offline; no Pi subprocess/version/auth check or provider refresh occurs.

## Tool-only Docker boundary

LLM clients, credentials and refresh run on the host in every Team sandbox mode. Docker receives no provider credentials, custom-provider projections, session files or prompts. The old inference broker and Docker extension are removed. Any retained resolveDockerCredential compatibility API is not the tool executor's credential path.

Pi import is one-time and read-only. Scranton refreshes its independent stored copy; refresh-token rotation can require Pi CLI users to sign in again in Pi afterward. Gemini's google account is currently API-key-only; Google-account OAuth is google-antigravity, not an implemented google OAuth login.

# Scranton credentials

Node ESM credential store and OAuth facade used by the agent runtime and `src/core/auth.js`
for CLI, server and desktop authentication. No Pi imports or network requests on import or while listing accounts.

```js
import { createCredentials } from './src/core/credentials/index.js';
const credentials = await createCredentials();
const llm = createLLM({ resolveAuth: credentials.resolveAuth });
// On shutdown:
await credentials.close();
```

## Location and disk format

`SCRANTON_CREDENTIALS_DIR` overrides the directory (relative paths resolve from the process working directory; a leading `~` expands to the user home). Otherwise the module follows Tauri's `dev.scranton.desktop` app-data identifier, not a project, Hive, or Pi profile:

- Windows: `%APPDATA%\dev.scranton.desktop\credentials` (fallback `~/AppData/Roaming/...`).
- macOS: `~/Library/Application Support/dev.scranton.desktop/credentials`.
- Linux: `$XDG_DATA_HOME/dev.scranton.desktop/credentials`, default `~/.local/share/dev.scranton.desktop/credentials`.

These intentionally use desktop app **data**, rather than XDG config. Desktop/scratch profiles should pass the explicit credentials override; `SCRANTON_DATA` is not implicitly treated as a credential directory.

Under node:test, presence of `NODE_TEST_CONTEXT` in either `process.env` or the supplied
`env` disables implicit user paths, even if the supplied env omits the test marker.
Pass `dir` or `SCRANTON_CREDENTIALS_DIR` in that env for the store. Before the first
import, also pass `source` to `store.initialize()` or `PI_CODING_AGENT_DIR` in its env.
An explicit store path does not authorize the default Pi source (or vice versa).
`APPDATA`, `XDG_DATA_HOME`, and injected `home` do not bypass these guards. A committed
import marker needs no source override because subsequent initialization does not import.
Both refusals use `SCRANTON_CREDENTIAL_STORE` with actionable messages and occur before
creating directories or reading legacy files. Explicit paths retain normal `~` expansion.

`store.json` has version 1 and contains:

- `credentials`: provider-id dictionary of `{type:'api_key', key}` or `{type:'oauth', access, refresh, expires, ...}`. Expiry is epoch milliseconds. Optional OAuth metadata includes `accountId`, `projectId`, `clientId`, `scopes`, `grantKind`, and `mode`.
- `providers`: provider-id dictionary of `{id,label,baseUrl,api,models}`. Models contain projected IDs, token limits, reasoning and input modalities only. Keys never go into provider declarations.
- `renewals`: provider-id dictionary of `{expires,failedAt}` for permanent refresh rejection. No provider diagnostics or token values.
- `deviceId`: stable installation UUID for ChatGPT client registration.
- `import`: `{at,source,imported:{credentials:[],providers:[]},skipped:[]}`. No secrets.

All mutations, including refresh, share a mkdir `.lock` mutex with a PID/UUID owner claim. Lock acquisition re-reads the current store before modifying it. Claims whose PID no longer exists are recovered; live owners are never evicted merely because they are old. Empty/malformed abandoned locks fail closed after the wait deadline with explicit manual recovery guidance. This avoids unsafe time-based stealing of a live lock. Writes use exclusive same-directory temporary files, fsync and atomic replacement; POSIX also fsyncs the directory. POSIX directories/files use 0700/0600. Windows relies on the user's app-data ACL; this is not an encrypted OS keychain.

## One-time import

`createCredentials()` initializes/imports before returning. It reads only `auth.json` and `models.json` from `PI_CODING_AGENT_DIR` (leading `~` supported), otherwise `~/.pi/agent`. It never reads settings or writes to the source. JSONC comments, BOM and trailing commas are accepted on import only. Literal keys and models.json `$ENV_NAME` references are converted to stored literal keys; commands are never executed. Malformed individual credentials become a null sentinel to block ambient fallback. Unsupported provider declarations are skipped and listed by ID. Corrupt source JSON fails closed without an import marker, allowing repair and retry. Existing Scranton records win. The marker and imported state commit together; later initialization never reads Pi again.

## Public API

`await createCredentials(options)` returns:

- `resolveAuth(providerId, {minExpiryMs=60000,signal}={})`: client-only LLM contract Auth value: `{type:'api_key',key}` or `{type:'oauth',access,accountId?,projectId?,mode?}`. Never returns refresh tokens or other stored metadata. Valid tokens resolve without locking/writing; refresh re-reads under the lock and unchanged transactions do not rewrite the store. Stored credentials win over environment keys. A malformed stored record blocks environment fallback. `ANTHROPIC_API_KEY`, then `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_AUTH_TOKEN` retain their precedence; the explicitly named OAuth environment token returns OAuth auth. Other standard environment names are exported as `PROVIDER_ENV_NAMES`. Custom keys are explicit stored credentials, not implicit environment lookups.
- `listAccounts()` / `listProviders()`: synchronous and network-free; account/session shapes follow `.enma/auth-contract.md`. Renewable expired access tokens remain `signed_in` with `renewsOnUse`; only refresh-specific 400/401 or permanent direct-grant errors mark `expired`/`renewFailedAt`.
- `setApiKey(provider,key)`, `logout(provider)`, `addProvider({...definition,key})`, `removeProvider(id)`: locked atomic mutations. Imported custom definitions become Scranton-managed copies; their Pi originals are untouched.
- `mintAccessToken(provider,{minExpiryMs})`: OAuth access token only. Insufficient validity is temporary and does not invalidate the account.
- `startLogin(provider,{method='browser'}={})` -> `{id}`, `getLogin()`, `waitForLogin()`, `input(id,value)`, `cancel(id)`, `openLogin(id)`: UI/CLI session facade. One login/key operation at a time, ten-minute timeout, two-second browser reopen throttle. A saved login wins late cancellation. Browser launch never blocks completion/cancellation.
- `checkRenewals(accounts?)`: explicitly starts background renewal, one pending attempt and five-minute cooldown per provider. `close()` cancels login and joins renewals.
- `store`: low-level `get`, `set`, `delete`, `read`, `transaction`, `initialize`, `dir`, `file`. `read` and `get` return secrets and are for trusted runtime code only; never serialize them to the UI.

Dependency injection: `env`, `dir`, `store`, `oauth`, `opener`, `now`, `onChange`, and validity/timeouts. `createOAuthProviders({fetcher,now,endpoints,antigravity})` allows loopback fake endpoints and returns provider adapters with `login(io,options)` and `refresh(credential,signal)`. Interaction IO uses `notify({type:'auth_url'|'device_code'|'progress',...})` and `prompt({type:'manual_code',message,signal})`; callers must honor prompt abort signals. Direct adapter use has a ten-minute login / twenty-second refresh deadline. Errors discard provider response bodies and causes. No module logging contains credentials. Error-code classification at the LLM boundary is listed in `.enma/llm-contract.md`: temporary renewal failures and lock contention are retryable; missing/invalid credentials, rejected refresh, cancellation and store/configuration failures are permanent with safe actionable messages.

## OAuth and runtime integration

Anthropic uses S256 PKCE on port 53692 with a loopback/manual-code race. Manual input requires exactly `code#state` with the matching state, or the complete redirect URL; bare codes are rejected with a corrective prompt. OpenAI browser login independently implements the **dynamic direct-token** protocol studied in Pi 1.5.2, issued callback client ID, direct scope validation, persistent installation UUID, and port 1455; manual input requires the complete callback URL. OpenAI device login uses the public Codex client and device endpoints; it returns `grantKind:'codex'`, `mode:'chatgpt'`, and the account claim needed by the backend LLM path. Legacy imported account-ID-only OpenAI grants also resolve with explicit `mode:'chatgpt'`; direct grants keep `clientId` and scopes and use the direct Responses path. This matches the revised `.enma/llm-contract.md` auth distinction.

Antigravity imports `createOAuth` from the existing `../antigravity/oauth.js` (no Pi provider/stream imports). It keeps port 51121, complete-redirect/state validation, Google refresh and real project discovery semantics. A missing project fails closed; no project is invented.

`src/core/auth.js` wraps this facade for account, login, key, renewal and mint operations; custom-provider mutations use the same store with integration-layer validation. Model listing joins the own LLM catalogue with signed-in accounts and stored custom models; OpenAI OAuth uses the separate ChatGPT/Codex model snapshot, while OpenAI API keys keep the API catalogue. Imported `google-vertex` API keys use the Vertex express-mode client (no ADC/service-account lookup); model discovery remains in `src/core/providers.js`. Agents resolve credentials on the host; Docker tools receive no credential or broker projection. `resolveAuth` and `store.read` are not HTTP APIs. Legacy `authPath`/`runtimeFactory` options are rejected; callers use `SCRANTON_CREDENTIALS_DIR`, and Pi paths are import-only.

Protocol endpoints, public client IDs/scopes, environment-name facts and token field semantics were studied in installed Pi MIT sources; the algorithms here were independently implemented, not imported/copied wholesale. Antigravity project/client metadata comes from Scranton's existing provider. Real-provider acceptance, account entitlements, browser behavior on native OSes and POSIX permission enforcement cannot be verified by the Windows offline suite. The 2026-11-22 scoped live retest accepted GPT-6.2 Sol on ChatGPT and Gemini 3.8 Flash Low on Antigravity; the imported Vertex key was rejected by the express endpoint (HTTP 401), so that account remains unverified.

Tests: `node --test "test/core/credentials/*.test.js"`. All endpoints/fixtures are fake and project-local. No real sign-in or model call is performed.

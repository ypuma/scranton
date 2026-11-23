# Providers and models

Connect an account, select models, or register a compatible custom endpoint.

[Back to the README](../../README.md)

## Sign-in

```powershell
node bin/scranton.js login claude
node bin/scranton.js login chatgpt
node bin/scranton.js login antigravity
node bin/scranton.js login gemini
node bin/scranton.js login openrouter --api-key
node bin/scranton.js accounts
node bin/scranton.js logout claude
# Alternatively: node bin/scranton.js logout chatgpt
```

**Google Antigravity** uses Google account OAuth (`login antigravity`, provider `google-antigravity`) through Scranton's credential adapter and LLM client. Use the full redirect URL, including state. Google's service resolves the project; setup fails without one. This is an unofficial third-party integration, with no guarantee of model entitlement or free quota. LLM requests and tokens stay on the host even with Docker; there is no Team inference broker.

**Gemini** is separate and uses an API key from [Google AI Studio](https://aistudio.google.com/apikey). `login gemini` (provider `google`) and `login <provider> --api-key` take a key through hidden input or stdin, never as a command-line argument. Use literal keys: embedded whitespace and control characters are not allowed, nor are `!` and `$` prefixes. A stored Claude or ChatGPT API key replaces the saved subscription credential for that provider.

OAuth `login` opens the system browser and also prints the sign-in URL in the terminal. Complete the sign-in in the browser and, if prompted, paste the authorization code or full redirect URL into the terminal. Each server or CLI process handles at most one login at a time, with a ten-minute timeout. `accounts` shows status without refreshing tokens; `logout` only removes the selected provider's stored credential.

In the controlled web dashboard and desktop app, **Accounts** manages logins, API keys, and custom providers. **New run** and follow-ups use the signed-in Scranton catalogue. Leaving a role blank uses its agent default or, if none is set, **Automatic**. Model and Thinking overrides apply to that run in all Team sandbox modes; they do not write a config file. Alternatively, set `agents.<role>.provider` and `agents.<role>.model` or `SCRANTON_<ROLE>_PROVIDER` and `SCRANTON_<ROLE>_MODEL`.

## Automatic selection

Automatic uses the first signed-in supported account in a fixed order: Anthropic, OpenAI/ChatGPT, Gemini, Antigravity, Vertex. Model selection follows explicit newest markers in the local catalogue, not alphabetical order or a live query. New releases require a catalogue update.

| Priority | Provider | Catalogue choice (22 November 2026) |
| --- | --- | --- |
| 1 | Anthropic | `claude-opus-5-5` |
| 2 | OpenAI/ChatGPT | `gpt-6.2-sol` for ChatGPT, explicitly pinned |
| 3 | Gemini | `gemini-4-argon` |
| 4 | Antigravity | `gemini-3.8-flash` |
| 5 | Vertex | `gemini-4-argon` |

Antigravity uses offered Low/Medium/High wire IDs, not disabled Gemini 4 entries. ChatGPT OAuth has a separate Codex catalogue; OpenAI API keys use the API catalogue. Vertex supports Express Mode keys (`GOOGLE_CLOUD_API_KEY` or an imported/stored key), not ADC or service account files. With no eligible account, selection fails. Custom providers must be explicitly selected; explicit provider/model pairs take precedence. The same rules apply in every Team sandbox mode. A catalogue entry is not proof of current account or model entitlement.

## Credential storage

Scranton stores credentials and custom provider definitions in `store.json` under:

| OS | Credential directory |
| --- | --- |
| Windows | `%APPDATA%\dev.scranton.desktop\credentials` |
| macOS | `~/Library/Application Support/dev.scranton.desktop/credentials` |
| Linux | `$XDG_DATA_HOME/dev.scranton.desktop/credentials` (default `~/.local/share/dev.scranton.desktop/credentials`) |

`SCRANTON_CREDENTIALS_DIR` overrides this directory. On first initialization Scranton imports Pi logins and providers once from `PI_CODING_AGENT_DIR` or `~/.pi/agent`; existing Scranton entries win. Scranton does not read or write the Pi profile after the import. Pi CLI users may need to sign in again after Scranton refreshes imported tokens. The store is private app data, not an encrypted OS keychain.

Docker runs only tool subprocesses. Provider keys, OAuth tokens, prompts, and sessions are not projected into the container. `--sandbox-network none` blocks container tool networking, not model requests made on the host.

Offline and scripted tests do not demonstrate live OAuth acceptance, model entitlement, or native macOS/Linux isolation. Provider terms and shared subscription rate limits still apply. Historical Pi or broker tests do not verify Scranton's own runtime.

## Custom providers

Example for **abliteration.ai** (key through hidden input or stdin only):

```powershell
node bin/scranton.js provider add abliteration --base-url https://api.abliteration.ai/v1 --api openai-completions --discover --label abliteration.ai
node bin/scranton.js provider remove abliteration
```

`--discover` requests `https://api.abliteration.ai/v1/models`; alternatively, declare model IDs with `--models a,b`. Supported API types: `openai-completions`, `openai-responses`, and `anthropic-messages`. Base URLs require HTTPS (HTTP only on loopback), with no embedded credentials, query, or fragment. Discovery follows only same-origin redirects and does not save a provider by itself.

In **Accounts**, enter the base URL, API type, and key, then discover and select models or enter IDs manually and save. There is a template for abliteration.ai. The models then appear in **New run**. **Remove provider** or `node bin/scranton.js provider remove <id>` removes the definition and stored key.

Definitions and keys are stored atomically. Keys never appear in provider metadata or API responses, and existing IDs are not overwritten. Pi files are only read for the one-time import, never managed or written back.

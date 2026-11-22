# Code map: src/core/credentials

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/core/credentials/store.js"
symbol: "credentialsDirectory"
ordinal: 0
kind: "trap"
text: "Under node:test (NODE_TEST_CONTEXT set in process.env OR the supplied env) the credential store refuses the default user-level directory: any test that creates an auth service, credentials facade or spawns a run/CLI child must pass a scratch SCRANTON_CREDENTIALS_DIR (and, for the one-time import in `initialize`, PI_CODING_AGENT_DIR or `source`). Passing `env: {}` does not bypass it. The guard exists because full-suite runs once wrote fake keys and a one-time import from the user's real ~/.pi/agent into the REAL %APPDATA%\\dev.scranton.desktop\\credentials store; after every full suite that directory must not exist on the dev machine."
evidence: "`if (process.env.NODE_TEST_CONTEXT !== undefined || env.NODE_TEST_CONTEXT !== undefined) throw failure('SCRANTON_CREDENTIAL_STORE', 'Credential directory required under node:test; set dir or SCRANTON_CREDENTIALS_DIR in the supplied env');`"
see_also: "src/core/credentials/README.md; test/core/isolation-test-root.js isolationTestEnv; test/core/helpers.js"
hash: "span:1efb5d03cea5e076"
quote: "quote:dbf15a08e5570b22"
written: "2026-11-22"
commit: "709b8c5"
by: "core"
---

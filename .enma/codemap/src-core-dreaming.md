# Code map: src/core/dreaming

Written through codemap_write. One entry per --- block; values are JSON. Freshness is computed when read, never stored here.

---
file: "src/core/dreaming/index.js"
kind: "where"
text: "createDreaming owns project-scoped deterministic status/preview/sweep/settings/rollback and optional model proposal lifecycle (propose/applyProposal/rejectProposal/cancelReflection). Context/structuredContext provide bounded advisory memory; policy remains exact-cohort deterministic retry lookup. close returns a cleanup Promise. Reflection normalization is in reflection.js; safe authority/leases/source resolution in storage.js. Contracts: .enma/dreaming-contract.md and .enma/dreaming-reflection-contract.md; user docs: docs/DREAMING.md."
hash: "shape:afa75fc92d182522"
written: "2026-11-15"
commit: "f7a3179"
by: "core"
---

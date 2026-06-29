# DESIGN.md — CV Search Prototype

## Scope Decision

This is an MVP/demo CV Intelligence Index, not a full recruitment ATS. It proves the end-to-end loop: upload CVs, extract text, build candidate profiles, search with natural language, and explain matches.

## LLM Boundary

Chosen option: **C — extraction + query understanding + reranking/explanations**, guarded by deterministic retrieval.

The backend first extracts text and creates a canonical candidate profile. If an OpenAI-compatible LLM is configured, it asks the model to return structured candidate JSON. Without a key, the app uses deterministic extraction so the hosted prototype remains testable.

Search is hybrid:

1. Deterministic retrieval over structured profile fields and raw text.
2. Optional LLM query interpretation and reranking of the top candidates.
3. Human-readable match explanations.

## What Is Real vs Faked

| Component | Status | Notes |
|---|---|---|
| Single CV upload | Real | Multipart upload endpoint. |
| Batch CV upload | Real | Same endpoint accepts multiple files. |
| PDF text extraction | Real | Uses `pdftotext` when available. |
| DOCX text extraction | Real basic | Reads `word/document.xml` from DOCX zip. |
| LLM extraction | Real when env configured | OpenAI-compatible `/chat/completions`. |
| LLM rerank/explanation | Real when env configured | Falls back to deterministic scoring. |
| Persistence | MVP real | JSON file store under `/data`. |
| Auth / tenancy | Cut | Not needed for prototype. |
| Vector embeddings | Cut for v1 | Can be added after UX is proven. |

## Future Upgrade Path

- Replace JSON file store with Postgres.
- Add pgvector embeddings for semantic retrieval.
- Add async worker queue for large batches.
- Add source-snippet evidence UI with page numbers.
- Add auth, roles, audit logs, and candidate consent controls.

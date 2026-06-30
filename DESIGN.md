# DESIGN.md — CV Search Prototype

## Scope Decision

This is an MVP/demo CV Intelligence Index, not a full recruitment ATS. It proves the end-to-end loop: upload CVs, extract text, build candidate profiles, search with natural language, and explain matches.

## LLM Boundary

Chosen option: **C — extraction + query understanding + reranking/explanations**, guarded by deterministic retrieval.

The backend first tries Gemini multimodal extraction for PDFs/images so scanned CVs and modern visual layouts do not silently fail. DOCX/TXT still go through local text extraction. Once text or structured fields exist, the app uses an OpenAI-compatible LLM (DeepSeek in the hosted deployment) to return structured candidate JSON when available. Without model keys, deterministic extraction keeps the hosted prototype testable.

Search is hybrid:

1. Deterministic retrieval over structured profile fields and raw text.
2. Optional LLM query interpretation and reranking of the top candidates.
3. Human-readable match explanations.

Job-description matching uses the same guardrail: deterministic retrieval builds a candidate pool, then the LLM ranks the configurable top-K shortlist (default 5) against the pasted JD.

## What Is Real vs Faked

| Component | Status | Notes |
|---|---|---|
| Single CV upload | Real | Multipart upload endpoint. |
| Batch CV upload | Real | Same endpoint accepts multiple files. |
| PDF/image extraction | Real | Gemini multimodal OCR first for PDF/PNG/JPG/WebP; avoids scanned-PDF silence. |
| PDF text fallback | Real | Uses `pdftotext` when Gemini is unavailable or fails. |
| DOCX text extraction | Real basic | Reads `word/document.xml` from DOCX zip. |
| LLM extraction | Real when env configured | OpenAI-compatible `/chat/completions`. |
| LLM rerank/explanation | Real when env configured | Falls back to deterministic scoring. |
| JD-to-candidate matching | Real | Pasted job description, configurable top-K (default 5), LLM shortlist/rationale. |
| PDF dataset seed | Real | `scripts/seed_hf_it_pdfs.py` pulls Hugging Face `opensporks/resumes` IT PDFs through `/api/upload`. |
| Persistence | MVP real | JSON file store under `/data`. |
| Auth / tenancy | Cut | Not needed for prototype. |
| Vector embeddings | Cut for v1 | Can be added after UX is proven. |

## Future Upgrade Path

- Replace JSON file store with Postgres.
- Add pgvector embeddings for semantic retrieval.
- Add async worker queue for large batches.
- Add source-snippet evidence UI with page numbers.
- Add auth, roles, audit logs, and candidate consent controls.

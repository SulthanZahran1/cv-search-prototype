# CV Search Prototype

LLM-assisted CV upload, extraction, indexing, and recruiter search prototype built with React + Go.

## Features

- Single CV upload
- Batch CV upload
- PDF, DOCX, TXT/MD, PNG/JPG/WebP upload
- Gemini multimodal OCR/extraction for PDFs/images
- Candidate profile extraction with DeepSeek/OpenAI-compatible fallback
- Natural-language recruiter search
- Hybrid deterministic retrieval + optional LLM reranking/explanations
- Self-contained Go server serving the React UI and API

## Quick Start

```bash
cp .env.example .env # optional; only needed for live LLM mode
cd web && npm install && npm run build
cd ..
go run ./api
```

Open http://localhost:8095.

## Optional LLM/OCR Configuration

The app works without model keys using deterministic fallback extraction. For live mode, set DeepSeek/OpenAI-compatible config for text extraction/rerank and Gemini for multimodal PDF/image OCR:

```bash
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
```

For OpenRouter-style routing:

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=openai/gpt-4o-mini
```

## API

- `GET /api/health`
- `POST /api/upload` with multipart field `files`
- `GET /api/candidates`
- `POST /api/search` with `{ "query": "backend engineer with Go and Kafka" }`

## Architecture

```text
React UI
  ↓
Go API + async worker queue
  ↓
Gemini multimodal OCR for PDFs/images OR local text extraction for DOCX/TXT
  ↓
Structured candidate profile (Gemini / DeepSeek / deterministic fallback)
  ↓
JSON store
  ↓
Hybrid search + optional LLM rerank
```

See `DESIGN.md` for scope and trade-offs.

# CV Search Prototype

LLM-assisted CV upload, extraction, indexing, and recruiter search prototype built with React + Go.

## Features

- Single CV upload
- Batch CV upload
- PDF, DOCX, TXT/MD text extraction
- Candidate profile extraction
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

## Optional LLM Configuration

The app works without an LLM key using deterministic fallback extraction. For live LLM mode, set:

```bash
LLM_API_KEY=...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
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
Go API
  ↓
Text extraction
  ↓
LLM/fallback candidate profile extraction
  ↓
JSON store
  ↓
Hybrid search + optional LLM rerank
```

See `DESIGN.md` for scope and trade-offs.

# AGENTS.md — CV Search Prototype

## Project Summary
React + Go prototype for LLM-assisted CV upload, extraction, indexing, and recruiter search.

## Non-Negotiables
- Keep the prototype self-contained: one Go server serves API + built React UI.
- Support singular and batch CV upload.
- LLM usage is optional at runtime via env; deterministic fallback must keep the demo usable without keys.
- Do not commit secrets. Use `.env.example`.

## Key Commands
- Backend dev: `go run ./api`
- Frontend dev: `cd web && npm install && npm run dev`
- Build frontend: `cd web && npm install && npm run build`
- Build server: `go build ./api`
- Docker: `docker build -t cv-search-prototype .`

## Docs To Keep In Sync
- README.md
- DESIGN.md
- AGENTS.md

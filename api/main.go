package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── Data model ──────────────────────────────────────────────────────────

type Candidate struct {
	ID              string     `json:"id"`
	FileName        string     `json:"file_name"`
	UploadedAt      time.Time  `json:"uploaded_at"`
	Name            string     `json:"name"`
	Email           string     `json:"email"`
	Phone           string     `json:"phone"`
	CurrentTitle    string     `json:"current_title"`
	YearsExperience int        `json:"years_experience"`
	Skills          []string   `json:"skills"`
	Domains         []string   `json:"domains"`
	Locations       []string   `json:"locations"`
	Seniority       string     `json:"seniority"`
	Summary         string     `json:"summary"`
	Evidence        []Evidence `json:"evidence"`
	RawText         string     `json:"raw_text,omitempty"`
}

type Evidence struct {
	Claim         string `json:"claim"`
	SourceSnippet string `json:"source_snippet"`
}

type JobStatus string

const (
	JobQueued     JobStatus = "queued"
	JobExtracting JobStatus = "extracting"
	JobIndexing   JobStatus = "indexing"
	JobCompleted  JobStatus = "completed"
	JobFailed     JobStatus = "failed"
)

type Job struct {
	ID          string    `json:"id"`
	FileName    string    `json:"file_name"`
	Status      JobStatus `json:"status"`
	Error       string    `json:"error,omitempty"`
	CandidateID string    `json:"candidate_id,omitempty"`
	Mode        string    `json:"mode,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type StoredData struct {
	Candidates []Candidate `json:"candidates"`
	Jobs       []Job       `json:"jobs"`
}

// ── Persistent store ────────────────────────────────────────────────────

type Store struct {
	mu   sync.Mutex
	path string
	data StoredData
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		return nil, err
	}
	if s.data.Jobs == nil {
		s.data.Jobs = []Job{}
	}
	return s, nil
}

func (s *Store) AddCandidate(c Candidate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Candidates = append(s.data.Candidates, c)
	return s.saveLocked()
}

func (s *Store) AllCandidates() []Candidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Candidate, len(s.data.Candidates))
	copy(out, s.data.Candidates)
	return out
}

func (s *Store) AddJob(j Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Jobs = append(s.data.Jobs, j)
	return s.saveLocked()
}

func (s *Store) UpdateJob(id string, fn func(j *Job)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Jobs {
		if s.data.Jobs[i].ID == id {
			fn(&s.data.Jobs[i])
			s.data.Jobs[i].UpdatedAt = time.Now()
			return s.saveLocked()
		}
	}
	return fmt.Errorf("job %s not found", id)
}

func (s *Store) GetJob(id string) *Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Jobs {
		if s.data.Jobs[i].ID == id {
			j := s.data.Jobs[i]
			return &j
		}
	}
	return nil
}

func (s *Store) AllJobs() []Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Job, len(s.data.Jobs))
	copy(out, s.data.Jobs)
	return out
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o644)
}

// ── Background job queue ────────────────────────────────────────────────

type JobQueue struct {
	store     *Store
	llm       *LLMClient
	gemini    *GeminiClient
	uploadDir string
	textDir   string
	pending   chan string
}

func NewJobQueue(store *Store, llm *LLMClient, gemini *GeminiClient, uploadDir, textDir string) *JobQueue {
	return &JobQueue{
		store:     store,
		llm:       llm,
		gemini:    gemini,
		uploadDir: uploadDir,
		textDir:   textDir,
		pending:   make(chan string, 100),
	}
}

func (jq *JobQueue) Enqueue(jobID string) {
	jq.pending <- jobID
}

func (jq *JobQueue) worker(ctx context.Context) {
	for jobID := range jq.pending {
		jq.process(ctx, jobID)
	}
}

func (jq *JobQueue) process(ctx context.Context, jobID string) {
	job := jq.store.GetJob(jobID)
	if job == nil {
		log.Printf("worker: job %s not found, skipping", jobID)
		return
	}

	jq.store.UpdateJob(jobID, func(j *Job) {
		j.Status = JobExtracting
	})

	stored := filepath.Join(jq.uploadDir, jobID+"-work")
	textPath := filepath.Join(jq.textDir, jobID+".txt")
	var text string

	// Extract text or structured profile
	raw, err := os.ReadFile(stored)
	if err != nil {
		jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobFailed; j.Error = fmt.Sprintf("read temp: %v", err) })
		return
	}

	// Cloud multimodal OCR/extraction first for PDFs and images. This avoids silent
	// pdftotext failure on scanned PDFs and preserves visual/layout cues better
	// than OCR -> text -> LLM for modern CV designs.
	mode := "fallback"
	var c Candidate
	if jq.gemini != nil && jq.gemini.Enabled() && isGeminiDocument(job.FileName) {
		if got, err := jq.gemini.ExtractProfileFromDocument(ctx, job.FileName, raw); err == nil {
			c = got
			mode = "gemini-ocr"
			text = candidateSearchText(c)
			goto indexCandidate
		} else {
			log.Printf("Gemini OCR extraction failed for %s: %v; falling back to text extraction", job.FileName, err)
			if isImageFile(job.FileName) {
				jq.store.UpdateJob(jobID, func(j *Job) {
					j.Status = JobFailed
					j.Error = "cloud OCR failed and image files have no local text fallback"
				})
				return
			}
		}
	}

	if strings.HasSuffix(strings.ToLower(job.FileName), ".pdf") {
		// Write to temp file for pdftotext
		tmpPdf := stored + ".pdf"
		os.WriteFile(tmpPdf, raw, 0o644)
		cmd := exec.Command("pdftotext", "-layout", tmpPdf, "-")
		b, err := cmd.Output()
		os.Remove(tmpPdf)
		if err != nil {
			jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobFailed; j.Error = fmt.Sprintf("pdftotext: %v", err) })
			return
		}
		text = string(b)
	} else if strings.HasSuffix(strings.ToLower(job.FileName), ".docx") {
		// Write to temp file
		tmpDocx := stored + ".docx"
		os.WriteFile(tmpDocx, raw, 0o644)
		t, err := extractDOCX(tmpDocx)
		os.Remove(tmpDocx)
		if err != nil {
			jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobFailed; j.Error = fmt.Sprintf("docx: %v", err) })
			return
		}
		text = t
	} else {
		text = string(raw)
	}

	if strings.TrimSpace(text) == "" {
		jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobFailed; j.Error = "no text extracted" })
		return
	}

indexCandidate:
	// Save extracted/search text
	os.WriteFile(textPath, []byte(text), 0o644)

	jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobIndexing })

	// Extract candidate profile from text if Gemini did not already produce one
	if c.Name == "" && jq.llm.Enabled() {
		if got, err := jq.llm.ExtractProfile(ctx, job.FileName, text); err == nil {
			c = got
			mode = "llm"
		} else {
			log.Printf("LLM extraction failed for %s: %v; using fallback", job.FileName, err)
			c = fallbackExtract(job.FileName, text)
		}
	} else if c.Name == "" {
		c = fallbackExtract(job.FileName, text)
	}

	c.ID = jobID
	c.FileName = job.FileName
	c.UploadedAt = time.Now()
	c.RawText = text
	cleanCandidate(&c)

	if err := jq.store.AddCandidate(c); err != nil {
		jq.store.UpdateJob(jobID, func(j *Job) { j.Status = JobFailed; j.Error = fmt.Sprintf("save: %v", err) })
		return
	}

	jq.store.UpdateJob(jobID, func(j *Job) {
		j.Status = JobCompleted
		j.Mode = mode
		j.CandidateID = c.ID
	})

	// Clean up temp upload file
	os.Remove(stored)
	log.Printf("worker: processed %s → %s (%s)", job.FileName, c.Name, mode)
}

// ── LLM client ──────────────────────────────────────────────────────────

// ── Gemini multimodal OCR/extraction client ─────────────────────────────

type GeminiClient struct {
	APIKey string
	Model  string
	HTTP   *http.Client
}

func NewGeminiClient() *GeminiClient {
	key := getenvFirst("GEMINI_API_KEY", "GOOGLE_API_KEY", "OCR_API_KEY")
	model := strings.TrimPrefix(getenvDefault("GEMINI_MODEL", "gemini-2.5-flash-lite"), "models/")
	return &GeminiClient{APIKey: key, Model: model, HTTP: &http.Client{Timeout: 90 * time.Second}}
}

func (g *GeminiClient) Enabled() bool { return strings.TrimSpace(g.APIKey) != "" }

type geminiReq struct {
	Contents         []geminiContent      `json:"contents"`
	GenerationConfig geminiGenerationConf `json:"generationConfig"`
}

type geminiGenerationConf struct {
	Temperature      float64 `json:"temperature"`
	ResponseMimeType string  `json:"responseMimeType"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inline_data,omitempty"`
}

type geminiInlineData struct {
	MimeType string `json:"mime_type"`
	Data     string `json:"data"`
}

type geminiResp struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
	Error any `json:"error,omitempty"`
}

func (g *GeminiClient) ExtractProfileFromDocument(ctx context.Context, fileName string, raw []byte) (Candidate, error) {
	if !g.Enabled() {
		return Candidate{}, errors.New("gemini disabled")
	}
	mime := mimeForFile(fileName)
	if mime == "" {
		return Candidate{}, fmt.Errorf("unsupported gemini document type: %s", fileName)
	}

	prompt := `Extract this CV/resume into strict JSON. Return ONLY JSON with keys: name,email,phone,current_title,years_experience,skills,domains,locations,seniority,summary,evidence. evidence is an array of {claim,source_snippet}. Preserve contact details exactly, especially leading + in phone numbers. Use empty strings/arrays if unknown. Never invent facts not supported by the document.`
	body := geminiReq{
		GenerationConfig: geminiGenerationConf{Temperature: 0.0, ResponseMimeType: "application/json"},
		Contents: []geminiContent{{Role: "user", Parts: []geminiPart{
			{Text: "File: " + fileName + "\n\n" + prompt},
			{InlineData: &geminiInlineData{MimeType: mime, Data: base64.StdEncoding.EncodeToString(raw)}},
		}}},
	}
	b, _ := json.Marshal(body)
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", g.Model, g.APIKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return Candidate{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return Candidate{}, err
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Candidate{}, fmt.Errorf("gemini status %d: %s", res.StatusCode, string(rb))
	}
	var gr geminiResp
	if err := json.Unmarshal(rb, &gr); err != nil {
		return Candidate{}, err
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return Candidate{}, errors.New("gemini returned no content")
	}
	content := strings.TrimSpace(gr.Candidates[0].Content.Parts[0].Text)
	content = extractJSONObject(content)
	var c Candidate
	if err := json.Unmarshal([]byte(content), &c); err != nil {
		return Candidate{}, fmt.Errorf("parse gemini JSON: %w; content=%s", err, truncate(content, 300))
	}
	cleanCandidate(&c)
	return c, nil
}

func extractJSONObject(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

func isGeminiDocument(fileName string) bool { return mimeForFile(fileName) != "" }

func isImageFile(fileName string) bool {
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".png", ".jpg", ".jpeg", ".webp":
		return true
	default:
		return false
	}
}

func mimeForFile(fileName string) string {
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".pdf":
		return "application/pdf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

func candidateSearchText(c Candidate) string {
	parts := []string{c.Name, c.Email, c.Phone, c.CurrentTitle, c.Seniority, c.Summary}
	parts = append(parts, c.Skills...)
	parts = append(parts, c.Domains...)
	parts = append(parts, c.Locations...)
	for _, e := range c.Evidence {
		parts = append(parts, e.Claim, e.SourceSnippet)
	}
	return strings.Join(parts, "\n")
}

type LLMClient struct {
	APIKey  string
	BaseURL string
	Model   string
	HTTP    *http.Client
}

func NewLLMClient() *LLMClient {
	key := getenvFirst("LLM_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY")
	base := getenvDefault("LLM_BASE_URL", "https://api.openai.com/v1")
	model := getenvDefault("LLM_MODEL", "gpt-4o-mini")
	return &LLMClient{APIKey: key, BaseURL: strings.TrimRight(base, "/"), Model: model, HTTP: &http.Client{Timeout: 45 * time.Second}}
}

func (l *LLMClient) Enabled() bool { return strings.TrimSpace(l.APIKey) != "" }

type chatReq struct {
	Model          string        `json:"model"`
	Messages       []chatMessage `json:"messages"`
	Temperature    float64       `json:"temperature"`
	ResponseFormat any           `json:"response_format,omitempty"`
}
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type chatResp struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error any `json:"error,omitempty"`
}

func (l *LLMClient) completeJSON(ctx context.Context, system, user string) ([]byte, error) {
	if !l.Enabled() {
		return nil, errors.New("llm disabled")
	}
	body := chatReq{Model: l.Model, Temperature: 0.1, ResponseFormat: map[string]string{"type": "json_object"}, Messages: []chatMessage{{Role: "system", Content: system}, {Role: "user", Content: user}}}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.BaseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+l.APIKey)
	req.Header.Set("HTTP-Referer", "https://cv-search.zahranm.cloud")
	req.Header.Set("X-Title", "CV Search Prototype")
	res, err := l.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("llm status %d: %s", res.StatusCode, string(rb))
	}
	var cr chatResp
	if err := json.Unmarshal(rb, &cr); err != nil {
		return nil, err
	}
	if len(cr.Choices) == 0 {
		return nil, fmt.Errorf("llm returned no choices")
	}
	content := strings.TrimSpace(cr.Choices[0].Message.Content)
	if content == "" {
		return nil, fmt.Errorf("llm returned empty content")
	}
	return []byte(content), nil
}

func (l *LLMClient) ExtractProfile(ctx context.Context, fileName, text string) (Candidate, error) {
	system := `You extract CV/resume data. Return ONLY JSON with keys: name,email,phone,current_title,years_experience,skills,domains,locations,seniority,summary,evidence. evidence is an array of {claim,source_snippet}. Use null/empty arrays if unknown. Never invent facts not supported by the CV.`
	user := fmt.Sprintf("File: %s\n\nCV text:\n%s", fileName, truncate(text, 18000))
	b, err := l.completeJSON(ctx, system, user)
	if err != nil {
		return Candidate{}, err
	}
	var c Candidate
	if err := json.Unmarshal(b, &c); err != nil {
		return Candidate{}, err
	}
	cleanCandidate(&c)
	return c, nil
}

// ── Search ──────────────────────────────────────────────────────────────

type SearchResult struct {
	Candidate Candidate `json:"candidate"`
	Score     float64   `json:"score"`
	Reason    string    `json:"reason"`
}

type rerankResponse struct {
	Results []struct {
		ID     string  `json:"id"`
		Score  float64 `json:"score"`
		Reason string  `json:"reason"`
	} `json:"results"`
}

func (l *LLMClient) Rerank(ctx context.Context, query string, results []SearchResult) ([]SearchResult, error) {
	if !l.Enabled() || len(results) == 0 {
		return results, errors.New("llm disabled")
	}
	type brief struct {
		ID, Name, Title, Summary   string
		Skills, Domains, Locations []string
		Years                      int
	}
	briefs := []brief{}
	for _, r := range results {
		c := r.Candidate
		briefs = append(briefs, brief{ID: c.ID, Name: c.Name, Title: c.CurrentTitle, Summary: c.Summary, Skills: c.Skills, Domains: c.Domains, Locations: c.Locations, Years: c.YearsExperience})
	}
	bb, _ := json.MarshalIndent(briefs, "", "  ")
	system := `You rerank CV candidates for a recruiter's natural-language search. Return ONLY JSON: {"results":[{"id":"candidate id","score":0-100,"reason":"short evidence-based reason"}]}. Do not include candidates that do not match at all.`
	user := fmt.Sprintf("Recruiter query: %s\n\nCandidates:\n%s", query, string(bb))
	b, err := l.completeJSON(ctx, system, user)
	if err != nil {
		return results, err
	}
	var rr rerankResponse
	if err := json.Unmarshal(b, &rr); err != nil {
		return results, err
	}
	byID := map[string]SearchResult{}
	for _, r := range results {
		byID[r.Candidate.ID] = r
	}
	out := []SearchResult{}
	for _, item := range rr.Results {
		if r, ok := byID[item.ID]; ok {
			r.Score = item.Score
			r.Reason = item.Reason
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return results, errors.New("llm returned no usable rerank IDs")
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out, nil
}

// ── HTTP server ─────────────────────────────────────────────────────────

type Server struct {
	store     *Store
	llm       *LLMClient
	gemini    *GeminiClient
	jobs      *JobQueue
	dataDir   string
	uploadDir string
}

func main() {
	port := getenvDefault("PORT", "8095")
	dataDir := getenvDefault("DATA_DIR", "./data")
	store, err := NewStore(filepath.Join(dataDir, "store.json"))
	if err != nil {
		log.Fatal(err)
	}

	llm := NewLLMClient()
	gemini := NewGeminiClient()
	uploadDir := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}
	textDir := filepath.Join(dataDir, "extracted")
	if err := os.MkdirAll(textDir, 0o755); err != nil {
		log.Fatal(err)
	}

	jobs := NewJobQueue(store, llm, gemini, uploadDir, textDir)
	s := &Server{store: store, llm: llm, gemini: gemini, jobs: jobs, dataDir: dataDir, uploadDir: uploadDir}

	// Start background worker pool
	workerCount := 3
	for i := 0; i < workerCount; i++ {
		go jobs.worker(context.Background())
	}
	log.Printf("started %d background workers for CV extraction", workerCount)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/candidates", s.candidates)
	mux.HandleFunc("POST /api/upload", s.upload)
	mux.HandleFunc("GET /api/jobs", s.getJobs)
	mux.HandleFunc("POST /api/search", s.search)
	mux.HandleFunc("/", serveSPA("web/dist"))

	log.Printf("CV Search Prototype listening on :%s (LLM enabled: %v, Gemini OCR enabled: %v)", port, s.llm.Enabled(), s.gemini.Enabled())
	log.Fatal(http.ListenAndServe(":"+port, logReq(mux)))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	jobs := s.store.AllJobs()
	pending, failed := 0, 0
	for _, j := range jobs {
		switch j.Status {
		case JobQueued, JobExtracting, JobIndexing:
			pending++
		case JobFailed:
			failed++
		}
	}
	writeJSON(w, map[string]any{
		"ok": true, "llm_enabled": s.llm.Enabled(), "ocr_enabled": s.gemini.Enabled(),
		"ocr_model":    s.gemini.Model,
		"candidates":   len(s.store.AllCandidates()),
		"pending_jobs": pending, "failed_jobs": failed,
	})
}

func (s *Server) candidates(w http.ResponseWriter, r *http.Request) {
	items := s.store.AllCandidates()
	for i := range items {
		items[i].RawText = ""
	}
	writeJSON(w, map[string]any{"candidates": items})
}

// ── Async upload: creates jobs, returns immediately ─────────────────────

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		files = r.MultipartForm.File["file"]
	}
	if len(files) == 0 {
		http.Error(w, "multipart field 'files' is required", http.StatusBadRequest)
		return
	}

	type uploadItem struct {
		FileName string `json:"file_name"`
		JobID    string `json:"job_id"`
	}
	var items []uploadItem

	for _, fh := range files {
		jobID := randID()
		f, err := fh.Open()
		if err != nil {
			items = append(items, uploadItem{FileName: fh.Filename, JobID: ""})
			continue
		}

		stored := filepath.Join(s.uploadDir, jobID+"-work")
		out, err := os.Create(stored)
		if err != nil {
			f.Close()
			items = append(items, uploadItem{FileName: fh.Filename, JobID: ""})
			continue
		}
		_, _ = io.Copy(out, io.LimitReader(f, 32<<20))
		out.Close()
		f.Close()

		job := Job{
			ID:        jobID,
			FileName:  fh.Filename,
			Status:    JobQueued,
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}
		if err := s.store.AddJob(job); err != nil {
			items = append(items, uploadItem{FileName: fh.Filename, JobID: ""})
			continue
		}
		s.jobs.Enqueue(jobID)
		items = append(items, uploadItem{FileName: fh.Filename, JobID: jobID})
	}

	writeJSON(w, map[string]any{"jobs": items})
}

// ── Jobs status endpoint ────────────────────────────────────────────────

func (s *Server) getJobs(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id != "" {
		job := s.store.GetJob(id)
		if job == nil {
			http.Error(w, "job not found", http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]any{"job": job})
		return
	}
	// If ?with_candidates is set, include candidate in each completed job
	withCandidates := r.URL.Query().Has("with_candidates")
	jobs := s.store.AllJobs()
	if withCandidates {
		type jobWithCandidate struct {
			Job       Job        `json:"job"`
			Candidate *Candidate `json:"candidate,omitempty"`
		}
		candidates := s.store.AllCandidates()
		byID := map[string]Candidate{}
		for _, c := range candidates {
			byID[c.ID] = c
		}
		out := []jobWithCandidate{}
		for _, j := range jobs {
			jwc := jobWithCandidate{Job: j}
			if j.CandidateID != "" {
				if c, ok := byID[j.CandidateID]; ok {
					c.RawText = ""
					jwc.Candidate = &c
				}
			}
			out = append(out, jwc)
		}
		writeJSON(w, map[string]any{"jobs": out})
		return
	}
	writeJSON(w, map[string]any{"jobs": jobs})
}

// ── Search (synchronous) ────────────────────────────────────────────────

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query    string `json:"query"`
		Mode     string `json:"mode"`
		MinYears int    `json:"min_years"`
		Location string `json:"location"`
		Scope    string `json:"scope"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Query = strings.TrimSpace(req.Query)
	if req.Query == "" {
		http.Error(w, "query is required", http.StatusBadRequest)
		return
	}

	start := time.Now()
	candidates := s.store.AllCandidates()
	corpusSize := len(candidates)

	// Apply filters
	filtered := []Candidate{}
	for _, c := range candidates {
		if req.MinYears > 0 && c.YearsExperience < req.MinYears {
			continue
		}
		if req.Location != "" && req.Location != "any" {
			hasLoc := false
			for _, l := range c.Locations {
				if strings.EqualFold(l, req.Location) {
					hasLoc = true
					break
				}
			}
			if strings.Contains(strings.ToLower(c.Name), strings.ToLower(req.Location)) || strings.Contains(strings.ToLower(c.CurrentTitle), strings.ToLower(req.Location)) || strings.Contains(strings.ToLower(c.Summary), strings.ToLower(req.Location)) || strings.Contains(strings.ToLower(c.RawText), strings.ToLower(req.Location)) {
				hasLoc = true
			}
			if !hasLoc {
				continue
			}
		}
		filtered = append(filtered, c)
	}

	results := deterministicSearch(req.Query, filtered)
	mode := "deterministic"
	if req.Mode == "semantic" && s.llm.Enabled() {
		if reranked, err := s.llm.Rerank(r.Context(), req.Query, results); err == nil {
			results = reranked
			mode = "llm-rerank"
		} else {
			log.Printf("LLM rerank failed: %v", err)
		}
	}
	elapsed := time.Since(start).Seconds()
	for i := range results {
		results[i].Candidate.RawText = ""
	}
	writeJSON(w, map[string]any{"query": req.Query, "mode": mode, "results": results,
		"corpus_size": corpusSize, "search_time": elapsed})
}

func deterministicSearch(query string, candidates []Candidate) []SearchResult {
	qTokens := tokenize(query)
	qSet := map[string]bool{}
	for _, t := range qTokens {
		qSet[t] = true
	}
	out := []SearchResult{}
	for _, c := range candidates {
		hay := strings.ToLower(strings.Join([]string{c.Name, c.CurrentTitle, c.Summary, strings.Join(c.Skills, " "), strings.Join(c.Domains, " "), strings.Join(c.Locations, " "), c.RawText}, " "))
		matched := []string{}
		score := 0.0
		for t := range qSet {
			if len(t) < 2 {
				continue
			}
			if strings.Contains(hay, t) {
				score += 8
				matched = append(matched, t)
			}
		}
		for _, skill := range c.Skills {
			if qSet[strings.ToLower(skill)] {
				score += 18
			}
		}
		if c.YearsExperience > 0 {
			for _, t := range qTokens {
				if n, err := strconv.Atoi(t); err == nil && c.YearsExperience >= n {
					score += 6
				}
			}
		}
		if score > 0 {
			sort.Strings(matched)
			reason := "Matched terms: " + strings.Join(unique(matched), ", ")
			if len(matched) == 0 {
				reason = "Candidate profile has related structured fields."
			}
			out = append(out, SearchResult{Candidate: c, Score: score, Reason: reason})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}

// ── Text extraction ─────────────────────────────────────────────────────

func extractText(path, name string) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".pdf":
		cmd := exec.Command("pdftotext", "-layout", path, "-")
		b, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("pdftotext failed: %w", err)
		}
		return string(b), nil
	case ".docx":
		return extractDOCX(path)
	default:
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
}

func extractDOCX(path string) (string, error) {
	r, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name == "word/document.xml" {
			rc, err := f.Open()
			if err != nil {
				return "", err
			}
			defer rc.Close()
			b, _ := io.ReadAll(rc)
			return docxXMLText(b), nil
		}
	}
	return "", errors.New("word/document.xml not found")
}

func docxXMLText(b []byte) string {
	dec := xml.NewDecoder(bytes.NewReader(b))
	var sb strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "t" {
			var text string
			dec.DecodeElement(&text, &se)
			sb.WriteString(html.UnescapeString(text))
			sb.WriteString(" ")
		}
	}
	return sb.String()
}

// ── Fallback extraction ─────────────────────────────────────────────────

func fallbackExtract(fileName, text string) Candidate {
	lines := nonEmptyLines(text)
	name := strings.TrimSuffix(fileName, filepath.Ext(fileName))
	if len(lines) > 0 && len(lines[0]) < 80 {
		name = lines[0]
	}
	email := firstRe(text, `[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	phone := firstRe(text, `(?m)(?:\+?\d[\d\s().-]{7,}\d)`)
	skills := detectTerms(text, skillLexicon())
	domains := detectTerms(text, []string{"fintech", "payments", "banking", "insurance", "healthcare", "ecommerce", "retail", "logistics", "manufacturing", "energy", "telecom", "education", "ai", "machine learning", "security", "devops", "cloud"})
	locations := detectTerms(text, []string{"Jakarta", "Bandung", "Surabaya", "Singapore", "Remote", "Indonesia", "Malaysia", "Australia", "United States", "Europe"})
	years := detectYears(text)
	title := detectTitle(lines)
	seniority := "unknown"
	low := strings.ToLower(text)
	switch {
	case strings.Contains(low, "principal") || strings.Contains(low, "staff engineer") || strings.Contains(low, "lead "):
		seniority = "lead"
	case strings.Contains(low, "senior") || years >= 5:
		seniority = "senior"
	case years >= 2:
		seniority = "mid"
	case years > 0:
		seniority = "junior"
	}
	summary := fmt.Sprintf("%s with %d detected skills", defaultString(title, "Candidate"), len(skills))
	if years > 0 {
		summary = fmt.Sprintf("%s with about %d years of experience and %d detected skills", defaultString(title, "Candidate"), years, len(skills))
	}
	evidence := []Evidence{}
	for _, skill := range firstN(skills, 5) {
		evidence = append(evidence, Evidence{Claim: skill + " experience", SourceSnippet: snippetAround(text, skill)})
	}
	return Candidate{Name: name, Email: email, Phone: phone, CurrentTitle: title, YearsExperience: years, Skills: skills, Domains: domains, Locations: locations, Seniority: seniority, Summary: summary, Evidence: evidence}
}

func skillLexicon() []string {
	return []string{"Go", "Golang", "React", "TypeScript", "JavaScript", "Python", "Java", "Kotlin", "Swift", "C++", "C#", "Postgres", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka", "RabbitMQ", "Docker", "Kubernetes", "AWS", "GCP", "Azure", "Terraform", "Linux", "CI/CD", "GraphQL", "REST", "gRPC", "Node.js", "Next.js", "Vue", "Angular", "Machine Learning", "LLM", "RAG", "NLP", "Computer Vision", "PyTorch", "TensorFlow", "Pandas", "Spark", "Airflow", "Elasticsearch", "OpenSearch", "Prometheus", "Grafana", "Security", "OAuth", "JWT"}
}

func detectTerms(text string, terms []string) []string {
	low := strings.ToLower(text)
	out := []string{}
	for _, t := range terms {
		if strings.Contains(low, strings.ToLower(t)) {
			out = append(out, t)
		}
	}
	return unique(out)
}
func detectYears(text string) int {
	best := 0
	re := regexp.MustCompile(`(?i)(\d{1,2})\+?\s*(?:years|yrs)`)
	for _, m := range re.FindAllStringSubmatch(text, -1) {
		n, _ := strconv.Atoi(m[1])
		if n > best && n < 60 {
			best = n
		}
	}
	return best
}
func detectTitle(lines []string) string {
	keywords := []string{"engineer", "developer", "manager", "scientist", "analyst", "architect", "designer", "consultant", "specialist"}
	for _, l := range lines[:min(len(lines), 12)] {
		low := strings.ToLower(l)
		for _, k := range keywords {
			if strings.Contains(low, k) && len(l) < 100 {
				return strings.TrimSpace(l)
			}
		}
	}
	return ""
}
func firstRe(text, pattern string) string {
	re := regexp.MustCompile(pattern)
	return strings.TrimSpace(re.FindString(text))
}
func nonEmptyLines(text string) []string {
	out := []string{}
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}
func snippetAround(text, term string) string {
	low := strings.ToLower(text)
	i := strings.Index(low, strings.ToLower(term))
	if i < 0 {
		return ""
	}
	start := max(0, i-90)
	end := min(len(text), i+len(term)+140)
	return strings.Join(strings.Fields(text[start:end]), " ")
}
func cleanCandidate(c *Candidate) {
	c.Name = strings.TrimSpace(c.Name)
	c.Email = strings.TrimSpace(c.Email)
	c.Phone = strings.TrimSpace(c.Phone)
	c.CurrentTitle = strings.TrimSpace(c.CurrentTitle)
	c.Seniority = strings.TrimSpace(c.Seniority)
	c.Summary = strings.TrimSpace(c.Summary)
	c.Skills = unique(c.Skills)
	c.Domains = unique(c.Domains)
	c.Locations = unique(c.Locations)
	if c.Name == "" {
		c.Name = "Unknown Candidate"
	}
}
func tokenize(s string) []string {
	re := regexp.MustCompile(`[a-zA-Z0-9+#.]+`)
	raw := re.FindAllString(strings.ToLower(s), -1)
	out := []string{}
	stop := map[string]bool{"with": true, "and": true, "or": true, "the": true, "a": true, "an": true, "for": true, "to": true, "of": true, "in": true, "on": true, "is": true, "are": true, "find": true, "candidate": true, "candidates": true}
	for _, t := range raw {
		if !stop[t] {
			out = append(out, t)
		}
	}
	return out
}
func unique(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range in {
		x = strings.TrimSpace(x)
		if x == "" {
			continue
		}
		key := strings.ToLower(x)
		if !seen[key] {
			seen[key] = true
			out = append(out, x)
		}
	}
	return out
}
func firstN(in []string, n int) []string {
	if len(in) < n {
		return in
	}
	return in[:n]
}
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n[truncated]"
}
func defaultString(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
func randID() string { b := make([]byte, 8); rand.Read(b); return hex.EncodeToString(b) }
func sanitizeFileName(s string) string {
	s = filepath.Base(s)
	re := regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	return re.ReplaceAllString(s, "_")
}
func getenvDefault(k, d string) string {
	if v := os.Getenv(k); strings.TrimSpace(v) != "" {
		return v
	}
	return d
}
func getenvFirst(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func logReq(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}
func serveSPA(dir string) http.HandlerFunc {
	fs := http.FileServer(http.Dir(dir))
	return func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	}
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

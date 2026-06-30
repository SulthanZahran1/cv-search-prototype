import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, Search, FileText, Sparkles, Users, AlertCircle, CheckCircle2, Clock, Loader2, XCircle, X, Plus, Database, Zap, ArrowDownWideNarrow, Quote, GitBranch, Check, Minus, FileSearch2, ScanSearch, SearchX, ListChecks, FileText as FileIcon, Briefcase, ArrowRight, UserCheck, Download, ChevronDown, Play, Box } from 'lucide-react';
import './styles.css';

const api = {
  async health() { return fetch('/api/health').then(r => r.json()); },
  async candidates() { return fetch('/api/candidates').then(r => r.json()); },
  async upload(files) {
    const fd = new FormData();
    [...files].forEach(f => fd.append('files', f));
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async job(id) {
    const res = await fetch(`/api/jobs?id=${id}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async jobs(withCandidates) {
    const suffix = withCandidates ? '?with_candidates' : '';
    const res = await fetch(`/api/jobs${suffix}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async search(query, opts = {}) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode: opts.mode || 'exact',
        min_years: opts.minYears || 0,
        location: opts.location || 'any',
      })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async deleteCandidate(id) {
    const res = await fetch(`/api/candidates/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async jobMatch(jobDescription, opts = {}) {
    const res = await fetch('/api/job-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_description: jobDescription,
        top_k: opts.topK || 5,
        min_years: opts.minYears || 0,
        location: opts.location || 'any',
      })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

const JOB_LABELS = {
  queued: { label: 'Queued', icon: Clock, color: '#6b7890' },
  extracting: { label: 'Extracting text', icon: Loader2, color: '#536dfe' },
  indexing: { label: 'Indexing profile', icon: Loader2, color: '#536dfe' },
  completed: { label: 'Completed', icon: CheckCircle2, color: '#22a06b' },
  failed: { label: 'Failed', icon: XCircle, color: '#d32f2f' },
};

function useJobPolling(jobIds) {
  const [jobs, setJobs] = useState({});
  const prevStr = useRef('');

  useEffect(() => {
    if (!jobIds.length) return;
    let active = true;
    function poll() {
      Promise.all(jobIds.map(id =>
        api.job(id).then(r => r.job).catch(() => null)
      )).then(results => {
        if (!active) return;
        const update = {};
        let allDone = true;
        jobIds.forEach((id, i) => {
          update[id] = results[i];
          if (results[i] && results[i].status !== 'completed' && results[i].status !== 'failed') allDone = false;
        });
        const str = JSON.stringify(update);
        if (str !== prevStr.current) { prevStr.current = str; setJobs(prev => ({ ...prev, ...update })); }
        if (!allDone) setTimeout(poll, 1500);
      });
    }
    setTimeout(poll, 500);
    return () => { active = false; };
  }, [jobIds.sort().join(',')]);
  return jobs;
}

function initials(name) {
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function avatarPalette(id) {
  const p = [['#a5003412', '#a50034'], ['#00766f12', '#00766f'], ['#7c3aed12', '#7c3aed'], ['#b4530912', '#b45309'], ['#2563eb12', '#2563eb']];
  return p[id % p.length];
}
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightText(text, queryTokens) {
  const lower = text.toLowerCase();
  const hits = [];
  queryTokens.forEach(tok => {
    const t = tok.toLowerCase();
    if (!t) return;
    let i = 0;
    while ((i = lower.indexOf(t, i)) !== -1) { hits.push([i, i + t.length]); i += t.length; }
  });
  hits.sort((a, b) => a[0] - b[0]);
  const merged = [];
  hits.forEach(h => { const l = merged[merged.length - 1]; if (l && h[0] <= l[1]) l[1] = Math.max(l[1], h[1]); else merged.push([...h]); });
  let out = '', pos = 0;
  merged.forEach(([s, e]) => {
    out += escHtml(text.slice(pos, s));
    out += `<span class="hl">${escHtml(text.slice(s, e))}</span>`;
    pos = e;
  });
  out += escHtml(text.slice(pos));
  return { html: out, count: merged.length };
}

function snippetAround(text, tokens, maxPre = 80, maxPost = 140) {
  const lower = text.toLowerCase();
  const lowerTokens = tokens.map(t => t.toLowerCase());
  // find earliest hit
  let first = Infinity;
  lowerTokens.forEach(t => { const idx = lower.indexOf(t); if (idx >= 0 && idx < first) first = idx; });
  if (first === Infinity) return { html: escHtml(text.slice(0, 280)), count: 0 };
  const start = Math.max(0, first - maxPre);
  const end = Math.min(text.length, first + maxPost);
  const pre = start > 0 ? '… ' : '';
  const post = end < text.length ? ' …' : '';
  const seg = highlightText(text.slice(start, end), tokens);
  return { html: pre + seg.html + post, count: seg.count };
}

function App() {
  const [health, setHealth] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [activeJobIds, setActiveJobIds] = useState([]);
  const [uploadFileNames, setUploadFileNames] = useState({});
  const [view, setView] = useState('search'); // 'search' | 'prescreen'
  const [tokens, setTokens] = useState([]);
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('exact'); // 'exact' | 'semantic'
  const [minYears, setMinYears] = useState(0);
  const [location, setLocation] = useState('any');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [error, setError] = useState('');
  const [drawerId, setDrawerId] = useState(null);

  // Prescreen state
  const [reqSkills, setReqSkills] = useState([]);
  const [reqInput, setReqInput] = useState('');
  const [preMinYears, setPreMinYears] = useState(5);
  const [preRan, setPreRan] = useState(false);
  const [preResults, setPreResults] = useState([]);

  // Job description matching state
  const [jobDescription, setJobDescription] = useState('');
  const [jobTopK, setJobTopK] = useState(5);
  const [jobMinYears, setJobMinYears] = useState(0);
  const [jobLocation, setJobLocation] = useState('any');
  const [jobMatching, setJobMatching] = useState(false);
  const [jobMatchResult, setJobMatchResult] = useState(null);

  const jobData = useJobPolling(activeJobIds);

  async function refresh() {
    const [h, c] = await Promise.all([api.health(), api.candidates()]);
    setHealth(h);
    setCandidates(c.candidates || []);
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);

  useEffect(() => {
    if (!activeJobIds.length) return;
    const allDone = activeJobIds.every(id => { const j = jobData[id]; return j && (j.status === 'completed' || j.status === 'failed'); });
    if (allDone) refresh().catch(e => setError(e.message));
  }, [jobData, activeJobIds]);

  const corpus = health?.candidates || 0;
  const totalCandidates = candidates.length;

  async function doUpload(files) {
    if (!files?.length) return;
    setError('');
    setUploading(true);
    try {
      const res = await api.upload(files);
      const ids = [];
      const namesMap = {};
      (res.jobs || []).forEach(item => {
        if (item.job_id) { ids.push(item.job_id); namesMap[item.job_id] = item.file_name; }
      });
      setActiveJobIds(prev => [...prev, ...ids]);
      setUploadFileNames(prev => ({ ...prev, ...namesMap }));
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function doSearch(tokOverride) {
    const qTokens = tokOverride || tokens;
    if (!qTokens.length) return;
    setSearching(true);
    setError('');
    try {
      const res = await api.search(qTokens.join(' '), { mode, minYears, location });
      setSearchResult(res);
    } catch (e) { setError(e.message); }
    finally { setSearching(false); }
  }

  // Run when tokens change on Enter or remove
  const runSearch = useCallback(doSearch, [tokens, mode, minYears, location]);

  function addToken(val) {
    const v = val.trim();
    if (!v) return;
    if (tokens.some(t => t.toLowerCase() === v.toLowerCase())) { setInput(''); return; }
    const newTokens = [...tokens, v];
    setTokens(newTokens);
    setInput('');
  }

  function removeToken(i) {
    const newTokens = tokens.filter((_, j) => j !== i);
    setTokens(newTokens);
    if (newTokens.length === 0) setSearchResult(null);
  }

  const suggestionGo = useCallback((term) => () => {
    setTokens([term]);
    setInput('');
  }, []);

  const suggestions = [
    { label: 'Go', go: suggestionGo('Go') },
    { label: 'Kubernetes', go: suggestionGo('Kubernetes') },
    { label: 'Python', go: suggestionGo('Python') },
    { label: 'NLP', go: suggestionGo('NLP') },
  ];

  function addReq(val) {
    const v = val.trim();
    if (!v) return;
    if (reqSkills.some(s => s.toLowerCase() === v.toLowerCase())) { setReqInput(''); return; }
    setReqSkills(prev => [...prev, v]);
    setReqInput('');
    setPreRan(false);
  }

  async function runPrescreen() {
    if (reqSkills.length === 0) return;
    setPreRan(true);
    // Reuse search for each requirement, collect results
    const allResults = [];
    for (const skill of reqSkills) {
      try {
        const res = await api.search(skill, { mode: 'semantic', minYears: preMinYears, location: 'any' });
        (res.results || []).forEach(r => {
          r.candidate._score = r.score;
          r.candidate._reason = r.reason;
        });
        allResults.push(...(res.results || []));
      } catch {}
    }
    // Deduplicate and rank
    const seen = new Set();
    const ranked = allResults.filter(r => { if (seen.has(r.candidate.id)) return false; seen.add(r.candidate.id); return true; });
    setPreResults(ranked);
  }

  async function runJobMatch() {
    if (!jobDescription.trim()) return;
    setJobMatching(true);
    setError('');
    try {
      const res = await api.jobMatch(jobDescription, { topK: jobTopK, minYears: jobMinYears, location: jobLocation });
      setJobMatchResult(res);
    } catch (e) { setError(e.message); }
    finally { setJobMatching(false); }
  }

  const activeSearchResults = useMemo(() => {
    if (!searchResult) return { results: [], mode: 'deterministic', corpusSize: 0, searchTime: 0 };
    return {
      results: (searchResult.results || []).map((r, i) => {
        const c = r.candidate;
        const [avBg, avColor] = avatarPalette(i);
        const score = Math.min(Math.round(r.score), 99);
        const scoreColor = score >= 80 ? '#00766f' : score >= 60 ? '#b45309' : '#64748b';
        const tokenHits = tokens.map(t => {
          const lower = (c.raw_text || c.summary || '').toLowerCase();
          return lower.includes(t.toLowerCase()) || (c.skills || []).some(s => s.toLowerCase().includes(t.toLowerCase()));
        });
        const coverage = tokens.map((t, j) => ({
          label: t,
          icon: tokenHits[j] ? 'check' : 'minus',
          bg: tokenHits[j] ? '#00766f12' : '#f1f5f9',
          color: tokenHits[j] ? '#00766f' : '#94a3b8'
        }));
        const snippet = snippetAround(c.raw_text || c.summary || `${c.name}: ${c.current_title || ''} ${(c.skills||[]).join(', ')}`, tokens);
        const inSkills = (c.skills || []).some(s => tokens.some(t => s.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(s.toLowerCase())));
        return {
          ...c,
          initials: initials(c.name),
          avBg, avColor, score, scoreColor,
          coverage, snippet, inSkills,
          border: inSkills ? '#d7dee8' : '#b4530933',
          barColor: inSkills ? '#a50034' : '#b45309',
          why: inSkills ? `Matched in Skills field + CV body` : r.reason || `Found in CV text`,
          whyIcon: inSkills ? 'file-text' : 'search',
          score,
          rawText: c.raw_text || ''
        };
      }),
      mode: searchResult.mode,
      corpusSize: searchResult.corpus_size || 0,
      searchTime: searchResult.search_time || 0
    };
  }, [searchResult, tokens]);

  const drawerCandidate = useMemo(() => {
    if (drawerId == null) return null;
    return candidates.find(c => c.id === drawerId);
  }, [drawerId, candidates]);

  const pendingJobs = activeJobIds.filter(id => {
    const j = jobData[id];
    return j && j.status !== 'completed' && j.status !== 'failed';
  });

  return <div className="app">
    {/* TOPBAR */}
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo"><Box size={18} /></div>
        <div className="topbar-title">Recruitment</div>
        <div className="topbar-divider" />
        <div className="topbar-sub">CV Document Search <span className="badge-poc">POC</span></div>
      </div>
      <div className="topbar-right">
        <div className="corpus-badge">
          <Database size={14} />
          <span><strong>{corpus}</strong> CVs parsed & indexed</span>
        </div>
        <div className="avatar">HR</div>
      </div>
    </div>

    {/* TABS */}
    <div className="tabs">
      <button className={`tab ${view === 'applicants' ? 'active' : ''}`} onClick={() => setView('applicants')}>
        <Users size={16} /> All Applicants <span className="tab-badge">{totalCandidates}</span>
      </button>
      <div className="tab-divider" />
      <button className={`tab ${view === 'prescreen' ? 'active' : ''}`} onClick={() => setView('prescreen')}>
        <ListChecks size={16} /> Prescreening
      </button>
      <div className="tab-divider" />
      <button className={`tab ${view === 'job-match' ? 'active' : ''}`} onClick={() => setView('job-match')}>
        <Briefcase size={16} /> Job Match <span className="tab-badge">TOP {jobTopK}</span>
      </button>
      <div className="tab-divider" />
      <button className={`tab ${view === 'search' ? 'active' : ''}`} onClick={() => setView('search')}>
        <ScanSearch size={16} /> Search applicants <span className="tab-badge">AD-HOC</span>
      </button>
      <div className="tab-spacer" />
      <div className="tab-context">
        <Briefcase size={14} />
        <span className="context-title">All CVs</span>
        <span className="context-meta">· {totalCandidates} in pipeline</span>
      </div>
    </div>

    {error && <div className="alert"><AlertCircle size={18} />{error}</div>}

    {/* UPLOAD BANNER */}
    <div className="upload-banner">
      <label className="upload-trigger">
        <input type="file" multiple accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={e => doUpload(e.target.files)} />
        <Upload size={16} />
        <span>{uploading ? 'Queuing…' : 'Upload CVs'}</span>
      </label>
      {pendingJobs.length > 0 && <div className="upload-progress">
        <Loader2 size={14} className="spin" /> {pendingJobs.length} processing
      </div>}
      {activeJobIds.length > 0 && <div className="job-status-compact">
        {activeJobIds.slice(-3).map(id => {
          const job = jobData[id];
          if (!job) return null;
          const meta = JOB_LABELS[job.status] || JOB_LABELS.queued;
          const Icon = meta.icon;
          const active = job.status === 'extracting' || job.status === 'indexing';
          return <span key={id} className={`job-chip ${job.status}`}>
            {active ? <Loader2 size={11} className="spin" /> : <Icon size={11} />}
            {job.file_name}
          </span>;
        })}
      </div>}
    </div>

    {/* ====== SEARCH VIEW ====== */}
    {view === 'search' && <div className="view-container">
      {/* SEARCH CONTROLS */}
      <div className="search-controls">
        <div className="search-input-row">
          <div className={`token-input ${focused ? 'focused' : ''}`}>
            <Search size={18} className="search-icon" />
            {tokens.map((t, i) => (
              <span key={i} className="token-chip">
                {t}
                <button className="token-remove" onClick={() => removeToken(i)}><X size={12} /></button>
              </span>
            ))}
            <input
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addToken(e.target.value); } else if (e.key === 'Backspace' && !input && tokens.length > 0) { setTokens(tokens.slice(0, -1)); } }}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              placeholder={tokens.length === 0 ? 'Search a skill — e.g. Go, Kubernetes, NLP…' : 'Add another skill…'}
              className="token-field"
            />
          </div>
          <button className="btn-add-skill" onClick={() => { addToken(input); }}>
            <Plus size={17} /> Add skill
          </button>
        </div>
        <div className="input-hint">Type a skill and press <strong>Enter</strong> to add it. Add several — candidates are ranked by how many they match.</div>

        {/* FILTERS ROW */}
        <div className="filters-row">
          <FilterGroup label="MATCHING">
            <SegControl
              options={[
                { label: 'Exact', value: 'exact' },
                { label: <><Sparkles size={13} /> Semantic</>, value: 'semantic' }
              ]}
              value={mode} onChange={setMode}
            />
          </FilterGroup>
          <FilterGroup label="EXPERIENCE">
            <div className="exp-slider-wrap">
              <input type="range" min="0" max="15" value={minYears}
                onChange={e => setMinYears(Number(e.target.value))}
                className="exp-slider" />
              <span className="exp-slider-value">{minYears === 0 ? 'Any' : `${minYears}+ yrs`}</span>
            </div>
          </FilterGroup>
          <FilterGroup label="LOCATION">
            <select value={location} onChange={e => setLocation(e.target.value)} className="select-filter">
              <option value="any">Anywhere</option>
              <option value="Jakarta">Jakarta</option>
              <option value="Bandung">Bandung</option>
              <option value="Surabaya">Surabaya</option>
              <option value="Singapore">Singapore</option>
              <option value="Remote">Remote</option>
            </select>
          </FilterGroup>
        </div>

        {/* SEMANTIC EXPANSION + SUGGESTIONS */}
        <div className="semantic-row">
          {mode === 'semantic' && tokens.length > 0 && (
            <div className="semantic-banner">
              <GitBranch size={14} />
              <span>Semantic search also looks for related skills — catching candidates who described the skill differently.</span>
            </div>
          )}
          <div className="try-section">
            <span className="try-label">TRY</span>
            {suggestions.map(s => (
              <button key={s.label} className="try-pill" onClick={s.go}>{s.label}</button>
            ))}
            <button className="try-pill try-search" onClick={() => runSearch()}>
              {searching ? <Loader2 size={12} className="spin" /> : <ScanSearch size={12} />}
              Search
            </button>
          </div>
        </div>
      </div>

      {/* RESULTS */}
      {tokens.length > 0 && <div className="results-header">
        <div className="results-label">{activeSearchResults.results.length} CANDIDATE{activeSearchResults.results.length === 1 ? '' : 'S'} MATCHED</div>
        {activeSearchResults.results.length > 0 && (
          <div className="results-meta">
            <Database size={13} /> Scanned <strong>{activeSearchResults.corpusSize}</strong> parsed CVs
            <span className="meta-dot">·</span>
            <Zap size={13} className="zap-icon" /> {activeSearchResults.searchTime.toFixed(2)}s
          </div>
        )}
        <div className="results-spacer" />
        {activeSearchResults.results.length > 0 && (
          <div className="results-sort"><ArrowDownWideNarrow size={13} /> Ranked by relevance</div>
        )}
      </div>}

      <div className="results-container">
        {tokens.length === 0 && !searchResult && (
          <div className="empty-state">
            <FileSearch2 size={34} />
            <div className="empty-title">Add a skill to search across every CV</div>
            <div className="empty-desc">Semantic search scans the full text of <strong>{corpus}</strong> parsed CVs — not just the Skills field — so you catch candidates who described it in their own words.</div>
          </div>
        )}
        {tokens.length > 0 && activeSearchResults.results.length === 0 && !searching && (
          <div className="empty-state">
            <SearchX size={30} />
            <div className="empty-title">No CVs matched your criteria</div>
            <div className="empty-desc">Try Semantic matching, loosen the filters, or add more CVs.</div>
          </div>
        )}
        {searching && <div className="searching-indicator"><Loader2 size={20} className="spin" /> Searching…</div>}
        <div className="results-list">
          {activeSearchResults.results.map((r, idx) => (
            <div key={r.id} className="result-card" onClick={() => setDrawerId(r.id)} style={{ borderColor: r.border }}>
              <div className="card-left">
                <div className="card-avatar" style={{ background: r.avBg, color: r.avColor }}>{r.initials}</div>
              </div>
              <div className="card-body">
                <div className="card-head">
                  <div className="card-name">{r.name}</div>
                  <div className="card-meta">{r.current_title || r.file_name}{r.years_experience ? ` · ${r.years_experience} yrs` : ''}{r.locations && r.locations[0] ? ` · ${r.locations[0]}` : ''}</div>
                </div>
                {/* Coverage chips */}
                <div className="coverage-row">
                  {r.coverage.map((c, i) => (
                    <span key={i} className="coverage-chip" style={{ background: c.bg, color: c.color }}>
                      {c.icon === 'check' ? <Check size={11} /> : <Minus size={11} />}
                      {c.label}
                    </span>
                  ))}
                </div>
                {/* Evidence snippet */}
                {r.snippet && r.snippet.count > 0 && (
                  <div className="evidence-box" style={{ borderLeftColor: r.barColor }}>
                    <div className="evidence-label">
                      {r.whyIcon === 'file-text' ? <FileIcon size={12} /> : <Search size={12} />}
                      {r.why}
                    </div>
                    <div className="evidence-text" dangerouslySetInnerHTML={{ __html: r.snippet.html }} />
                  </div>
                )}
              </div>
              <div className="card-right">
                <div className="score-area">
                  <div className="score-value" style={{ color: r.scoreColor }}>{r.score}</div>
                  <div className="score-unit">%</div>
                </div>
                <div className="score-label">RELEVANCE</div>
                <div className="card-open"><ArrowRight size={13} /></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>}

    {/* ====== JOB DESCRIPTION MATCH VIEW ====== */}
    {view === 'job-match' && <div className="view-container">
      <div className="job-match-panel">
        <div className="criteria-header">
          <Briefcase size={18} />
          <span className="criteria-title">Job description matching</span>
          <span className="criteria-meta">— LLM hunts for the best candidates in the CV DB</span>
        </div>
        <textarea
          className="jd-textarea"
          value={jobDescription}
          onChange={e => setJobDescription(e.target.value)}
          placeholder={`Paste a job description here…\n\nExample: Senior backend engineer with Go, Kubernetes, Kafka, PostgreSQL, payments/fintech experience. Must design APIs and mentor engineers.`}
        />
        <div className="jd-controls">
          <FilterGroup label="TOP CANDIDATES">
            <input type="number" min="1" max="25" value={jobTopK}
              onChange={e => setJobTopK(Math.max(1, Math.min(25, Number(e.target.value) || 5)))}
              className="topk-input" />
          </FilterGroup>
          <FilterGroup label="MIN. EXPERIENCE">
            <div className="exp-slider-wrap">
              <input type="range" min="0" max="15" value={jobMinYears}
                onChange={e => setJobMinYears(Number(e.target.value))}
                className="exp-slider" />
              <span className="exp-slider-value">{jobMinYears === 0 ? 'Any' : `${jobMinYears}+ yrs`}</span>
            </div>
          </FilterGroup>
          <FilterGroup label="LOCATION">
            <select value={jobLocation} onChange={e => setJobLocation(e.target.value)} className="select-filter">
              <option value="any">Anywhere</option>
              <option value="Jakarta">Jakarta</option>
              <option value="Bandung">Bandung</option>
              <option value="Surabaya">Surabaya</option>
              <option value="Singapore">Singapore</option>
              <option value="Remote">Remote</option>
              <option value="India">India</option>
              <option value="United States">United States</option>
            </select>
          </FilterGroup>
          <button className="btn-primary" onClick={runJobMatch} disabled={jobMatching || !jobDescription.trim()}>
            {jobMatching ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
            Find candidates
          </button>
        </div>
      </div>

      {jobMatchResult && <div className="results-header">
        <div className="results-label">TOP {jobMatchResult.results?.length || 0} JOB MATCHES</div>
        <div className="results-meta">
          <Database size={13} /> Scanned <strong>{jobMatchResult.corpus_size}</strong> parsed CVs
          <span className="meta-dot">·</span>
          Pool <strong>{jobMatchResult.candidate_pool}</strong>
          <span className="meta-dot">·</span>
          <Zap size={13} className="zap-icon" /> {Number(jobMatchResult.search_time || 0).toFixed(2)}s
          <span className="meta-dot">·</span>
          {jobMatchResult.mode}
        </div>
      </div>}

      <div className="results-container">
        {!jobMatchResult && <div className="empty-state">
          <Briefcase size={34} />
          <div className="empty-title">Paste a JD and let the LLM shortlist candidates</div>
          <div className="empty-desc">Default is top 5, but you can configure the shortlist size and apply experience/location filters before matching.</div>
        </div>}
        {jobMatchResult && (jobMatchResult.results || []).length === 0 && <div className="empty-state">
          <SearchX size={30} />
          <div className="empty-title">No candidates matched this job description</div>
          <div className="empty-desc">Try loosening filters or seeding more IT CV PDFs.</div>
        </div>}
        <div className="results-list">
          {(jobMatchResult?.results || []).map((r, idx) => {
            const c = r.candidate;
            const [avBg, avColor] = avatarPalette(idx);
            const score = Math.min(Math.round(r.score || 0), 99);
            const scoreColor = score >= 80 ? '#00766f' : score >= 60 ? '#b45309' : '#64748b';
            return <div key={c.id} className="result-card" onClick={() => setDrawerId(c.id)}>
              <div className="card-left"><div className="card-avatar" style={{ background: avBg, color: avColor }}>{initials(c.name)}</div></div>
              <div className="card-body">
                <div className="card-head">
                  <div className="card-name">{c.name}</div>
                  <div className="card-meta">{c.current_title || c.file_name}{c.years_experience ? ` · ${c.years_experience} yrs` : ''}{c.locations && c.locations[0] ? ` · ${c.locations[0]}` : ''}</div>
                </div>
                <div className="coverage-row">
                  {(c.skills || []).slice(0, 8).map((s, i) => <span key={i} className="coverage-chip" style={{ background: '#00766f12', color: '#00766f' }}><Check size={11} />{s}</span>)}
                </div>
                <div className="evidence-box" style={{ borderLeftColor: '#7c3aed' }}>
                  <div className="evidence-label"><Sparkles size={12} />WHY THIS MATCH</div>
                  <div className="evidence-text">{r.reason || c.summary || 'Matched against the job description.'}</div>
                </div>
              </div>
              <div className="card-right">
                <div className="score-area"><div className="score-value" style={{ color: scoreColor }}>{score}</div><div className="score-unit">%</div></div>
                <div className="score-label">FIT</div>
                <div className="card-open"><ArrowRight size={13} /></div>
              </div>
            </div>;
          })}
        </div>
      </div>
    </div>}

    {/* ====== ALL APPLICANTS VIEW ====== */}
    {view === 'applicants' && <div className="view-container">
      <div className="applicants-header">
        <div className="results-label">ALL CVS · {totalCandidates} CANDIDATES</div>
        <div className="results-meta">
          <Database size={13} /> Seed with sample CVs
          <span className="meta-dot">·</span>
          Drop files to add
        </div>
      </div>
      <div className="applicants-list">
        {candidates.length === 0 && <div className="empty-state">
          <Users size={34} />
          <div className="empty-title">No CVs uploaded yet</div>
          <div className="empty-desc">Upload CVs above to start building your candidate pipeline.</div>
        </div>}
        {candidates.map((c, i) => {
          const [avBg, avColor] = avatarPalette(i);
          const skillPreview = (c.skills || []).slice(0, 4);
          const extraSkills = Math.max(0, (c.skills || []).length - 4);
          return <div key={c.id} className="applicant-row">
            <div className="card-avatar" style={{ background: avBg, color: avColor, width: 44, height: 44, fontSize: 14 }}>
              {initials(c.name)}
            </div>
            <div className="applicant-info">
              <div className="applicant-name">{c.name}</div>
              <div className="applicant-meta">
                {c.current_title && <span className="meta-item"><Briefcase size={12} /> {c.current_title}</span>}
                {c.years_experience > 0 && <span className="meta-item"><Clock size={12} /> {c.years_experience} yrs</span>}
                {c.locations && c.locations[0] && <span className="meta-item"><ArrowDownWideNarrow size={12} /> {c.locations[0]}</span>}
              </div>
              <div className="applicant-skills">
                {skillPreview.map((s, j) =>
                  <span key={j} className="token-chip" style={{ fontSize: 11, padding: '2px 7px' }}>{s}</span>
                )}
                {extraSkills > 0 && <span className="extra-skills">+{extraSkills} more</span>}
              </div>
            </div>
            <div className="applicant-actions">
              <button className="btn-icon" title="View CV" onClick={() => setDrawerId(c.id)}>
                <FileText size={15} />
              </button>
              <button className="btn-icon btn-icon-danger" title="Delete" onClick={async () => {
                if (!confirm(`Delete ${c.name}'s CV?`)) return;
                try {
                  await api.deleteCandidate(c.id);
                  await refresh();
                } catch (e) { setError(e.message); }
              }}>
                <XCircle size={15} />
              </button>
            </div>
          </div>;
        })}
      </div>
    </div>}

    {/* ====== PRESCREEN VIEW ====== */}
    {view === 'prescreen' && <div className="view-container">
      <div className="criteria-card">
        <div className="criteria-header">
          <ListChecks size={18} />
          <span className="criteria-title">Screening criteria</span>
          <span className="criteria-meta">— auto-screen all {corpus} parsed CVs against these</span>
        </div>
        <div className="criteria-grid">
          <div>
            <div className="criteria-label">REQUIRED SKILLS</div>
            <div className="req-skills-row">
              {reqSkills.map((s, i) => (
                <span key={i} className="token-chip">
                  {s}
                  <button className="token-remove" onClick={() => { setReqSkills(reqSkills.filter((_, j) => j !== i)); setPreRan(false); }}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input value={reqInput} onChange={e => setReqInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addReq(e.target.value); } }}
                placeholder="+ add requirement…" className="req-input" />
            </div>
          </div>
          <div>
            <div className="criteria-label">MIN. EXPERIENCE</div>
            <div className="exp-slider-wrap">
              <input type="range" min="0" max="15" value={preMinYears}
                onChange={e => { setPreMinYears(Number(e.target.value)); setPreRan(false); }}
                className="exp-slider" />
              <span className="exp-slider-value">{preMinYears === 0 ? 'Any' : `${preMinYears}+ yrs`}</span>
            </div>
          </div>
        </div>
        <div className="criteria-actions">
          <button className="btn-primary" onClick={runPrescreen} disabled={reqSkills.length === 0}>
            <Play size={16} /> Run prescreening
          </button>
          {preRan && (
            <div className="criteria-stats">
              <Database size={14} /> Pre-screened <strong>{corpus}</strong> CVs against {reqSkills.length + 1} requirements
            </div>
          )}
        </div>
      </div>

      {preRan && <div className="pre-results">
        <div className="pre-header">
          <div className="results-label">RANKED CANDIDATES · {preResults.length} SHOWN</div>
          <div className="results-meta">sorted by requirements met, then fit score</div>
        </div>
        <div className="results-list">
          {preResults.map((r, i) => {
            const c = r.candidate;
            const [avBg, avColor] = avatarPalette(i);
            return <div key={c.id} className="result-card" onClick={() => setDrawerId(c.id)}>
              <div className="card-left">
                <div className="card-avatar" style={{ background: avBg, color: avColor }}>{initials(c.name)}</div>
              </div>
              <div className="card-body">
                <div className="card-head">
                  <div className="card-name">{c.name}</div>
                  <div className="card-meta">{c.current_title || c.file_name}{c.years_experience ? ` · ${c.years_experience} yrs` : ''}{c.locations && c.locations[0] ? ` · ${c.locations[0]}` : ''}</div>
                </div>
                <div className="requirement-chips">
                  {reqSkills.map((s, j) => {
                    const has = (c.skills || []).some(sk => sk.toLowerCase().includes(s.toLowerCase()));
                    return <span key={j} className={`req-chip ${has ? 'pass' : 'fail'}`}>
                      {has ? <Check size={12} /> : <X size={12} />} {s}
                    </span>;
                  })}
                  <span className={`req-chip ${(c.years_experience || 0) >= preMinYears ? 'pass' : 'fail'}`}>
                    {(c.years_experience || 0) >= preMinYears ? <Check size={12} /> : <X size={12} />} {preMinYears}+ yrs
                  </span>
                </div>
              </div>
              <div className="card-right">
                <div className="card-pass">{reqSkills.filter(s => (c.skills||[]).some(sk => sk.toLowerCase().includes(s.toLowerCase()))).length + ((c.years_experience||0) >= preMinYears ? 1 : 0)}/{reqSkills.length + 1}</div>
                <div className="card-open"><ArrowRight size={13} /></div>
              </div>
            </div>;
          })}
        </div>
        {preResults.length === 0 && <div className="empty-state">
          <ListChecks size={30} />
          <div className="empty-title">No candidates matched your requirements</div>
          <div className="empty-desc">Try loosening the criteria or adding more CVs.</div>
        </div>}
      </div>}
    </div>}

    {/* CV DRAWER */}
    {drawerId && drawerCandidate && (
      <>
        <div className="drawer-overlay" onClick={() => setDrawerId(null)} />
        <div className="drawer">
          <div className="drawer-head">
            <div className="card-avatar" style={avatarPalette(drawerCandidate.id ? drawerCandidate.id.length : 0)}>
              {initials(drawerCandidate.name)}
            </div>
            <div className="drawer-info">
              <div className="drawer-name">{drawerCandidate.name}</div>
              <div className="card-meta">{drawerCandidate.current_title}{drawerCandidate.years_experience ? ` · ${drawerCandidate.years_experience} yrs` : ''}{drawerCandidate.locations && drawerCandidate.locations[0] ? ` · ${drawerCandidate.locations[0]}` : ''}</div>
            </div>
            <button className="drawer-close" onClick={() => setDrawerId(null)}><X size={17} /></button>
          </div>
          <div className="drawer-body">
            <div className="ai-summary">
              <Sparkles size={14} />
              <span className="ai-label">AI SUMMARY</span>
              <span className="ai-badge">Generated · not part of the submitted CV</span>
            </div>
            <div className="ai-text">{drawerCandidate.summary || 'No AI summary available.'}</div>
            <div className="drawer-cv">
              <div className="cv-path"><FileIcon size={12} /> {drawerCandidate.file_name}</div>
              <div className="cv-header">SUBMITTED CV · FULL TEXT</div>
              {drawerCandidate.raw_text ? <div className="cv-text">{drawerCandidate.raw_text}</div> : <div className="cv-placeholder">Raw CV text not available.</div>}
            </div>
          </div>
          <div className="drawer-footer">
            <button className="btn-primary"><UserCheck size={16} /> Shortlist candidate</button>
            <button className="btn-secondary"><Download size={16} /> Download CV</button>
          </div>
        </div>
      </>
    )}
  </div>;
}

function FilterGroup({ label, children }) {
  return <div className="filter-group">
    <span className="filter-label">{label}</span>
    {children}
  </div>;
}

function SegControl({ options, value, onChange }) {
  return <div className="seg-control">
    {options.map(opt => (
      <button key={opt.value}
        className={`seg-btn ${value === opt.value ? 'active' : ''}`}
        onClick={() => onChange(opt.value)}>
        {opt.label}
      </button>
    ))}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

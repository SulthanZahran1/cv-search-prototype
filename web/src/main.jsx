import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, Search, FileText, Sparkles, Users, AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
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
  async search(query) {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
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
    let pollCount = 0;

    async function poll() {
      pollCount++;
      try {
        // Fetch all requested jobs
        const results = await Promise.all(
          jobIds.map(id => api.job(id).then(r => r.job).catch(() => null))
        );
        if (!active) return;

        const update = {};
        let allDone = true;
        jobIds.forEach((id, i) => {
          update[id] = results[i];
          if (results[i] && results[i].status !== 'completed' && results[i].status !== 'failed') {
            allDone = false;
          }
        });

        const str = JSON.stringify(update);
        if (str !== prevStr.current) {
          prevStr.current = str;
          setJobs(prev => ({ ...prev, ...update }));
        }

        if (allDone) return; // stop polling
      } catch { /* retry */ }

      if (active) setTimeout(poll, 1500);
    }

    // Immediate first poll after short delay to let workers start
    setTimeout(poll, 500);
    return () => { active = false; };
  }, [jobIds.sort().join(',')]);

  return jobs;
}

function App() {
  const [health, setHealth] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [activeJobIds, setActiveJobIds] = useState([]);
  const [uploadFileNames, setUploadFileNames] = useState({});
  const [query, setQuery] = useState('backend engineer with Go Kafka Postgres fintech remote');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  const [error, setError] = useState('');

  const jobData = useJobPolling(activeJobIds);

  async function refresh() {
    const [h, c] = await Promise.all([api.health(), api.candidates()]);
    setHealth(h); setCandidates(c.candidates || []);
  }
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);

  // When all jobs resolve, refresh candidates
  useEffect(() => {
    if (!activeJobIds.length) return;
    const allDone = activeJobIds.every(id => {
      const j = jobData[id];
      return j && (j.status === 'completed' || j.status === 'failed');
    });
    if (allDone) {
      refresh().catch(e => setError(e.message));
    }
  }, [jobData, activeJobIds]);

  async function doUpload(files) {
    if (!files?.length) return;
    setError(''); setUploading(true);
    const names = {};
    [...files].forEach(f => { names[null] = f.name; });
    try {
      const res = await api.upload(files);
      const ids = [];
      const namesMap = {};
      (res.jobs || []).forEach(item => {
        if (item.job_id) { ids.push(item.job_id); namesMap[item.job_id] = item.file_name; }
      });
      setActiveJobIds(ids);
      setUploadFileNames(namesMap);
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function doSearch(e) {
    e.preventDefault(); if (!query.trim()) return;
    setError(''); setSearching(true);
    try { setSearchResult(await api.search(query)); }
    catch (e) { setError(e.message); }
    finally { setSearching(false); }
  }

  const stats = useMemo(() => {
    const skills = new Set();
    candidates.forEach(c => (c.skills || []).forEach(s => skills.add(s.toLowerCase())));
    return { candidates: candidates.length, skills: skills.size, llm: health?.llm_enabled };
  }, [candidates, health]);

  const pendingJobs = activeJobIds.filter(id => {
    const j = jobData[id];
    return j && j.status !== 'completed' && j.status !== 'failed';
  });

  return <div className="app">
    <header className="hero">
      <div className="eyebrow"><Sparkles size={16}/> LLM-assisted CV Intelligence Index</div>
      <h1>Search CVs like a recruiter, grounded by real uploaded documents.</h1>
      <p>Upload one CV or a batch, extract candidate profiles via background workers, then search with natural language.</p>
      <div className="stats">
        <Stat icon={<Users/>} label="Candidates" value={stats.candidates}/>
        <Stat icon={<FileText/>} label="Detected skills" value={stats.skills}/>
        <Stat icon={<Sparkles/>} label="LLM rerank" value={stats.llm ? 'Live' : 'Fallback'}/>
        <Stat icon={<FileText/>} label="Cloud OCR" value={health?.ocr_enabled ? 'Gemini' : 'Off'}/>
        {pendingJobs.length > 0 && <Stat icon={<Loader2 className="spin"/>} label="Processing" value={pendingJobs.length}/>}
      </div>
    </header>

    {error && <div className="alert"><AlertCircle size={18}/>{error}</div>}

    <main className="grid">
      <section className="card upload-card">
        <h2><Upload size={20}/> Add CVs</h2>
        <p>Singular or batch. Supported: PDF, DOCX, TXT/MD, PNG/JPG/WebP. PDFs/images use Gemini cloud OCR first; text extraction remains as fallback.</p>
        <label className="drop">
          <input type="file" multiple accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp" onChange={e => doUpload(e.target.files)} />
          <Upload size={36}/>
          <strong>{uploading ? 'Queuing CVs…' : 'Drop/click to upload CVs'}</strong>
          <span>Files are processed asynchronously — watch the status below.</span>
        </label>

        {activeJobIds.length > 0 && <div className="job-list">
          {activeJobIds.map(id => {
            const job = jobData[id];
            if (!job) return <div key={id} className="job-row"><Clock size={16}/><div>{uploadFileNames[id] || id}<span>pending</span></div></div>;
            const meta = JOB_LABELS[job.status] || JOB_LABELS.queued;
            const Icon = meta.icon;
            const isActive = job.status === 'extracting' || job.status === 'indexing';
            return <div key={id} className={`job-row ${job.status}`}>
              {isActive ? <Loader2 size={16} className="spin"/> : <Icon size={16} style={{color: meta.color}}/>}
              <div>
                <strong>{job.file_name}</strong>
                <span style={{color: meta.color}}>
                  {meta.label}
                  {job.status === 'completed' ? ` — indexed via ${job.mode || 'fallback'}` : ''}
                  {job.status === 'failed' ? ` — ${job.error}` : ''}
                </span>
              </div>
            </div>;
          })}
        </div>}
      </section>

      <section className="card search-card">
        <h2><Search size={20}/> Search candidates</h2>
        <form onSubmit={doSearch} className="search-form">
          <textarea value={query} onChange={e => setQuery(e.target.value)} placeholder="Find backend engineers with Go, Kafka, fintech experience, open to remote…" />
          <button disabled={searching || pendingJobs.length > 0}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        {searchResult && <div className="results">
          <div className="mode">Mode: {searchResult.mode}</div>
          {(searchResult.results || []).length === 0 && <p className="muted">No matches yet. Upload CVs or broaden the query.</p>}
          {pendingJobs.length > 0 && <p className="muted"><Loader2 size={14} className="spin"/> {pendingJobs.length} CV{(pendingJobs.length===1)?'':'s'} still processing — indexing isn't complete yet.</p>}
          {(searchResult.results || []).map(r => <CandidateCard key={r.candidate.id} candidate={r.candidate} score={r.score} reason={r.reason}/>)}
        </div>}
      </section>
    </main>

    <section className="card full">
      <h2>Indexed candidates</h2>
      {candidates.length === 0 ?
        <p className="muted">No CVs indexed yet. Upload a sample TXT/PDF/DOCX to test the flow.</p> :
        <div className="candidate-list">{candidates.map(c => <CandidateCard key={c.id} candidate={c}/>)}</div>}
    </section>
  </div>;
}

function Stat({ icon, label, value }) {
  return <div className="stat">{React.cloneElement(icon, {size: 20})}<div><strong>{value}</strong><span>{label}</span></div></div>;
}

function CandidateCard({ candidate: c, score, reason }) {
  return <article className="candidate">
    <div className="candidate-head">
      <div><h3>{c.name}</h3><p>{c.current_title || c.file_name}</p></div>
      {score !== undefined && <div className="score">{Math.round(score)}</div>}
    </div>
    <p className="summary">{c.summary || 'No summary extracted.'}</p>
    {reason && <p className="reason"><Sparkles size={14}/>{reason}</p>}
    <div className="chips">{(c.skills || []).slice(0, 12).map(s => <span key={s}>{s}</span>)}</div>
    <div className="meta">
      {c.years_experience ? <span>{c.years_experience}+ yrs</span> : null}
      {c.seniority ? <span>{c.seniority}</span> : null}
      {(c.locations || []).slice(0,3).map(l => <span key={l}>{l}</span>)}
      {c.email ? <span>{c.email}</span> : null}
    </div>
  </article>;
}

createRoot(document.getElementById('root')).render(<App />);

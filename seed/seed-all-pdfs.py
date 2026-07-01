#!/usr/bin/env python3
"""Upload all sample PDFs from the mounted /app/sample-pdfs directory through the upload API."""
import os, sys, time, json, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8095"

# Find PDFs from the host path
pdf_dir = os.path.expanduser("~/hosted_projects/cv-search-prototype/sample-cvs/hf-it-pdfs/")
if not os.path.isdir(pdf_dir):
    pdf_dir = os.path.expanduser("~/cv-search-prototype/sample-cvs/hf-it-pdfs/")
if not os.path.isdir(pdf_dir):
    # try relative to script
    pdf_dir = os.path.join(os.path.dirname(__file__) or ".", "../sample-cvs/hf-it-pdfs")
pdf_dir = os.path.abspath(pdf_dir)

pdfs = sorted([f for f in os.listdir(pdf_dir) if f.lower().endswith(".pdf")])
print(f"Found {len(pdfs)} PDFs in {pdf_dir}")

job_ids = []
for i, fname in enumerate(pdfs):
    path = os.path.join(pdf_dir, fname)
    with open(path, "rb") as f:
        data = f.read()
    boundary = f"----boundary{i}"
    body = []
    body.append(f"--{boundary}")
    body.append(f'Content-Disposition: form-data; name="files"; filename="{fname}"')
    body.append("Content-Type: application/pdf")
    body.append("")
    body.append("--PLACEHOLDER--")  # replaced with binary
    body.append(f"--{boundary}--")
    
    body_str = "\r\n".join(body)
    body_str = body_str.replace("--PLACEHOLDER--", data.decode("latin-1"))
    body_bytes = body_str.encode("latin-1")
    
    req = urllib.request.Request(
        f"{BASE}/api/upload",
        data=body_bytes,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        jid = result["jobs"][0]["job_id"]
        job_ids.append(jid)
        print(f"  [{i+1}/{len(pdfs)}] {fname} → job {jid[:12]}...")
    except Exception as e:
        print(f"  [{i+1}/{len(pdfs)}] {fname} FAILED: {e}")

print(f"\n{len(job_ids)}/{len(pdfs)} uploaded. Waiting for processing...")

# Poll until all jobs complete
max_wait = 300
start = time.time()
while job_ids and time.time() - start < max_wait:
    done = []
    for jid in list(job_ids):
        try:
            resp = urllib.request.urlopen(f"{BASE}/api/jobs?id={jid}", timeout=10)
            job = json.loads(resp.read())["job"]
            if job["status"] in ("completed", "failed"):
                done.append(jid)
                if job["status"] == "failed":
                    print(f"  JOB FAILED: {jid[:12]} ({job.get('error','')[:80]})")
        except:
            pass
    for jid in done:
        job_ids.remove(jid)
    if job_ids:
        time.sleep(2)

elapsed = time.time() - start
print(f"\nDone in {elapsed:.0f}s. Remaining jobs: {len(job_ids)}")
# Final health
resp = urllib.request.urlopen(f"{BASE}/api/health")
print(json.dumps(json.loads(resp.read()), indent=2))

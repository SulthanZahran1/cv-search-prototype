#!/usr/bin/env python3
"""Seed CV Search with real PDF resumes from Hugging Face.

Dataset: opensporks/resumes
Category: INFORMATION-TECHNOLOGY PDFs
License per dataset card: CC0-1.0

This intentionally uploads PDFs through /api/upload so the app exercises its
PDF -> pdftotext -> LLM/fallback extraction pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

HF_API = "https://huggingface.co/api/datasets/opensporks/resumes"
HF_RESOLVE = "https://huggingface.co/datasets/opensporks/resumes/resolve/main/"


def fetch_paths(limit: int, category: str, offset: int = 0) -> list[str]:
    with urllib.request.urlopen(HF_API, timeout=30) as resp:
        info = json.load(resp)
    prefix = f"data/data/{category}/"
    paths = [s["rfilename"] for s in info.get("siblings", []) if s.get("rfilename", "").startswith(prefix) and s.get("rfilename", "").endswith(".pdf")]
    paths.sort()
    return paths[offset:offset + limit]


def download(path: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    url = HF_RESOLVE + urllib.parse.quote(path, safe="/")
    dest = out_dir / Path(path).name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    with urllib.request.urlopen(url, timeout=90) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest


def pdftotext_ok(pdf: Path) -> tuple[bool, int]:
    try:
        res = subprocess.run(["pdftotext", "-layout", str(pdf), "-"], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    except Exception:
        return False, 0
    text = res.stdout.strip()
    return res.returncode == 0 and len(text) > 200, len(text)


def upload(api_base: str, pdf: Path) -> str:
    res = subprocess.run(
        ["curl", "-fsS", "-X", "POST", f"{api_base.rstrip('/')}/api/upload", "-F", f"files=@{pdf}"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8095", help="CV Search API base URL")
    parser.add_argument("--limit", type=int, default=24, help="How many PDFs to seed")
    parser.add_argument("--offset", type=int, default=0, help="Skip the first N PDFs in the HF category")
    parser.add_argument("--category", default="INFORMATION-TECHNOLOGY", help="opensporks/resumes category")
    parser.add_argument("--cache-dir", default="sample-cvs/hf-it-pdfs", help="Where to cache downloaded PDFs")
    parser.add_argument("--sleep", type=float, default=0.4, help="Pause between uploads")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    cache_dir = (root / args.cache_dir).resolve()
    paths = fetch_paths(args.limit, args.category, args.offset)
    if not paths:
        print(f"No PDF paths found for category {args.category}", file=sys.stderr)
        return 1

    print(f"Seeding {len(paths)} PDFs from opensporks/resumes::{args.category}")
    ok_count = 0
    for i, path in enumerate(paths, 1):
        pdf = download(path, cache_dir)
        ok, text_len = pdftotext_ok(pdf)
        if not ok:
            print(f"[{i}/{len(paths)}] SKIP {pdf.name}: pdftotext text_len={text_len}")
            continue
        body = upload(args.api, pdf)
        print(f"[{i}/{len(paths)}] uploaded {pdf.name} text_len={text_len} response={body[:160]}")
        ok_count += 1
        time.sleep(args.sleep)

    print(f"Uploaded {ok_count}/{len(paths)} PDF resumes")
    return 0 if ok_count else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Token counter for The Ultimate Go Book & Beyond.

Exact tokenizers  : GPT-6 / GPT-5 / GPT-4o (o200k_base), GPT-4 Turbo (cl100k_base)
Approximated      : Claude 5.x, Gemini 3.x, DeepSeek V4.x, Qwen 3.x, Llama 4, Mistral
                    using published chars-per-token ratios on mixed code+prose.

Models covered (latest frontier landscape, September 2026):
  OpenAI    : GPT-6 Astra, GPT-6 Sol (Code), GPT-6 Luna, o3 / GPT-4o
  Anthropic : Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, Claude Haiku 4.5
  Google    : Gemini 3.8 Flash, Gemini 3.1 Pro, Gemini 2.5 Flash
  DeepSeek  : DeepSeek V4.1 Flash, DeepSeek V4 Pro, DeepSeek R1
  Qwen      : Qwen 3.8 Omni-Flash, Qwen 3.8 Max, Qwen 3.6 Plus
  Meta      : Llama 4 Maverick, Llama 3.3 70B
  Mistral   : Mistral Large 3, Codestral 2

Usage:   npm run token-count
"""

import os
import sys
import json
import time
import datetime
from pathlib import Path

try:
    import tiktoken
except ImportError:
    print("Installing tiktoken...")
    os.system(f"{sys.executable} -m pip install tiktoken -q")
    import tiktoken

ROOT        = Path(__file__).parent.parent
CHAPTERS    = ROOT / "files" / "chapters"
SKIP        = {"BOOK-UPDATE-CHECKLIST.md", "IMPROVEMENT-PLAN.md", "PLAN-CPP-CHAPTERS.md"}

# ── Model definitions ─────────────────────────────────────────────────────────
# (id, display_name, ratio_vs_cl100k, tiktoken_encoding_or_approx)
#
# Ratio notes (English code+prose benchmarks):
#   Claude 5.x   : Anthropic BPE, ~0.96x cl100k
#   Gemini 3.x   : Google SentencePiece 256k vocab, ~0.98x cl100k
#   DeepSeek V4  : Custom BPE, code-optimised, ~0.94x cl100k
#   Qwen 3.8     : Custom tiktoken 150k vocab, ~0.95x cl100k
#   Llama 4      : Meta 128k BPE, ~0.95x cl100k
#   Mistral      : Tekken 128k BPE, ~0.95x cl100k
#   GPT-6 / 5.x  : OpenAI o200k_base (exact via tiktoken)

MODELS = [
    # OpenAI
    ("gpt6_astra",   "GPT-6 Astra",        1.000, "o200k"),
    ("gpt6_sol",     "GPT-6 Sol (Code)",   1.000, "o200k"),
    ("gpt6_luna",    "GPT-6 Luna",         1.000, "o200k"),
    ("o3_gpt4o",     "o3 / GPT-4o",        1.000, "o200k"),
    # Anthropic
    ("claude_55o",   "Claude Opus 5.5",    0.96,  "approx"),
    ("claude_55s",   "Claude Sonnet 5.5",  0.96,  "approx"),
    ("claude_51f",   "Claude Fable 5.1",   0.96,  "approx"),
    ("claude_45h",   "Claude Haiku 4.5",   0.96,  "approx"),
    # Google
    ("gemini_38f",   "Gemini 3.8 Flash",   0.98,  "approx"),
    ("gemini_31p",   "Gemini 3.1 Pro",     0.98,  "approx"),
    ("gemini_25fl",  "Gemini 2.5 Flash",   0.98,  "approx"),
    # DeepSeek
    ("ds_v41f",      "DeepSeek V4.1 Flash",0.94,  "approx"),
    ("ds_v4pro",     "DeepSeek V4 Pro",    0.94,  "approx"),
    ("ds_r1",        "DeepSeek R1",        0.94,  "approx"),
    # Qwen
    ("qwen38_omni",  "Qwen 3.8 Omni-Flash",0.95,  "approx"),
    ("qwen38_max",   "Qwen 3.8 Max",       0.95,  "approx"),
    ("qwen36_plus",  "Qwen 3.6 Plus",      0.95,  "approx"),
    # Meta
    ("llama4_mav",   "Llama 4 Maverick",   0.95,  "approx"),
    ("llama33_70b",  "Llama 3.3 70B",      0.95,  "approx"),
    # Mistral
    ("mistral_lg3",  "Mistral Large 3",    0.95,  "approx"),
    ("codestral_2",  "Codestral 2",        0.94,  "approx"),
]

FAMILIES = {
    "OpenAI":    ["gpt6_astra", "gpt6_sol", "gpt6_luna", "o3_gpt4o"],
    "Anthropic": ["claude_55o", "claude_55s", "claude_51f", "claude_45h"],
    "Google":    ["gemini_38f", "gemini_31p", "gemini_25fl"],
    "DeepSeek":  ["ds_v41f", "ds_v4pro", "ds_r1"],
    "Qwen":      ["qwen38_omni", "qwen38_max", "qwen36_plus"],
    "Meta":      ["llama4_mav", "llama33_70b"],
    "Mistral":   ["mistral_lg3", "codestral_2"],
}
family_of = {mid: fam for fam, mids in FAMILIES.items() for mid in mids}

# ── Read all markdown files ───────────────────────────────────────────────────

print("\nReading markdown files...")
t0 = time.time()

files = sorted(CHAPTERS.rglob("*.md"))
files = [f for f in files if f.name not in SKIP]

all_text      = []
total_files   = 0
total_lines   = 0
content_lines = 0
code_lines    = 0
total_words   = 0
total_chars   = 0

for path in files:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    all_text.append(raw)
    total_files   += 1
    total_chars   += len(raw)
    in_code = False
    for line in raw.splitlines():
        total_lines += 1
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code = not in_code
        if stripped:
            content_lines += 1
            if in_code:
                code_lines += 1
        total_words += len(stripped.split()) if stripped else 0

full_text   = "\n".join(all_text)
prose_lines = content_lines - code_lines
est_pages   = round(total_words / 275)

print(f"  {total_files:,} files in {time.time()-t0:.1f}s | {total_chars:,} chars | {total_words:,} words")

# ── Tokenize with tiktoken (used as base for all models) ─────────────────────

print("\nRunning tiktoken encoders (this takes ~1-2 min)...")

t1 = time.time()
enc_cl = tiktoken.get_encoding("cl100k_base")
cl_tokens = len(enc_cl.encode(full_text, disallowed_special=()))
print(f"  cl100k_base (GPT-4 base) : {cl_tokens:,} tokens  ({time.time()-t1:.1f}s)")

t2 = time.time()
enc_o = tiktoken.get_encoding("o200k_base")
o_tokens = len(enc_o.encode(full_text, disallowed_special=()))
print(f"  o200k_base  (GPT-5.x)    : {o_tokens:,} tokens  ({time.time()-t2:.1f}s)")

# ── Build per-model results ───────────────────────────────────────────────────

token_results = {}
def to_m(n):
    """Format a number as xM (millions) or xK."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)

for model_id, name, ratio, method in MODELS:
    if method == "cl100k":
        count = cl_tokens
    elif method == "o200k":
        count = o_tokens
    else:
        count = round(cl_tokens * ratio)

    token_results[model_id] = {
        "name":     name,
        "family":   family_of.get(model_id, ""),
        "countFmt": to_m(count),
        "method":   "exact" if method in ("cl100k", "o200k") else "approx",
    }

# ── Write JSON ────────────────────────────────────────────────────────────────

stats_json = {
    "generatedAt":    datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "files":          to_m(total_files),
    "totalLines":     to_m(total_lines),
    "contentLines":   to_m(content_lines),
    "proseLines":     to_m(prose_lines),
    "codeLines":      to_m(code_lines),
    "totalWords":     to_m(total_words),
    "totalCharsRaw":  to_m(total_chars),
    "estimatedPages": f"{est_pages:,}",
    "tokens":         token_results,
}

# ── Print report ──────────────────────────────────────────────────────────────

W   = 60
DIV = "-" * W

print(f"\n{DIV}")
print(f"  CONTENT STATS")
print(DIV)
for label, val in [
    ("Source files",    f"{total_files:,}"),
    ("Total lines",     f"{total_lines:,}"),
    ("Content lines",   f"{content_lines:,}  (non-empty)"),
    ("Prose lines",     f"{prose_lines:,}"),
    ("Code lines",      f"{code_lines:,}"),
    ("Words",           f"{total_words:,}"),
    ("Characters",      f"{total_chars:,}"),
    ("Est. pages",      f"{est_pages:,}  (~275 words/page)"),
]:
    print(f"  {label:<24} {val}")

print(f"\n{DIV}")
print(f"  TOKEN COUNTS")
print(DIV)
print(f"  {'Model':<24} {'Provider':<13} {'Tokens':>10}")
print(f"  {'-'*24} {'-'*13} {'-'*10}")

prev_fam = None
for model_id, name, ratio, method in MODELS:
    fam = family_of.get(model_id, "")
    if fam != prev_fam:
        print()
        prev_fam = fam
    r = token_results[model_id]
    print(f"  {name:<24} {fam:<13} {r['countFmt']:>10}")

print(f"\n{DIV}")
print(f"  Written to: public/book-stats.json")
print(f"{DIV}\n")

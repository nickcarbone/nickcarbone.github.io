#!/usr/bin/env python3
"""Daily desk briefing: prints only what the morning run needs from the desk files.

Usage: python3 daily/_desk/desk_brief.py        (run from the repo root)

Prints, in order:
  TODAY and whether a piece dated TODAY is already in the manifest (runbook step 1.3)
  the next piece number
  the last 14 pieces: no, date, kind, title, design note (runbook step 2.3)
  the titles in pages.json (Nick's other pages)
  the queue (runbook step 2.1): CORRECTION entries, the first three ideas in full,
  and the titles of the rest

Read-only. Standard library only. If it fails, fall back to reading daily/manifest.json,
pages.json and daily/_desk/QUEUE.md directly, as the runbook describes.
"""
import json, re, sys
from datetime import datetime
from zoneinfo import ZoneInfo

today = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
pieces = json.load(open("daily/manifest.json"))["pieces"]

print(f"TODAY: {today}")
done = [p for p in pieces if p["date"] == today]
print("PUBLISHED_TODAY: " + (f"yes (No. {done[0]['no']}, {done[0]['slug']})" if done else "no"))
print(f"NEXT_NO: {max(p['no'] for p in pieces) + 1}")

print("\n== Last 14 pieces ==")
for p in pieces[:14]:
    print(f"No. {p['no']} | {p['date']} | {p['kind']} | {p['title']} | {p.get('design', '')}")

try:
    pg = json.load(open("pages.json"))
    pg = pg["pages"] if isinstance(pg, dict) else pg
    print("\n== pages.json titles ==")
    print("; ".join(x.get("title", "") for x in pg))
except Exception as e:
    print(f"\n== pages.json unreadable ({e}); skim it by hand ==")

print("\n== Queue ==")
q = open("daily/_desk/QUEUE.md", encoding="utf-8").read()
m = re.search(r"^# Ideas\s*$", q, re.M)
p = re.search(r"^# Parked\s*$", q, re.M)
if not m or not p:
    print("WARNING: '# Ideas' or '# Parked' heading missing. Read QUEUE.md by hand and log what you did.")
    sys.exit(0)
body = re.sub(r"<!--.*?-->", "", q[m.end():p.start()], flags=re.S)
blocks = [b.strip() for b in re.split(r"\n\s*\n", body)]
blocks = [b for b in blocks if b and set(b) != {"-"}]
corr = [b for b in blocks if re.sub(r"^##\s*", "", b.splitlines()[0]).startswith("CORRECTION:")]
ideas = [b for b in blocks if b not in corr]
print(f"Ideas in queue: {len(ideas)}   Correction entries: {len(corr)}")
for b in corr:
    print("\n-- CORRECTION entry --\n" + b)
for i, b in enumerate(ideas[:3], 1):
    print(f"\n-- Idea {i} --\n{b}")
if len(ideas) > 3:
    print("\n-- Remaining idea titles --")
    for b in ideas[3:]:
        print("- " + re.sub(r"^##\s*", "", b.splitlines()[0]))

#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path

cases = [
    {
        "input": "哥们我看不懂图，你就告诉我今天网上是在喊冲还是喊跑。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+crypto+is:issue&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
pos = ("bull", "breakout", "pump", "etf", "approve", "surge")
neg = ("hack", "ban", "dump", "selloff", "lawsuit", "liquidation")
score = 0.0
for it in items:
    txt = f"{it.get('title','')} {it.get('body','')[:200]}".lower()
    score += sum(0.15 for k in pos if k in txt)
    score -= sum(0.15 for k in neg if k in txt)
score = max(-1.0, min(1.0, score / max(1, len(items))))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("title","") if items else ""}, ensure_ascii=False))
'''
    },
    {
        "input": "最近消息太吵了，帮我算个冷热值，越热越正，越冷越负。",
        "code": r'''
import json, urllib.request, datetime
URL = "https://api.github.com/search/repositories?q=bitcoin+trading+bot&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
now = datetime.datetime.now(datetime.timezone.utc)
heat = 0.0
for it in items:
    pushed = datetime.datetime.fromisoformat(it["pushed_at"].replace("Z", "+00:00"))
    hours = max(0.0, (now - pushed).total_seconds() / 3600.0)
    heat += 1.0 / (1.0 + hours / 24.0)
score = max(-1.0, min(1.0, (heat / max(1, len(items)) - 0.5) * 2))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("full_name","") if items else ""}, ensure_ascii=False))
'''
    },
    {
        "input": "我怕追高，给我一个保守点的外部信号，看看风险大不大。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+security+is:issue&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
risk_words = ("critical", "exploit", "breach", "vulnerability", "scam", "phishing")
risk = 0.0
for it in items:
    txt = f"{it.get('title','')} {(it.get('body') or '')[:180]}".lower()
    risk += sum(1 for w in risk_words if w in txt)
score = max(-1.0, min(1.0, -risk / max(1, len(items) * 2)))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("title","") if items else ""}, ensure_ascii=False))
'''
    },
    {
        "input": "别讲术语，直接看大家现在是乐观还是悲观。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=ethereum+bitcoin+is:issue&sort=comments&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
optim = ("adoption", "upgrade", "growth", "launch", "partnership")
pess = ("delay", "problem", "loss", "attack", "bankrupt")
score = 0.0
for it in items:
    txt = it.get("title", "").lower()
    score += sum(0.2 for k in optim if k in txt)
    score -= sum(0.2 for k in pess if k in txt)
score = max(-1.0, min(1.0, score / max(1, len(items))))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("title","") if items else ""}, ensure_ascii=False))
'''
    },
    {
        "input": "我就想知道今天危险不危险，给个一眼能懂的分。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+is:issue+is:open&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
open_hot = sum(1 for i in items if i.get("comments",0) >= 5)
score = max(-1.0, min(1.0, 1.0 - (open_hot / max(1, len(items)) * 2.0)))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": f"open_hot={open_hot}"}, ensure_ascii=False))
'''
    },
    {
        "input": "推特太乱了，我不看推特了，你抓公开数据给我个方向。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/repositories?q=topic:cryptocurrency+topic:trading&sort=stars&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
stars = [i.get("stargazers_count", 0) for i in items]
forks = [i.get("forks_count", 0) for i in items]
ratio = (sum(forks) / max(1, sum(stars)))
score = max(-1.0, min(1.0, (0.2 - ratio) * 3.0))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": f"fork_star_ratio={ratio:.4f}"}, ensure_ascii=False))
'''
    },
    {
        "input": "最近是不是都在讨论利空？你给我个直接结果。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+crash+OR+ban+OR+hack&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
mentions = sum(1 for i in items if any(k in i.get('title','').lower() for k in ("crash","ban","hack")))
score = max(-1.0, min(1.0, -mentions / max(1, len(items))))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": f"negative_mentions={mentions}"}, ensure_ascii=False))
'''
    },
    {
        "input": "别搞复杂模型，看看最近大家讨论是偏正面还是偏负面。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+is:issue&sort=comments&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
pos_words = ("profit", "growth", "bull", "green")
neg_words = ("loss", "red", "bear", "risk")
weighted = 0.0
for it in items:
    w = 1 + min(10, it.get("comments",0)) * 0.1
    t = it.get("title","").lower()
    weighted += w * (sum(1 for p in pos_words if p in t) - sum(1 for n in neg_words if n in t))
score = max(-1.0, min(1.0, weighted / max(1, len(items) * 5)))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("title","") if items else ""}, ensure_ascii=False))
'''
    },
    {
        "input": "我没背景，你就给我个现在该激进还是保守的建议分。",
        "code": r'''
import json, urllib.request, datetime
URL = "https://api.github.com/search/repositories?q=bitcoin+language:python&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
now = datetime.datetime.now(datetime.timezone.utc)
active = 0
for it in items:
    pushed = datetime.datetime.fromisoformat(it["pushed_at"].replace("Z", "+00:00"))
    if (now - pushed).total_seconds() < 7 * 86400:
        active += 1
ratio = active / max(1, len(items))
score = max(-1.0, min(1.0, (ratio - 0.5) * 2.0))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": f"active_7d={active}"}, ensure_ascii=False))
'''
    },
    {
        "input": "一句话：拿真实外部数据算个情绪分给我，不要假的。",
        "code": r'''
import json, urllib.request
URL = "https://api.github.com/search/issues?q=bitcoin+etf+OR+approval+OR+lawsuit&sort=updated&order=desc&per_page=30"
req = urllib.request.Request(URL, headers={"User-Agent": "thunderclaw-live-check"})
items = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8")).get("items", [])
score = 0.0
for it in items:
    t = it.get("title","").lower()
    if "approval" in t or "inflow" in t or "launch" in t:
        score += 0.25
    if "lawsuit" in t or "reject" in t or "delay" in t:
        score -= 0.25
score = max(-1.0, min(1.0, score / max(1, len(items))))
print(json.dumps({"score": score, "source_url": URL, "sample_size": len(items), "evidence": items[0].get("title","") if items else ""}, ensure_ascii=False))
'''
    },
]

out = []
for idx, case in enumerate(cases, start=1):
    proc = subprocess.run(["python", "-c", case["code"]], capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        out.append({"index": idx, "input": case["input"], "ok": False, "error": proc.stderr.strip(), "code": case["code"]})
        continue
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "{}"
    try:
        result = json.loads(line)
    except Exception as exc:
        out.append({"index": idx, "input": case["input"], "ok": False, "error": f"json parse: {exc}", "stdout": proc.stdout, "code": case["code"]})
        continue
    out.append({"index": idx, "input": case["input"], "ok": True, "result": result, "code": case["code"]})

artifact = {
    "total": len(cases),
    "success": sum(1 for r in out if r.get("ok")),
    "results": out,
}
Path('.artifacts').mkdir(parents=True, exist_ok=True)
Path('.artifacts/nonstandard-live-results.json').write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({"total": artifact["total"], "success": artifact["success"], "artifact": ".artifacts/nonstandard-live-results.json"}, ensure_ascii=False))
if artifact["success"] != artifact["total"]:
    raise SystemExit(2)

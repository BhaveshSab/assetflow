#!/bin/bash
set -euo pipefail
LAST="$1"
python3 - "$LAST" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
lines = []
lines.append("status: %s" % d.get("bootstrap_status", "unknown"))
for s in d.get("summary", [])[:6]:
    lines.append("summary: %s" % s)
for key in ("api_log_tail", "stack_up_tail", "stack_ps"):
    for x in d.get(key, [])[:12]:
        lines.append("%s: %s" % (key, x))
for x in d.get("migrate_progress", [])[-6:]:
    lines.append("progress: %s" % x)
for x in d.get("failure_detail", [])[:12]:
    lines.append("detail: %s" % x)
for x in d.get("seed_log_tail", [])[-4:]:
    lines.append("seed: %s" % x)
for line in lines[:40]:
    text = line.replace("%", "%25")
    print("::warning title=stage3-diag::%s" % text[:180])
PY

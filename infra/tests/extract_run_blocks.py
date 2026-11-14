#!/usr/bin/env python3
"""Extract every `run:` block from a workflow file and bash -n it."""
import re, subprocess, sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()
lines = text.splitlines()
blocks = []
i = 0
while i < len(lines):
    m = re.match(r'^(\s*)run: \|$', lines[i])
    if m:
        indent = len(m.group(1))
        body = []
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if line.strip() == '' or len(line) - len(line.lstrip()) > indent:
                body.append(line[indent + 2:] if len(line) > indent else '')
                j += 1
            else:
                break
        blocks.append((i + 1, '\n'.join(body)))
        i = j
    else:
        i += 1

fail = 0
for start, body in blocks:
    proc = subprocess.run(['bash', '-n'], input=body, capture_output=True, text=True)
    if proc.returncode != 0:
        fail += 1
        print('FAIL at line %d:' % start)
        print(proc.stderr)
print('checked %d run blocks, %d failed' % (len(blocks), fail))
sys.exit(1 if fail else 0)

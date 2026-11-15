#!/usr/bin/env python3
"""Verify exactly one dump against its sidecar; never follow sidecar paths."""
import hashlib
from pathlib import Path
import re
import sys


def verify(dump):
    dump = Path(dump)
    sidecar = Path(str(dump) + '.sha256').read_text()
    match = re.fullmatch(r'([0-9a-fA-F]{64}) [ *]([^\r\n]+)\n?', sidecar)
    if not match or match[2] != dump.name:
        raise ValueError('checksum must name exactly this dump, once')
    digest = hashlib.sha256()
    with dump.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != match[1].lower():
        raise ValueError('dump checksum mismatch')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('one dump path required')
        verify(sys.argv[1])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

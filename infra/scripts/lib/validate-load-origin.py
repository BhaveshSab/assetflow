#!/usr/bin/env python3
"""Validate syntax only; this is not DNS/target isolation or execution approval."""
import ipaddress
import sys
from urllib.parse import urlsplit


def validate(value):
    parsed = urlsplit(value)
    if (parsed.scheme.lower() not in {'http', 'https'} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in {'', '/'} or parsed.query or parsed.fragment
            or any(c.isspace() or c in '\\\x00' for c in value)):
        raise ValueError('BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment')
    host = parsed.hostname.lower().rstrip('.')
    port = parsed.port  # Reject invalid/out-of-range ports.
    if '%' in host or not all(c.isascii() and (c.isalnum() or c in '.-:') for c in host):
        raise ValueError('invalid hostname')
    # Reject alternative numeric spellings curl might normalize to a different
    # target (octal/hex/short IPv4). Real DNS isolation remains a separate gate.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if all(c in '0123456789abcdefx.' for c in host) and any(c.isdigit() for c in host):
            raise ValueError('ambiguous numeric hostname')
    authority = f'[{host}]' if ':' in host else host
    return f'{parsed.scheme.lower()}://{authority}' + (f':{port}' if port else '')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('one URL required')
        print(validate(sys.argv[1]))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

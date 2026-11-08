#!/usr/bin/env python3
"""Fail on duplicate mapping keys instead of silently accepting merge debris.

Requires PyYAML (CI uses the OS python3-yaml package). Validate checked-in YAML
only: don't scan server .env files or rendered configs containing secrets.
"""
from pathlib import Path
import sys
import yaml


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node):
    # Inspect explicit keys before flattening << merges: overriding an inherited
    # default is valid YAML, repeating an explicit service name is not.
    seen = set()
    for key_node, _ in node.value:
        if key_node.tag == 'tag:yaml.org,2002:merge':
            continue
        key = loader.construct_object(key_node)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                'duplicate mapping key', node.start_mark,
                f'duplicate key: {key}', key_node.start_mark,
            )
        seen.add(key)
    loader.flatten_mapping(node)
    return loader.construct_mapping(node)


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping,
)


def check(path):
    with Path(path).open() as stream:
        list(yaml.load_all(stream, Loader=UniqueKeyLoader))


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    paths = [Path(p) for p in sys.argv[1:]] or sorted([
        *root.joinpath('infra').rglob('*.yml'),
        *root.joinpath('.github/workflows').glob('*.yml'),
    ])
    failed = False
    for path in paths:
        try:
            check(path)
            print(f'YAML OK: {path.relative_to(root) if path.is_relative_to(root) else path}')
        except (yaml.YAMLError, OSError) as error:
            print(f'{path}: {error}', file=sys.stderr)
            failed = True
    sys.exit(1 if failed else 0)

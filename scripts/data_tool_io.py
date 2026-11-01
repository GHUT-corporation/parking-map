"""Stage complete UTF-8 files before replacement; roll back a failed file group.

Each rename is atomic. A sudden process/power loss between renames still requires
checking the audit against the GeoJSON; a filesystem cannot atomically rename a group.
"""
import os
from pathlib import Path
import tempfile


def write_files(payloads):
    staged = {}
    originals = {}
    replaced = []
    try:
        for destination, payload in payloads.items():
            destination = Path(destination)
            originals[destination] = destination.read_bytes() if destination.exists() else None
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=destination.name + '.', suffix='.tmp', delete=False) as stream:
                staged[destination] = Path(stream.name)
                stream.write(payload.encode('utf-8') if isinstance(payload, str) else payload)
                stream.flush()
                os.fsync(stream.fileno())
        for destination, source in staged.items():
            os.replace(source, destination)
            replaced.append(destination)
    except BaseException:
        for destination in reversed(replaced):
            original = originals[destination]
            if original is None:
                destination.unlink(missing_ok=True)
            else:
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                    source = Path(stream.name)
                    stream.write(original)
                try:
                    os.replace(source, destination)
                finally:
                    source.unlink(missing_ok=True)
        raise
    finally:
        for source in staged.values():
            source.unlink(missing_ok=True)

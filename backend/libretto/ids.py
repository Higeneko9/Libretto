import secrets
from collections.abc import Callable


def new_id(prefix: str, is_taken: Callable[[str], bool]) -> str:
    """Opaque, filesystem-safe id (matches the ^[a-z0-9][a-z0-9_-]*$ id pattern). Names are free text and never feed into it."""
    while True:
        candidate = f"{prefix}-{secrets.token_hex(4)}"
        if not is_taken(candidate):
            return candidate

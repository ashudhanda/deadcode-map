"""Call _load() when ready, and load the config first.

This module docstring is prose: it mentions _load as a word,
not as a reference.
"""

ROUTE = "tasks.sync"  # dotted dynamic reference to sync
MSG = "please _load the page"


def log_notes():
    print(MSG, ROUTE)

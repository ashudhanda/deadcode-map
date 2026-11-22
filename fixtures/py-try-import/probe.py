"""Optional-dependency imports inside try/except (FP-13).

The import itself tests whether the dependency is installed, so an
unused try-wrapped import is a probe, not dead code. This fixture
covers probes WITHOUT a `# NOQA` marker (the marked variant lives in
py-probe); the Django shapes are `try: import numpy` in
contrib/gis/shortcuts.py and `try: from PIL import Image` in
db/models/fields/files.py.
"""

import deadlib


def check_numpy():
    try:
        import numpy
    except ImportError:
        return False
    return True


def check_image():
    try:
        from PIL import Image
    except ImportError:
        return False
    return True


def check_used():
    try:
        import usedlib
    except ImportError:
        return False
    return usedlib.available()

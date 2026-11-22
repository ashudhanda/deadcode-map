"""Optional-dependency probes: the import itself tests availability.

Django does this in db/models/fields/files.py: `_check_image_library_installed`
runs `from PIL import Image  # NOQA` inside try/except — the import IS the
use (it raises ImportError when Pillow is missing), so the name is never
referenced afterwards. The `# NOQA` marker is the author saying so.
"""

import os


def _check_image_library_installed():
    try:
        from PIL import Image  # NOQA
    except ImportError:
        return ['Pillow is not installed']
    else:
        return []


def _check_other_library():
    try:
        from PIL import Image as _Image2  # noqa: F401
    except ImportError:
        return ['missing']
    else:
        return []


def run_checks():
    return _check_image_library_installed() + _check_other_library()

"""Version-gated compat shim (Django's utils/copy.py shape): the same
public name is provided by an import on new versions and by a backport
definition on old ones. The import IS the public API on its branch.
"""

import sys

if sys.version_info >= (3, 13):
    from copy import replace
else:
    # Backport of copy.replace() from Python 3.13.
    def replace(obj, /, **changes):
        """Return a new object replacing specified fields with new values."""
        return obj


from copy import deepcopy

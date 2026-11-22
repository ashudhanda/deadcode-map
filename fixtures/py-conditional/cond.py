"""Conditional module-level definitions (Django's postgis shape):
a class / function defined under a module-level `if` is still a
module-level public binding, not a local.
"""

import sys

if sys.version_info >= (3, 13):
    class PublicWidget:
        pass

if True:
    def public_fn():
        return 1


def _dead_fn():
    return 2


if True:
    def _cond_dead():
        return 3

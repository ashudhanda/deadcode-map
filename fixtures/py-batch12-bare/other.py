# Case (d): a star import must not keep a dead VARIABLE local alive.
# `from victim import *` credits every definition of victim.py,
# including the local `foo` inside outer() — but a non-exported
# variable local can never be used from another file, so that credit
# belongs to the same-named top-level `foo` in shared.py, never to
# the local. The local stays flaggable.
from shared import foo
from victim import *


def helper():
    return 1


print(foo)   # uses the top-level foo from shared.py

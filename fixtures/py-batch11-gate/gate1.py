# Batch 11 gate fixture (hand-written): a dead local named after a
# called method must still be found — an attribute read `Obj().foo()`
# names the member, not the local `foo`.
from other import helper


class Obj:
    def foo(self):
        return 1

    def qux(self):
        return 2


def outer():
    foo = 42       # dead local: only Obj().foo() shares the name
    bar = 7        # live local: read bare below

    def baz():
        return 3   # live local function: called bare below

    def qux():
        return 4   # dead local function: only Obj().qux() shares the name

    return Obj().foo() + Obj().qux() + bar + baz() + helper()


outer()

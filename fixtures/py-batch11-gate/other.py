# Same hazard from another file: the method call here must not keep
# this file's dead local alive, and must not keep gate1.py's `foo`
# alive either (a local cannot be used from another file).
class Obj2:
    def foo(self):
        return 5


def helper():
    foo = 99  # dead local: only Obj2().foo() shares the name
    return Obj2().foo()

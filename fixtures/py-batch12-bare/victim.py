# Case (d) target: a dead non-exported variable local. The star
# import in other.py credits every definition of this file, but the
# local `foo` must not receive cross-file credit.


def outer():
    foo = 99  # dead local variable: never read bare
    bar = 2   # live local: read bare below
    return bar


outer()

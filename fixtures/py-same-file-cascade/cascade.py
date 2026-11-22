# Same-file cascade: a helper used only by a dead function is dead too;
# a helper used by a live function is live.
# Dead helpers are underscore-prefixed (private): a public top-level
# name is an export, and in a fixture dir with no manifest signal an
# exported-but-never-imported symbol is REVIEW, never SAFE.


def _dead_outer():
    return _dead_inner()


def _dead_inner():
    return 1


def live_outer():
    return live_inner()


def live_inner():
    return 2


def top_called():
    return top_helper()


def top_helper():
    return 3


top_called()


def _self_only(n):
    return 0 if n <= 0 else _self_only(n - 1)


def _ping():
    return _pong()


def _pong():
    return _ping()


# A variable initializer runs in the enclosing scope: this alias keeps
# aliased() alive even though the alias itself is only read below.
def aliased():
    return 4


alias = aliased
alias()

from helpers import make_default


class Plain:
    dead_attr = 1


class LocalBase:
    pass


class Child(LocalBase):
    child_dead_attr = 1


class Widget:
    # A chain ending in an imported name, not a method of this class:
    # an ordinary alias, still a candidate — not a live interface.
    first = second = make_default


def _helper():
    return 1


_first = _second = _helper

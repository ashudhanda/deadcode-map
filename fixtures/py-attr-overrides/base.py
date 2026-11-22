"""Base classes whose attributes form a framework-read interface.

Django shape: `Func.arity` is read as `self.arity` by the base class,
and `BaseFeatures.supports_*` flags are read as
`connection.features.supports_x` by backends and tests — never via a
code reference to this file.
"""


class Func:
    """Base expression class: the framework reads arity via self."""

    arity = None
    template = "%(function)s(%(expressions)s)"
    dead_base_attr = 1

    def __init__(self, *expressions):
        if self.arity is not None and len(expressions) != self.arity:
            raise TypeError("wrong number of arguments")


class BaseFeatures:
    """Backend capability flags, read via `connection.features.<flag>`."""

    supports_x = True
    supports_y = False
    dead_feature = 1

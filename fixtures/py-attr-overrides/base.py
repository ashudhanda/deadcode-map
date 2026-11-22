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
    # Overridden by a subclass as a @cached_property method, not a
    # plain attribute (Django's PostgreSQL backend defines
    # prohibits_null_characters_in_text_exception that way): the
    # override is real either way.
    cached_flag = None
    # Documented as public API in docs.txt, though no code in this repo
    # reads it (Django's `BaseTaskBackend.supports_get_result`).
    documented_flag = False

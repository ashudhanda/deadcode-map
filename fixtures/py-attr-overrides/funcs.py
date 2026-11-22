"""Subclasses that override base-class attributes (FP-6, rule R1)."""

from base import BaseFeatures, Func


class GeoFunc(Func):
    """Middle of the chain: defines no attributes itself."""


class Area(GeoFunc):
    # Overrides Func.arity through the grandparent GeoFunc: the base
    # class reads it as self.arity, so the override is live.
    arity = 2


class Length(GeoFunc):
    arity = 1
    template = "ST_Length(%(expressions)s)"
    dead_sub_attr = 1


class BackendFeatures(BaseFeatures):
    supports_x = False

    # The class defines a method, so the config-class rule does not
    # fire: supports_x is graded by the override rule alone.
    def describe(self):
        return "backend features"

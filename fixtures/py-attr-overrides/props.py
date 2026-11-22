"""A subclass that overrides a base-class attribute with a property
method, not a plain attribute (Django's PostgreSQL backend shape).
"""

from functools import cached_property

from base import BaseFeatures


class PgFeatures(BaseFeatures):
    @cached_property
    def cached_flag(self):
        return True

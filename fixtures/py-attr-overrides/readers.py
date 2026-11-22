"""Attribute-lookup readers (FP-6, rule R2): no imports of the flags.

This file deliberately does NOT import base.py: the reader gets its
object from the caller (main.py), exactly like Django code that reads
`connection.features.supports_y` without importing the features
module. If this file imported the defining module, the graph's
member-use path would already credit the attribute — R2 exists for
readers with no import edge to the defining file.
"""


def check_features(features):
    # Reads supports_y as an attribute on a framework-provided object;
    # the defining file is never imported for the flag itself.
    return features.supports_y


def check_timeout(obj):
    # An attribute read on an unrelated object: it must NOT rescue a
    # module-level variable of the same name (see globals_mod).
    return obj._timeout

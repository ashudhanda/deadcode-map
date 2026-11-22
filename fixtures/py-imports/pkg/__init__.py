"""Package init: module metadata is read by packaging tooling, never dead."""
__version__ = "1.2.3"
__author__ = "Ashu"
__all__ = ["helper", "PUBLIC_CONST"]
PUBLIC_CONST = 42


def helper():
    return PUBLIC_CONST

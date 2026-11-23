"""Type aliases for the demo package (hand-written fixture)."""
import sys
from typing import TYPE_CHECKING, TypeAlias

if TYPE_CHECKING:
    from collections.abc import Mapping

    # Used by the annotation on format_name below.
    NameType: TypeAlias = str
    # Never referenced anywhere: dead.
    DeadType: TypeAlias = Mapping[str, str]
    # Never referenced anywhere: dead.
    OtherDeadType: TypeAlias = int | str

if sys.version_info >= (3, 10):
    # A plain version guard, not TYPE_CHECKING: still a module binding.
    LegacyType: TypeAlias = str | bytes


def format_name(name: "NameType") -> str:
    return name.upper()


class Config:
    # A plain class attribute: recorded as a definition, and
    # unreferenced here it is SAFE (the CLI grades it the same way).
    retries = 3


def make_config():
    # A function local: not a module definition, never flagged.
    timeout = 30
    return Config(), timeout

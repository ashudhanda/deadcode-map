"""TypeVar definitions are REVIEW, never SAFE (batch 13).

Hand-written fixture modeled on typer's _click/decorators.py, where
`GrpType = TypeVar("GrpType", bound=TyperGroup)` sits under
`if TYPE_CHECKING:` and is never referenced by code: the web checker
used to flag it SAFE while the CLI grades it REVIEW. A TypeVar is part
of a module's typing surface — it is declared to be named in
annotations elsewhere — so the web grader holds it at REVIEW.

Controls: GrpType is used in a string annotation, so it is live and
must never be flagged at all. A plain dead value (_dead_count) and a
dead variable whose initializer is an ordinary call (_dead_factory)
must still be found SAFE — the rule is specific to TypeVar, not to
every call initializer.
"""

from typing import TYPE_CHECKING, TypeVar

import typing

if TYPE_CHECKING:
    GrpType = TypeVar("GrpType", bound=int)
    OtherType = typing.TypeVar("OtherType")

_HiddenType = TypeVar("_HiddenType")


def make_thing():
    return 1


_dead_factory = make_thing()

_dead_count = 0


def use(value: "GrpType") -> "GrpType":
    return value


def main():
    print(use(1))


if __name__ == "__main__":
    main()

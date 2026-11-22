import os
from typing import TYPE_CHECKING, Annotated, get_type_hints

if TYPE_CHECKING:
    from ._types import Buffer, Context, TypeAdapter

__all__ = (
    "Annotated",
    "get_type_hints",
    "run",
)


def run(ctx: "Context") -> "Context | None":
    return ctx


def helper(x: "list[Buffer]") -> "TypeAdapter[Any]":
    return cast("TypeAdapter", x)


def cast(tp, value):
    return value

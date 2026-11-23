"""String annotations in nested / multi-line positions (batch 13).

Hand-written fixture modeled on the typer shapes the web checker used
to flag SAFE (batch 12): imports whose only use is a name inside a
string annotation — nested in a generic (`Union["Context", None]`,
`type["TyperCommand"]`, `list["CompletionItem"]`), or on a
continuation line of a multi-line def signature. Every live import
below must never be flagged.

The dead controls must still be found SAFE: a name that appears only
in a docstring, only in an error message, only as a default string
value, or only inside Doc("...") prose inside an annotation is not a
use — the string is not in annotation position.
"""

from typing import TYPE_CHECKING, Annotated, Callable, Optional, Union

if TYPE_CHECKING:
    from ._types import (
        CompletionItem,
        Context,
        DeadAsDefault,
        DeadInDocstring,
        DeadInMessage,
        Typer,
        TyperCommand,
        TyperGroup,
        Widget,
    )


def Default(value):
    return value


def Doc(text):
    return text


# Live: a string nested in a generic on a single-line def.
def normalize(opt: str, ctx: Union["Context", None]) -> str:
    return opt


class CommandInfo:
    # Live: a string nested in a subscript, on a continuation line of
    # a multi-line def signature.
    def __init__(
        self,
        name: str | None = None,
        *,
        cls: type["TyperCommand"] | None = None,
    ):
        self.name = name
        self.cls = cls


class TyperInfo:
    # Live: strings nested in Optional[...] / type[...], on
    # continuation lines of a multi-line def signature.
    def __init__(
        self,
        typer_instance: Optional["Typer"] = Default(None),
        *,
        cls: type["TyperGroup"] | None = Default(None),
    ):
        self.typer_instance = typer_instance
        self.cls = cls


# Live: a string nested in a Callable annotation that spans lines.
def register(
    shell_complete: Callable[
        [str],
        list["CompletionItem"] | list[str],
    ]
    | None = None,
) -> None:
    return None


# Live: a string nested in a generic in a variable annotation.
handler: Optional["Typer"] = None


# Live: a string annotation in a return annotation that spans lines.
def make() -> list[
    "Typer"
]:
    return []


# Live: the annotation itself is real, but the Doc("...") prose inside
# it is not a type — Widget must still be dead.
def show(item: Annotated[str, Doc("Widget is only prose")]) -> str:
    return item


def pick(mode="DeadAsDefault"):
    # Dead control: the name appears only as a default string value,
    # never in an annotation.
    return mode


def describe():
    # Dead control: the name appears only in a docstring.
    """DeadInDocstring is mentioned here, and nowhere else."""
    return 1


def fail():
    # Dead control: the name appears only in an error message.
    raise ValueError("DeadInMessage failed")


def main():
    print(normalize("x", None))
    print(CommandInfo(cls=None).name)
    print(TyperInfo().cls)
    register()
    print(handler)
    print(make())
    print(show("x"))
    print(pick())
    print(describe())
    try:
        fail()
    except ValueError:
        pass


if __name__ == "__main__":
    main()

"""Demo entry point: uses the live alias, never the dead ones."""
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aliases import NameType

from aliases import format_name


def show(name: "NameType") -> str:
    return format_name(name)


if __name__ == "__main__":
    print(show("demo"))

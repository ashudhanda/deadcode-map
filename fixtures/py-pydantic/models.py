from dataclasses import dataclass
from typing import overload

from pydantic import BaseModel, Field, model_validator


class User(BaseModel):
    name: str = Field(default="")
    schema_: str = Field(default=None, alias="$schema")
    vocabulary: str = ""

    @model_validator(mode="after")
    def check(self):
        return self


@dataclass
class Point:
    x: int = 0
    y: int = 0


class BaseModelWithConfig(BaseModel):
    model_config = {"extra": "allow"}


class Extended(BaseModelWithConfig):
    extra_field: str = ""


@overload
def get(x: int) -> int: ...


@overload
def get(x: str) -> str: ...


def get(x):
    return x


def unused_fn():
    return 1

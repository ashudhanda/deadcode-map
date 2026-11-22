from contextlib import contextmanager
from typing import Callable, TYPE_CHECKING, TypeAlias

if TYPE_CHECKING:
    from models import Response

Hook: TypeAlias = Callable[["Response"], None]

complete_func = "my_func"
TEMPLATE = "run %(complete_func)s"


class Client:
    @contextmanager
    def session(self):
        yield self

    @contextmanager
    def unused_ctx(self):
        yield self


class Settings:
    timeout: int


def make_client():
    return Client()


def run():
    return 1

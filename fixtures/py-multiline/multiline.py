from collections import (
    Counter,
    defaultdict,
    OrderedDict,
)
from os import path as ospath
import json, \
    re as regex


def build():
    return Counter([1, 2]), ospath.join("a", "b"), json.dumps({})

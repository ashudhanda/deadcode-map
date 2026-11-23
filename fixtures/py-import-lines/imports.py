# Regression fixture: unused imports must report their real line,
# not line 1 (batch 13). The imports below sit past the first line
# on purpose, and the from-import spans several lines.
import unusedmod
import json
from collections import (
    UnusedA,
    UnusedB,
    Counter,
)


def alive():
    return json.dumps({}), Counter([1, 2])

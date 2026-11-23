# Entry point: importing gate1 makes the fixture files reachable,
# so no file is flagged dead — only the planted dead locals are.
from gate1 import outer

outer()

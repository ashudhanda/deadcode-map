"""Class body under `if`: still methods / attributes of the class.

Django shape: psycopg3-only `integerfield_type_map` and
`adapt_integerfield_value` sit under `if is_psycopg3:` in the class
body of DatabaseOperations.
"""

FLAG = True


class Ops:
    if FLAG:
        data_map = {"a": 1}
        dead_cond_attr = 2

        def adapt(self, key):
            return self.data_map[key]

class NullMapping(dict):
    """Read-only mapping that raises a helpful error on any write."""

    def _fail(self, *args, **kwargs):
        raise RuntimeError("The mapping is unavailable.")

    __setitem__ = __delitem__ = clear = pop = popitem = _fail
    del _fail


class SessionInterface:
    #: A flag that indicates if the session interface is pickle based.
    #: Extensions read it to decide how to deal with the session object.
    pickle_based = False

class Mapping:
    def _fail(self):
        raise RuntimeError("unavailable")

    fallback = _fail

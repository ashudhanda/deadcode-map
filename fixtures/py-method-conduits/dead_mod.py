def used_fn():
    return 1


# _Dead is module-private and never constructed, imported, or
# referenced anywhere: its method never runs, so the helper only that
# method calls is dead too.
class _Dead:
    def do_dead_work(self):
        return _dead_helper()


def _dead_helper():
    return 2

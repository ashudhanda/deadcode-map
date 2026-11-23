class CommandGroup:
    command_class: type | None = None
    group_class: type["CommandGroup"] | None = None

    def __init__(self, name=None):
        self.name = name


class HandlerMixin:
    handles_files = True

    def load(self):
        return True


class Counter:
    limit = 10

    def check(self, value):
        return value < self.limit


class Actions:
    run = lambda: 1

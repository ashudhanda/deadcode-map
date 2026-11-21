def used_fn(n):
    return _double(n)


def _double(n):
    return n * 2


def dead_fn(n):
    return n * 99


def _private_dead(n):
    return n * 99


def format_name(name):
    return name.title()


class Greeter:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return f'Greeter({self.name})'

    def greet(self):
        return f'Hello {self.name}'

    def unused_method(self):
        return 'never called'

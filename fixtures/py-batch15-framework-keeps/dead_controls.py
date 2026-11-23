# Planted dead items (must stay SAFE). The underscore names are
# unexported, so with 0 callers and 0 references they are provably
# dead. The marker below is imported by main.py, so it is live and
# never a finding.


def _dead_private():
    return 1


def _also_dead():
    return 2


_dead_value = 1


def controls_version():
    return 1

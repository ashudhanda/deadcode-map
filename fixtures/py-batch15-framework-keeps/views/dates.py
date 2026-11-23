# Hand-written dynamic-reflection case. The methods below have no
# in-repo callers, but this file calls getattr() — both analyzers
# demote them to REVIEW ("cannot prove safe") instead of keeping
# them for sitting under views/: a route directory keeps the FILE,
# never its symbols (the CLI's keepSymbols excludes entry files).
class DateMixin:
    def _get_current_year(self):
        return 2026

    def _get_current_month(self):
        return 11


def _get_attr(obj, name):
    return getattr(obj, name)

"""Entry point: imports the classes so they are live roots."""

from alias import Parser
from base import BaseFeatures, Func
from funcs import Area, BackendFeatures, Length
from globals_mod import helper
from ops import Ops
from props import PgFeatures
from readers import check_features, check_timeout

if __name__ == "__main__":
    print(Func, BaseFeatures, Area, Length, BackendFeatures, Ops, Parser)
    print(check_features, check_timeout, helper)
    print(check_features(BackendFeatures()))
    print(PgFeatures)

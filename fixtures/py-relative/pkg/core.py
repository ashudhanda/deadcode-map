from .. import shared
from . import utils


def run():
    return utils.helper_fn() + shared.shared_fn()

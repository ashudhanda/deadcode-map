# Hand-written framework-resolved names: Django calls each of
# these, never in-repo code — AppConfig.ready() at app load,
# Model.clean() from full_clean(), Model.save() from the ORM, and
# get_absolute_url() from templates and the admin. The one method
# with no framework rule, scrub(), is the REVIEW control.


class AppConfig:
    def ready(self):
        pass

    def scrub(self):
        pass


class Model:
    def clean(self):
        pass

    def save(self):
        pass

    def get_absolute_url(self):
        return "/"


def config_version():
    return 1

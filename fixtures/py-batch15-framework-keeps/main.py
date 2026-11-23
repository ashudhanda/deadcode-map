# Entry point for the fixture: imports one marker from each
# module so every file has a live importer (otherwise each file
# would grade SAFE-dead as a file and its symbols would never be
# graded). The asserted symbols are never imported here — importing
# one would make it live and delete its finding.
from app_config import config_version
from dead_controls import controls_version
from django_tags import tags_version
from flask_views import views_version
from typer_cmds import cmds_version

if __name__ == "__main__":
    print(config_version, controls_version, tags_version, views_version, cmds_version)

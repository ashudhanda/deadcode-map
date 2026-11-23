# Hand-written Flask blueprint cases. The CLI keeps a view only
# when its decorator text matches a framework pack rule: the
# "/register" route path contains "register" (django.json) and
# @login_required is a django.json keepDecorator. A plain @bp.route
# view whose text matches no rule stays REVIEW. Only the decorator
# TEXT matters here, so the blueprint name is used bare, with no
# Flask import.

bp = Blueprint("auth", __name__)


@bp.route("/register", methods=("GET", "POST"))
def register():
    return "registered"


@bp.route("/login", methods=("GET", "POST"))
def login():
    return "logged in"


@bp.route("/logout")
def logout():
    return "logged out"


@bp.route("/create", methods=("GET", "POST"))
@login_required
def create():
    return "created"


@login_required
def dashboard():
    return "dashboard"


def views_version():
    return 1

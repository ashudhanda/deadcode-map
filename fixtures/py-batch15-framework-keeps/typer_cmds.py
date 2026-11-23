# Hand-written Typer cases: a multi-line @app.command(...) must
# keep its function exactly like the single-line form — the old web
# parser dropped the decorator at the continuation line, so the
# function graded REVIEW while the CLI kept it. Only the decorator
# matters here, so the Typer app is built from the bare name.
import typer

app = typer.Typer()


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True}
)
def main(ctx: typer.Context):
    for extra_arg in ctx.args:
        print(f"Got extra arg: {extra_arg}")


@app.command()
def create(name: str):
    print(f"creating {name}")


def helper():
    return "plain exported function, REVIEW at most"


def cmds_version():
    return 1

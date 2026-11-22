import typer

app = typer.Typer()


@app.command()
def main(name: str):
    print(f"hello {name}")


@app.callback()
def callback():
    pass


def helper():
    return "never called, but a plain exported function in a library"


if __name__ == "__main__":
    app()

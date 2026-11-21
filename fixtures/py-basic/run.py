def run():
    return 42  # trailing comment, not unreachable code


if __name__ == "__main__":
    raise SystemExit(run())

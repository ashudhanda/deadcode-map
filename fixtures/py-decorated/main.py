from app import make_client, run

if __name__ == "__main__":
    c = make_client()
    with c.session():
        pass
    print(run())

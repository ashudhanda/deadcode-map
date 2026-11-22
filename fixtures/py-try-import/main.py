"""Entry point: imports the probe functions so they are live roots."""

from probe import check_image, check_numpy, check_used

if __name__ == "__main__":
    print(check_image, check_numpy, check_used)

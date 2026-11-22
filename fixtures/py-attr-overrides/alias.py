"""A single assignment aliasing a method of the same class.

Django shape: `IE_sanitize = sanitize_file_name` in MultiPartParser.
"""


class Parser:
    def sanitize(self, name):
        return name.strip()

    clean_name = sanitize
    other = len

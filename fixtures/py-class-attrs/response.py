from basewrappers import ResponseBase


class Response(ResponseBase):
    default_mimetype: str | None = "text/html"

    def get_body(self):
        return "body"

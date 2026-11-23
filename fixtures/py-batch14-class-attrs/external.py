from elsewhere import RemoteBase


class Service(RemoteBase):
    mode = "off"

    def start(self):
        return True

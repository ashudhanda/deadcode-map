from base import Base


class Child(Base):
    timeout = 60

    def run(self):
        return True

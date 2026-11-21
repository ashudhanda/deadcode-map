from flask import Flask

app = Flask(__name__)


@app.route('/hello')
def hello():
    return 'hello'


def unused_handler():
    return 'never routed'

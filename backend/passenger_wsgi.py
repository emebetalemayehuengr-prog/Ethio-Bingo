import sys
from pathlib import Path

from a2wsgi import ASGIMiddleware


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import app as asgi_app  # noqa: E402


# cPanel Python Selector expects a WSGI callable named `application`.
application = ASGIMiddleware(asgi_app)

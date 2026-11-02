from pathlib import Path
import sys

BACKEND_PATH = str(Path(__file__).resolve().parent / "backend")
if BACKEND_PATH not in sys.path:
    sys.path.insert(0, BACKEND_PATH)

from app.main import app

__all__ = ["app"]

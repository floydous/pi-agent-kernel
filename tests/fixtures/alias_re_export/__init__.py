"""WebSocket package — re-exports the `client` class as `WebSocketClient`."""

from .websocket import client as WebSocketClient

__all__ = ["WebSocketClient"]

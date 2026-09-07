"""WebSocket client module — exported under multiple aliases."""

from __future__ import annotations
from typing import Callable, Optional


class BaseClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self._connected = False

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected


class client(BaseClient):
    """Concrete client with reconnection logic."""

    def __init__(self, url: str, max_retries: int = 3) -> None:
        super().__init__(url)
        self.max_retries = max_retries
        self._on_message: Optional[Callable[[str], None]] = None

    def on_message(self, handler: Callable[[str], None]) -> None:
        self._on_message = handler

    def send(self, payload: str) -> None:
        if not self._connected:
            raise ConnectionError("client not connected")
        if self._on_message:
            self._on_message(payload)

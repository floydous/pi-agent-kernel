"""Tests for the WebSocketClient alias."""

from webshocket import WebSocketClient


def test_connect_and_send() -> None:
    ws = WebSocketClient("wss://example.com")
    ws.connect()
    assert ws.is_connected
    received: list[str] = []
    ws.on_message(lambda msg: received.append(msg))
    ws.send("hello")
    assert received == ["hello"]


def test_send_before_connect_fails() -> None:
    ws = WebSocketClient("wss://example.com")
    try:
        ws.send("nope")
    except ConnectionError:
        return
    raise AssertionError("expected ConnectionError")

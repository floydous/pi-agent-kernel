class DataProcessor:
    """Process incoming data streams."""

    def __init__(self, threshold: int = 10):
        self.threshold = threshold
        self.buffer = []

    def add_record(self, record: str) -> None:
        if len(record) > self.threshold:
            self.buffer.append(record)

    def flush(self) -> list:
        result = list(self.buffer)
        self.buffer.clear()
        return result

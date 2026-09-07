class client(
    BaseClient,
    Generic[T],
):
    def connect(self):
        return "connected"

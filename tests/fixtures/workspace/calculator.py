class Calculator:
    def __init__(self, precision: int = 2):
        self.precision = precision

    def calculate_tax(self, subtotal: float) -> float:
        """Calculate tax based on subtotal."""
        return subtotal * 0.08

    def process_discount(self, subtotal: float, discount: float) -> float:
        return subtotal - discount

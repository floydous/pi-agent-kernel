"""Realistic calculator fixture for workspace-dependent tests.

This module mirrors a typical small-but-real Python service: a domain class
with multiple methods, decorators, error handling, and cross-class collaboration.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, List


class CalculatorError(Exception):
    """Raised when a calculation cannot be completed."""


@dataclass
class Transaction:
    subtotal: float
    discount: float = 0.0
    tax: float = 0.0
    total: float = field(init=False)

    def __post_init__(self) -> None:
        if self.subtotal < 0:
            raise CalculatorError("subtotal cannot be negative")
        if self.discount < 0:
            raise CalculatorError("discount cannot be negative")
        self.total = self.subtotal - self.discount + self.tax


class Calculator:
    """Tax and discount calculator with configurable precision."""

    DEFAULT_TAX_RATE = 0.08

    def __init__(self, precision: int = 2, tax_rate: float = DEFAULT_TAX_RATE):
        self.precision = precision
        self.tax_rate = tax_rate
        self.history: List[Transaction] = []

    def calculate_tax(self, subtotal: float) -> float:
        """Calculate tax based on subtotal."""
        if subtotal < 0:
            raise CalculatorError("subtotal cannot be negative")
        return round(subtotal * self.tax_rate, self.precision)

    def process_discount(self, subtotal: float, discount: float) -> float:
        """Subtract a discount from the subtotal, guarding against negatives."""
        if discount < 0:
            raise CalculatorError("discount cannot be negative")
        return max(0.0, round(subtotal - discount, self.precision))

    def apply_transaction(self, subtotal: float, discount: float = 0.0) -> Transaction:
        tax = self.calculate_tax(subtotal)
        txn = Transaction(subtotal=subtotal, discount=discount, tax=tax)
        self.history.append(txn)
        return txn

    def reset_history(self) -> None:
        self.history.clear()

    def find_largest(self) -> Optional[Transaction]:
        if not self.history:
            return None
        return max(self.history, key=lambda t: t.total)

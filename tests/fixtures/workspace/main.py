"""Main entry point fixture used by workspace tests."""

from calculator import Calculator


def main() -> int:
    calc = Calculator(precision=2, tax_rate=0.08)
    txn = calc.apply_transaction(subtotal=100.0, discount=5.0)
    print(f"Total: {txn.total:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from decimal import Decimal


def total(prices):
    amounts = [Decimal(str(price)) for price in prices]
    if any(amount < 0 for amount in amounts):
        raise ValueError("Prices must be nonnegative")
    return sum(amounts, Decimal("0"))

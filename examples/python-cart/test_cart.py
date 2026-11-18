import unittest
from decimal import Decimal

from cart import total


class CartTests(unittest.TestCase):
    def test_exact_total(self):
        self.assertEqual(total(["0.10", "0.20"]), Decimal("0.30"))
        self.assertEqual(total(["0.00", "1.05"]), Decimal("1.05"))
        self.assertEqual(total([]), Decimal("0"))

    def test_negative_price(self):
        with self.assertRaises(ValueError):
            total(["2.00", "-1.00"])


if __name__ == "__main__":
    unittest.main()

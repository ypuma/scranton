import unittest
from importlib import import_module

add = import_module("calculator").add

class Addition(unittest.TestCase):
    def test_add(self) -> None:
        self.assertEqual(add(2, 3), 5)

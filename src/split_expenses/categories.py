"""Spending categories, shared with the web app.

The web app's copy is web/shared/categories.json; CI checks the two match.
"""

SPENDING = [
    "groceries",
    "dining",
    "household",
    "utilities",
    "transport",
    "health",
    "subscriptions",
    "entertainment",
    "travel",
    "gift",
    "fees",
    "other",
]

# Money in: paychecks, interest earned. Returns reduce their own category instead.
INCOME = "income"

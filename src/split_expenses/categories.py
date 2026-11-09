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
    "hobbies",
    "entertainment",
    "travel",
    "gift",
    "housing",
    "other",
]

# Money in: paychecks, interest earned. Returns reduce their own category instead.
INCOME = "income"

# Categories that were retired, and where their old rows go when a file still has them.
RETIRED = {"subscriptions": "other", "fees": "other"}


def current(category):
    """The category to use for one read from a file, which may be from before a rename."""
    return RETIRED.get(category, category)

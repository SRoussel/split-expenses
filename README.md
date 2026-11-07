# Statement splitter

Two small Python scripts for splitting expenses with a partner.

- `split_statements.py` reads bank statement PDFs and asks you, one expense at a time, whether it's yours or should be split.
- `split_ledger.py` keeps a running balance of who owes who, and can take the total from the first script as a single entry.

## Setup

Run both scripts with `uv run`. There's nothing to install: `split_statements.py` lists `pdfplumber` in its header and uv grabs it the first time you run it. The ledger script only uses the standard library.

## split_statements.py

Put your statement PDFs in a folder and point the script at it:

    uv run split_statements.py path/to/statements

For each expense it shows the date, amount and vendor. Press `s` for self, `p` for split, `k` to skip it for now, or `q` to quit. If you pick split, it asks for a category: utilities, groceries, dining, entertainment, travel, gift or household.

Split expenses are saved to `split_transactions.csv` with the columns `date`, `amount`, `vendor` and `category`.

After each answer it asks if it should remember your choice for that vendor. If you say yes, the next time that vendor shows up it gets the same treatment without asking. Numbers at the end of a vendor name and things like `PMT ID: 12345` are ignored when matching, so "CON EDISON PMT ID: 111" and "CON EDISON PMT ID: 222" count as the same vendor.

It keeps track of what you've already gone through in `.split_state.json`, so you can quit partway and pick up later.

Options:

- `-o FILE` save splits somewhere other than `split_transactions.csv`
- `--dump` just print what it parsed, no questions
- `--reset` forget what you've already reviewed
- `--clear-rules` forget the remembered vendors
- `--no-color` turn off colors

Run it with `--dump` first on a new statement. Every bank formats these differently, so check that the dates and amounts look right and that deposits aren't showing up as expenses. If they do, the matching rules near the top of the script are what to change.

## split_ledger.py

The balance is always worked out from `ledger.csv`, so you can open that file and fix a mistake by hand if you need to.

Set a starting balance if there is one:

    uv run split_ledger.py init --i-owe 500
    uv run split_ledger.py init --partner-owes 600

Add an expense (amount, who paid, then a name):

    uv run split_ledger.py add 84.20 me groceries
    uv run split_ledger.py add 120 partner power bill

Expenses are split 50/50 unless you say otherwise, for example `--my-share 70` if you owe 70% of it. Run `add` with nothing after it and it will ask you for each piece.

Add the total from the statement script:

    uv run split_ledger.py import split_transactions.csv

This adds one entry named after the date range, like `Expenses 01/15/26-02/03/26`. It assumes you paid and it's split 50/50. Use `--payer partner` or `--my-share 60` to change that, and `--name` to call it something else. It won't add an entry with the same name twice unless you use `--force`.

One thing to watch: importing doesn't clear `split_transactions.csv`. If you review more statements and import again, the old transactions get counted again. Either delete the CSV after you import it, or use `-o` to start a new file next time.

Pay each other back:

    uv run split_ledger.py settle              # pays off the whole balance
    uv run split_ledger.py settle 100 me       # you paid your partner $100

Check where things stand:

    uv run split_ledger.py balance
    uv run split_ledger.py history

In `history`, a positive balance means your partner owes you and a negative one means you owe them.

Use `--ledger FILE` to keep a different ledger file, and `--no-color` to turn off colors.

## Typical flow

1. Run `split_statements.py` on a folder of statements and go through the expenses.
2. Run `split_ledger.py import split_transactions.csv`.
3. Delete `split_transactions.csv` so the next batch starts clean.
4. Run `split_ledger.py settle` whenever one of you pays the other back.

# Statement splitter

Two small Python scripts for splitting expenses with a partner, plus a web app so you can both see the ledger and add to it from your phones.

- `split_statements.py` reads bank statement PDFs and asks you, one expense at a time, whether it's yours or should be split.
- `split_ledger.py` keeps a running balance of who owes who, and can take the total from the first script as a single entry.
- `web/` is the shared version of the ledger, called Split (React, with a Cloudflare Worker and D1 database). See [web/README.md](web/README.md) for setup and deploying. The scripts and the app don't talk to each other directly: you import the statement script's CSV into the app, and the app can export a CSV in the ledger script's format.

The scripts keep your data in plain files (`ledger.csv`, `split_transactions.csv`, `.split_state.json`, and your PDFs in `statements/`). The `.gitignore` leaves those out of the repo on purpose. This repo is public, so check `git status` before every commit.

## Setup

Run both from the repo root with `uv run split-statements` and `uv run split-ledger`. There's nothing to install by hand: the first time, uv sets up the project and its one dependency, `pdfplumber`. Your files (`ledger.csv`, `split_transactions.csv`, `.split_state.json`) are read and written in the folder you run the commands from.

## split_statements.py

Put your statement PDFs in a folder and point the script at it:

    uv run split-statements path/to/statements

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

    uv run split-ledger init --i-owe 500
    uv run split-ledger init --partner-owes 600

Add an expense (amount, who paid, then a name):

    uv run split-ledger add 84.20 me groceries
    uv run split-ledger add 120 partner power bill

Expenses are split 50/50 unless you say otherwise, for example `--my-share 70` if you owe 70% of it. Run `add` with nothing after it and it will ask you for each piece.

Add the total from the statement script:

    uv run split-ledger import split_transactions.csv

This adds one entry named after the date range, like `Expenses 01/15/26-02/03/26`. It assumes you paid and it's split 50/50. Use `--payer partner` or `--my-share 60` to change that, and `--name` to call it something else. It won't add an entry with the same name twice unless you use `--force`.

One thing to watch: importing doesn't clear `split_transactions.csv`. If you review more statements and import again, the old transactions get counted again. Either delete the CSV after you import it, or use `-o` to start a new file next time.

Pay each other back:

    uv run split-ledger settle              # pays off the whole balance
    uv run split-ledger settle 100 me       # you paid your partner $100

Check where things stand:

    uv run split-ledger balance
    uv run split-ledger history

In `history`, a positive balance means your partner owes you and a negative one means you owe them.

Use `--ledger FILE` to keep a different ledger file, and `--no-color` to turn off colors.

## Typical flow

1. Run `uv run split-statements` on a folder of statements and go through the expenses.
2. Run `uv run split-ledger import split_transactions.csv`.
3. Delete `split_transactions.csv` so the next batch starts clean.
4. Run `uv run split-ledger settle` whenever one of you pays the other back.

# Statement splitter

Two small Python scripts for splitting expenses with a partner, plus a web app so you can both see the ledger and add to it from your phones.

- `split_statements.py` reads bank statement PDFs and goes through every transaction once: money out is yours, shared or excluded; money in is income, a return or excluded. Each gets a category.
- `split_ledger.py` keeps a running balance of who owes who, and can take the total from the first script as a single entry.
- `web/` is the shared version of the ledger, called Split (React, with a Cloudflare Worker and D1 database). See [web/README.md](web/README.md) for setup and deploying. The scripts and the app don't talk to each other directly: you import the statement script's CSV into the app, and the app can export a CSV in the ledger script's format.

The scripts keep your data in plain files (`ledger.csv`, `split_transactions.csv`, `personal_transactions.csv`, `split_summary.json`, `.split_state.json`, `data/` for `--person`, and your PDFs in `statements/`). The `.gitignore` leaves those out of the repo on purpose. This repo is public, so check `git status` before every commit.

## Setup

Run both from the repo root with `uv run split-statements` and `uv run split-ledger`. There's nothing to install by hand: the first time, uv sets up the project and its one dependency, `pdfplumber`. Your files are read and written in the folder you run the commands from.

**Both of you on one computer:** add `--person sam` (any short name) to `split-statements` and `split-ledger summarize`. That person's review progress, remembered vendors, transaction files and summary then live in `data/sam/`, so the two of you never mix. Without `--person`, the files are in the repo root as before.

To run the tests: `uv run python -m unittest discover -s tests -v`.

## split_statements.py

Put your statement PDFs in a folder and point the script at it:

    uv run split-statements path/to/statements

For each transaction it shows the date, whether it's money **OUT** or **IN**, the amount and the vendor.

- **Money out:** `s` self (your own spending), `p` split (shared with your partner), `x` exclude.
- **Money in:** `i` income (paychecks, interest earned), `r` return (it asks the category of the original purchase and whether it was shared; a return *reduces* that category), `x` exclude.
- **Always:** `k` skip for now, `q` quit.
- **Exclude** is for money that's neither spending nor income: credit-card payments, transfers between your own accounts, and money between the two of you (paying each other back is already tracked by the ledger). Counting these would double-count.
- **`?` (unclear):** a line that wasn't under a heading saying whether it's money out or in, and had no minus sign. It asks: `o` out, `n` in or `x` exclude. Nothing is guessed or dropped.

Self and split ask for a category: groceries, dining, household, utilities, transport, health, subscriptions, entertainment, travel, gift, fees or other. (The list is shared with the web app, in `web/shared/categories.json`.)

Shared transactions are saved to `split_transactions.csv` and your own (including income, and returns as negative amounts) to `personal_transactions.csv`. Both have the columns `date`, `amount`, `vendor` and `category`, and neither ever leaves your computer.

After each answer it asks if it should remember your choice for that vendor (separately for money out and money in). If you say yes, the next time that vendor shows up it gets the same treatment without asking. Numbers at the end of a vendor name and things like `PMT ID: 12345` are ignored when matching, so "CON EDISON PMT ID: 111" and "CON EDISON PMT ID: 222" count as the same vendor.

It keeps track of what you've already gone through in `.split_state.json`, so you can quit partway and pick up later.

Options:

- `--person NAME` keep this person's files in `data/NAME/`
- `-o FILE` save splits somewhere other than `split_transactions.csv`
- `--personal-output FILE` save your own transactions somewhere other than `personal_transactions.csv`
- `--dump` just print what it parsed, no questions
- `--reset` forget what you've already reviewed
- `--clear-rules` forget the remembered vendors
- `--no-color` turn off colors

Run it with `--dump` first on a new statement. Every bank formats these differently, so check that the dates, amounts and directions (out, in, unknown) look right. It also prints how many lines it found of each kind per file; lots of "unclear" means the bank's section headings aren't recognised, and the matching rules near the top of the script are what to change. Remembered vendors from older versions that only say "self" ask for a category once.

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

For the web app, make a summary instead of importing:

    uv run split-ledger summarize                 # your files
    uv run split-ledger summarize --person sam    # Sam's files, in data/sam/

It writes `split_summary.json` with only totals per month and category: one block for the shared transactions, one for your own spending and income (`--no-personal` leaves that out; `-o FILE` writes it elsewhere). No merchants, purchase dates or individual amounts. That small file is the only thing the app's import accepts, so your individual transactions never leave your computer. Open it to see exactly what the app will get.

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
2. Run `uv run split-ledger summarize` and import the `split_summary.json` in the web app, choosing whose statement it is (or, for the Python ledger, `uv run split-ledger import split_transactions.csv`).
3. Delete `split_transactions.csv`, `personal_transactions.csv` and `split_summary.json` (or the ones in `data/<person>/`) so the next batch starts clean.
4. Run `uv run split-ledger settle` whenever one of you pays the other back.

# Split

My partner and I share a lot of expenses, and I wanted an easy way to keep track of who owes who without handing our bank statements to a budgeting app. This is what I ended up with.

It has two parts:

- **Python scripts** that run on my computer. One reads bank statement PDFs and walks me through every transaction so I can mark it as mine, shared, or neither, with a category. The other keeps a running ledger and makes a small summary file for the app. See [src/split_expenses/README.md](src/split_expenses/README.md).
- **A web app** we both use from our phones. It shows the balance, lets either of us add an expense or settle up, and has spending and cash flow reports by month and category. It runs on Cloudflare (a Worker plus a D1 database). See [web/README.md](web/README.md).

It's built for exactly two people. The app won't let a third person join.

## How the pieces fit

```
bank statement PDFs
        │
        ▼
uv run split-statements      go through each transaction: mine, shared or skip
        │
        ▼
transaction CSVs             stay on my computer
        │
        ▼
uv run split-ledger finish   totals per month and category, then archives the batch
        │
        ▼
split_summary.json           the only thing that goes to the app
        │
        ▼
the web app                  import it from my phone
```

The scripts and the app never talk to each other directly. The summary file is just totals per month and category: no merchant names, no individual purchases. Open it before you import it if you want to see exactly what goes up.

Going the other way, the app can export the ledger as a CSV in the format `split-ledger` reads.

## Getting started

For the scripts you need [uv](https://docs.astral.sh/uv/). From the repo root:

    uv run split-statements path/to/statements

uv sets everything up the first time.

For the app you need Node 22:

    cd web
    npm install
    npm run db:migrate:local
    npm run dev

That runs it locally at http://localhost:5173. Deploying to Cloudflare is a handful of steps, all in [web/README.md](web/README.md).

## A typical month

1. Download the month's statements into `statements/`.
2. Run `uv run split-statements statements` and go through what's new. It remembers merchants, so after the first month it's mostly pressing Enter.
3. Run `uv run split-ledger finish` (add `--person sam` if you're doing Sam's statements on the same computer). It writes the summary, moves the batch into `archive/`, and prints the path of the file to import.
4. Get that file to your phone (AirDrop works) and import it in the app under **More > Import statement summary**, saying whose statement it is.
5. Add anything else by hand in the app as it happens, and settle up whenever.

## Privacy

This repo is public, so everything personal is git-ignored: the PDFs, transaction CSVs, the ledger, summaries, `data/` and `archive/`. Still, check `git status` before you commit.

CI only runs the tests. It never deploys and doesn't use any secrets; deploying is a manual step from my computer.

## Tests

    uv run python -m unittest discover -s tests -v    # the scripts
    cd web && npm test                                 # the app's ledger and spending math
    cd web && npm run test:api                         # the backend, against a throwaway database

## Layout

    src/split_expenses/   the Python scripts (and their README)
    tests/                tests for the scripts
    web/                  the web app (and its README)
    web/shared/           code the app and the Worker share, and the category list (the scripts keep a copy; a test checks they match)
    statements/           your PDFs (git-ignored)

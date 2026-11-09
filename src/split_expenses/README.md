# Python scripts

These run on your computer and never send anything anywhere. There are three:

- `split-statements` reads bank statement PDFs and goes through every transaction once: money out is yours, shared or excluded; money in is income, a return or excluded. Each gets a category.
- `split-ledger` keeps a running balance of who owes who, and writes the totals-only summary that the web app imports.
- `split-insights` opens a page in your browser with every transaction you've gone through, for digging into where the money goes.

Run both from the repo root, not from this folder. For how they fit with the web app, see the [main README](../../README.md).

The scripts keep your data in plain files (`ledger.csv`, `split_transactions.csv`, `personal_transactions.csv`, `split_summary.json`, `.split_state.json`, `data/` for `--person`, and your PDFs in `statements/`). The `.gitignore` leaves those out of the repo on purpose. This repo is public, so check `git status` before every commit.

## Setup

Run both from the repo root with `uv run split-statements` and `uv run split-ledger`. There's nothing to install by hand: the first time, uv sets up the project and its one dependency, `pdfplumber`. Your files are read and written in the folder you run the commands from.

**Both of you on one computer:** add `--person sam` (any short name) to `split-statements` and `split-ledger summarize` / `finish`. That person's review progress, remembered vendors, transaction files and summary then live in `data/sam/`, so the two of you never mix. Without `--person`, the files are in the repo root as before.

To run the tests: `uv run python -m unittest discover -s tests -v`.

## split_statements.py

Put your statement PDFs in a folder and point the script at it:

    uv run split-statements path/to/statements

It groups what's left to review **by merchant**, so "STARBUCKS ×12 · $54.20" is one question covering all twelve. Each question is a single keypress, no Enter:

- **Money out:** `s` self (your own spending), `p` split (shared with your partner), `x` exclude.
- **Money in:** `i` income (paychecks, interest earned), `r` return (asks the category of the original purchase and whether it was shared; a return *reduces* that category), `x` exclude.
- **Categories** are one key each: `1`–`9`, then `a` gift, `b` housing, `c` other (the menu shows them). `Esc` goes back.
- **Enter** accepts the suggestion, when there is one. Suggestions come from your own answers for similar merchant names first, then a built-in keyword list (Safeway → groceries, Uber → transport, payroll → income, Zelle → exclude…). They're worked out on your computer and never applied without a keypress.
- **Answers are remembered** for that merchant (separately for money out and in), so next time it's applied without asking. Hold **Shift** (`S`, `P`, `X`…) for "this time only".
- **A merchant with several transactions is listed, numbered**, even when its answer is remembered: Enter accepts the remembered answer for all of them. `c` changes some lines first (type `2`, `2,5` or `3-6`, then the answer), for a one-off like a TV at Costco. Those lines are answered this time only; the merchant keeps its usual answer. Amounts much bigger than the merchant's usual are marked.
- `e` answers a group's transactions one by one (when a merchant isn't always the same thing; those answers aren't remembered).
- `u` undoes your last answer: its lines, its remembered rule, and anything applied automatically after it. It then asks again. Undo works within one session.
- `k` skips for now, `q` quits (progress is saved as you go).
- **Exclude** is for money that's neither spending nor income: credit-card payments, transfers between your own accounts, and money between the two of you (paying each other back is already tracked by the ledger). Counting these would double-count.
- **`?` (unclear)** lines weren't under a heading saying whether they're money out or in, and had no minus sign. It asks: `o` out, `n` in or `x` exclude. Nothing is guessed or dropped.

The categories are groceries, dining, household, utilities, transport, health, hobbies, entertainment, travel, gift, housing and other. (The list is shared with the web app, in `web/shared/categories.json`.) Subscriptions and fees used to be categories; files that still have them count those rows as other.

Shared transactions are saved to `split_transactions.csv` and your own (including income, and returns as negative amounts) to `personal_transactions.csv`. Both have the columns `date`, `amount`, `vendor`, `category` and `id` (which transaction it was), and neither ever leaves your computer.

**Running it again is safe.** Each row records which transaction it came from, so answering a transaction again (after `--reset`, or with a different answer) *replaces* its row instead of adding a second one, and excluding it removes the row. If a transaction looks new but one with the same date, amount and merchant is already recorded (a renamed PDF, the same statement downloaded twice, or a fix to how statements are read), it asks before adding it: `s` skips it, `a` adds it anyway for a genuine second purchase. The progress file is saved in one step, so a crash can't damage it; if it ever can't be read, the script stops and says so instead of quietly starting over.

Remembered merchants are matched loosely: numbers at the end of a vendor name and things like `PMT ID: 12345` are ignored when matching, so "CON EDISON PMT ID: 111" and "CON EDISON PMT ID: 222" count as the same vendor.

It keeps track of what you've already gone through in `.split_state.json`, so you can quit partway and pick up later.

Options:

- `--person NAME` keep this person's files in `data/NAME/`
- `-o FILE` save splits somewhere other than `split_transactions.csv`
- `--personal-output FILE` save your own transactions somewhere other than `personal_transactions.csv`
- `--dump` just print what it parsed, no questions
- `--reset` go through everything again (remembered merchants are kept, and new answers replace the old rows)
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

Or do both steps at once, summarize and then archive:

    uv run split-ledger finish --person sam

It writes the summary, moves the batch into `archive/<date>/` (see "A typical month" in the [main README](../../README.md#a-typical-month)) and prints the path of the summary to import, like `archive/sam/2026-11-08/split_summary.json`. If there's nothing to summarize, nothing is moved. It takes `--no-personal` and `--name` like `summarize`; the personal transactions are archived either way. It stops if a `split_summary.json` from an earlier `summarize` is still there, since that one may already be imported.

One thing to watch: importing doesn't clear `split_transactions.csv`. If you review more statements and import again, the old transactions get counted again. Either delete the CSV after you import it, or use `-o` to start a new file next time.

Pay each other back:

    uv run split-ledger settle              # pays off the whole balance
    uv run split-ledger settle 100 me       # you paid your partner $100

Check where things stand:

    uv run split-ledger balance
    uv run split-ledger history

In `history`, a positive balance means your partner owes you and a negative one means you owe them.

Use `--ledger FILE` to keep a different ledger file, and `--no-color` to turn off colors.

## split-insights

The phone app only ever sees monthly totals. This is the other side: every transaction on this computer, in one page, for the kind of digging you'd do at a desk. Build the page once, then start it:

    cd web && npm install && npm run build:desktop && cd ..
    uv run split-insights

It reads every `split_transactions.csv` and `personal_transactions.csv` it can find: the current batch, `data/<person>/`, and everything in `archive/`. When the same statement shows up in more than one batch (an archived copy and a second pass, say), the newest file wins, so nothing is counted twice. The terminal prints what came from where.

The page runs on `127.0.0.1` and only answers to that address, so other machines and other websites can't read it. Reload it after going through new statements. Merchant names are cleaned up from what the bank sends (`TST* CAFE BLUEBELL 207-555-0100 ME 6462 1111` becomes Cafe Bluebell); hover a name in the transactions list to see the original.

Click a month, a category or a merchant to filter everything else by it. `/` jumps to search, and Esc clears.

Besides that overview there are two more views in the sidebar. **What changed** compares a month with the six before it: which categories and merchants went up or down, places you went for the first time, and regulars you skipped. **Recurring charges** finds subscriptions, memberships and bills from merchants that charge on a steady schedule, with what each costs a year, when the next one is due, and any price change. Bills that vary (electricity) count when they're filed as utilities or housing. Click anything in either view to see those transactions in the overview.

When the same place shows up under different names, pick one in Merchants and rename it. Typing another merchant's name merges the two, and it suggests names that look alike.

You can also refile transactions there: change the category or shared/personal right in the list, or tick several (shift-click for a range) and change them together. Each change can be undone, and "edited" on a row shows what the statement had and puts it back. When everything you changed is one merchant, it offers to file that merchant the same way in future statements, which saves the same rule `split-statements` would.

**Sending it to the phone app.** "Export for phone app" makes the same `split_summary.json` that `split-ledger finish` does, for one person and the dates you pick, with your refilings and renames applied. Import it on the phone under More > Import statement summary. It starts from the day after the last summary it knows about (the ones `finish` archived, and earlier exports), and warns when the dates overlap one, since importing the same days twice counts them twice. To fix something already in the app, delete that upload there and import the new file.

The page keeps its own files in `desktop-data/` (git-ignored): your renames and refilings. They change what this page shows and what it exports. The transaction CSVs and the ledger stay as they were; the only thing it writes outside its folder is a vendor rule, when you say yes to one. `desktop-data/exports.json` remembers what you exported.

To work on the page itself, run `uv run split-insights --no-open` and `npm run dev:desktop` in `web/` together, and open http://localhost:5174.

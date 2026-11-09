# Ledger web app

A small app for the two of you to see the ledger, add expenses and settle up from your phones. It's a React site plus one Cloudflare Worker that serves the site and a small JSON API, with the data in Cloudflare D1 (SQLite). Everything runs on your computer with no account and no deploy.

It does the same math as the Python ledger (`uv run split-ledger`), and the ledger can be exported as a CSV in that script's format.

The screen refreshes every 15 seconds while it's open, and whenever you switch back to it, so a change one of you makes shows up for the other within seconds.

## 1. Run it locally

You need **Node 20 or newer** (Node 22 is best; Wrangler refuses to run on 18).

    cd web
    npm install
    npm run db:migrate:local     # creates the local database, once
    npm run dev

Open http://localhost:5173. `npm run dev` starts the Worker with a local D1 database (stored in `.wrangler/`, which is git-ignored) and the Vite dev server together. To wipe the local data, delete `.wrangler/` and run the migrate command again.

To try the app exactly as it will be deployed (one server on port 8787):

    npm start

To check the ledger math on its own:

    npm test

To test the whole backend (sign-up and sign-in, the security guards, throttling, sessions, and the ledger rules):

    npm run test:api

It builds the app, starts the Worker against a brand-new throwaway database, runs about 15 checks over HTTP, then deletes everything. Your local and deployed data aren't touched. Run it after any change to `worker/`, `shared/` or `migrations/`, before you deploy.

To check for common mistakes (unused code, misused React hooks and so on):

    npm run lint


## 2. Deploy to Cloudflare

You need a free Cloudflare account and Node 20 or newer. Run everything from the `web/` folder. Deploy from your computer with the commands below; don't connect the git repo in the Cloudflare dashboard (see "Things to avoid").

**Step 1: log in to Cloudflare.**

    npx wrangler login

It opens a browser to approve access. In WSL, if no browser opens, copy the URL it prints into your Windows browser; the approval comes back to `localhost:8976`, which WSL forwards.

**Step 2: create the database.**

    npx wrangler d1 create ledger

It prints a block with a `database_id`. Copy **only the ID** into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. Don't paste the whole block it prints, and don't let it edit the file for you: its version names the binding `ledger`, but the code needs `"binding": "DB"`, and every sign-up and sign-in fails with a server error without it. The ID isn't a secret; it's useless without your Cloudflare login. (Local development stores its data by this ID, so your local database will start out empty after you change it. Run `npm run db:migrate:local` again.)

**Step 3: create the tables in the real database.**

    npm run db:migrate:remote

**Step 4: deploy.**

    npm run deploy

This builds the app, type-checks it and uploads it. The first time, Cloudflare may ask you to pick a `workers.dev` subdomain for your account. When it finishes it prints your URL, like `https://ledger.<your-subdomain>.workers.dev`.

**Step 5: create both accounts right away** (section 3), so nobody else can take a slot. Then check that the only accounts are yours:

    npx wrangler d1 execute ledger --remote --command "SELECT email, created_at FROM users"

If there's an email you don't recognize, someone signed up before you both did, and since sign-up stops at two accounts, one of you can't register. Remove the stranger's account, along with their sessions, household and any entries they made (put their email in all three places):

    npx wrangler d1 execute ledger --remote --command "DELETE FROM entries WHERE household_id IN (SELECT household_id FROM members WHERE user_id = (SELECT id FROM users WHERE email = 'stranger@example.com')); DELETE FROM households WHERE id IN (SELECT household_id FROM members WHERE user_id = (SELECT id FROM users WHERE email = 'stranger@example.com')); DELETE FROM users WHERE email = 'stranger@example.com';"

Then create the missing account right away and run the check again. A plain `DELETE FROM users` fails if they created anything, which is why the command has three parts.

**Step 6: check that sign-in fits in the Free plan.** In one terminal run `npx wrangler tail`, then sign in on your phone. If the tail shows "exceeded resource limits" (error 1102), lower `PBKDF2_ITERATIONS` to `15000` and run `npm run deploy` again.

To update the app later, run `npm run deploy` again. **If the update adds a file in `migrations/`, run `npm run db:migrate:remote` first**, or the new version will fail until you do. Running it when there's nothing new is harmless ("No migrations to apply"), so when in doubt, run both:

    npm run db:migrate:remote && npm run deploy

Every push to GitHub also runs the tests automatically (`.github/workflows/ci.yml`, in the repo's Actions tab). That never deploys anything.

**Sign-in and the Free plan.** Passwords are hashed with PBKDF2, which is deliberately slow. The Workers Free plan allows 10 ms of CPU per request, so `PBKDF2_ITERATIONS` in `wrangler.jsonc` is set to 20,000: about 4.6 ms per hash in local testing, and changing a password (two hashes) still fits. That's lower than the 100,000+ usually recommended, which matters only if the database itself ever leaked, so use strong passwords. If you move to Workers Paid ($5/month), raise it to `100000`; each stored password is upgraded the next time that person signs in.

There are no secrets to set. Passwords are hashed in the Worker and never stored in plain text, and the session cookie is HttpOnly.

### Backups

Cloudflare keeps a short point-in-time history of D1 databases ("Time Travel"), so you can roll back a mistake from the last several days. For your own copy:

    npx wrangler d1 export ledger --remote --output backups/ledger.sql

The `backups/` folder is git-ignored. The file contains your full ledger and the password hashes, so keep it private.

### Things to avoid

- **Don't connect the GitHub repo to Cloudflare's dashboard builds.** By default they also build every other branch you push and serve it at a public preview URL that uses the *real* database. Deploying from your computer avoids that, and `preview_urls` is turned off in `wrangler.jsonc`.
- **Don't commit your data.** The repo on GitHub is public. `ledger.csv`, `split_transactions.csv`, `split_summary.json`, `.split_state.json`, `statements/`, PDFs and `backups/` are git-ignored; keep it that way, and check `git status` before committing.
- **Never put a Cloudflare API token** or anything secret in `wrangler.jsonc`, `.env` files that aren't ignored, or the code. The app doesn't need any.

### How sign-in is protected

- **Sign-up closes** once `MAX_USERS` accounts exist (2 by default, in `wrangler.jsonc`). Deploy and create both accounts right away, so nobody else can take a slot. Locally, if you want more test accounts, put `MAX_USERS="10"` in a `.dev.vars` file (git-ignored).
- **Guessing is throttled:** 10 wrong passwords per email or 30 per network address every 15 minutes, 10 wrong invite codes per account, and 10 sign-ups per hour per address. The flip side is that someone who knows your email can lock you out for 15 minutes.
- **Sessions last 60 days and renew** whenever you open the app, so regular use never signs you out. Changing your password (**More > Change password**) signs out every other device.
- **Cross-site requests are refused,** and the pages are served with a strict Content-Security-Policy and can't be framed by other sites.

### Forgot a password?

There's no email, so reset it from your computer:

    npm run reset-password -- someone@example.com            # local database
    npm run reset-password -- someone@example.com --remote   # the deployed one

It asks for the new password and signs that person out everywhere. If that person had turned off password sign-in (say they lost every passkey), this turns it back on.

### Passkeys

You can sign in with Face ID or Touch ID instead of a password. Set it up in **More > Passkeys and sign-in > Add a passkey**, or tap **Add a passkey** in the offer that appears once after a password sign-in. On iPhone the passkey syncs to your other Apple devices through iCloud Keychain, and a computer without one can sign in by scanning a QR code with your phone.

How it stays safe: your device keeps a private key and the app's database only stores the matching public key, which can check a sign-in but never make one. Each sign-in signs a fresh one-time challenge that expires in 5 minutes, together with the site's address, so a captured sign-in can't be replayed and a look-alike site gets nothing it can use. The server also requires Face ID or Touch ID to have happened.

- **Turn off password sign-in** (same screen) once your passkey works. Your password then stops working and its stored hash is replaced with random bytes, so there's nothing left to guess, phish or crack. You can only do this with a passkey set up, and you can't remove your last passkey while it's off.
- **Changes to how you sign in need a fresh confirmation**: adding or removing a passkey and turning password sign-in off or on. Signing in counts; otherwise the app asks you to confirm with your passkey or password. That way someone who gets hold of your session can't quietly add their own passkey.
- **Passkeys belong to the address the app runs on** (your `workers.dev` one). If you ever move the app to another domain, existing passkeys won't work there: sign in with your password and add new ones. If password sign-in is off at that point, use `npm run reset-password` first.
- If you lose every passkey with password sign-in off, `npm run reset-password` (above) gets you back in.

Splitting rule: the person who didn't pay owes their share rounded half up to the cent, and the payer keeps the remainder. On an odd half-cent, the payer gets the one-cent discount. The Python ledger (`uv run split-ledger`) uses the same rule, so the two always agree to the cent. The rule lives in `shared/owed.ts` for the app and the Worker.

## 3. Set up the two accounts

Do this right after the first deploy.

1. One of you opens the app, creates an account, enters a name and taps **Start ledger**.
2. The app shows an invite code. Send it to your partner.
3. Your partner creates an account, enters their name, and joins with the code.
4. If someone already owes the other, open **More > Set starting balance**.

A household holds two people, and you can't add a third.

## 4. Put it on your iPhones

Open the site in Safari, tap the share button, then **Add to Home Screen**. It opens full screen like a regular app. Do it from Safari itself, not from inside another app's browser.

Sign in with email and password the first time, then add a passkey when the app offers (see "Passkeys" above) and use **Sign in with passkey** from then on. There are no emailed sign-in links on purpose: on iPhone, a link in Mail opens Safari instead of the home screen app, and the two don't share a login. Passkeys don't have that problem, since they never leave the app.

## Using it

- **Add expense**: amount, name, who paid, and your share. Under the name you get names you've used before; tap one and it also fills in the category you gave it last time (until you pick a category yourself). Your share is a row of quick picks starting at your default split (see below): "Split evenly", "All theirs", "All mine", or "Custom…" for any percentage.
- **Reading the list**: each row says who paid and who owes whom, like "You paid $184.32 · Sam owes you", and the amount on the right is what that entry adds to the balance (green: owed to you, red: you owe). Payments between you are greyed out with a PAID stamp, and each month ends with a subtotal: how much that month moved the balance.
- **Search and filters**, under the balance: type part of a name, a category or an exact amount (`84.20`). **Filters** narrows by type (expenses or payments), who paid, category and a date range. The line under them counts what matches, with what was spent and your share of it (expenses only, not voided ones), and **Clear** resets everything. Imported statements are split across categories, so the category filter doesn't find them; the Spending tab does.
- **Tap any entry** to see the details: who paid, the split, who added it and when. Entries your partner added say "added by …" in the list.
- **Edit**: from an entry's details. The original isn't overwritten. It's kept in the history, marked "edited", and the corrected copy takes its place. The type (expense, payment, starting balance) can't change in an edit.
- **Settle up**: records a payment between you. It defaults to the full balance, paid by whoever owes. It only updates the ledger and doesn't move any money.
- **More > Recurring expenses**: rent, subscriptions and other bills with a fixed amount. Set the amount, who pays, the split, how often (weekly, monthly or yearly) and the first date (today or later). Each one is added to the ledger by itself, marked ↻, the first time either of you opens the app on or after its date. If nobody opens the app for a while, the missed ones are all added next time. A rule on the 29th–31st uses the last day of shorter months. Edit a rule to change the amount, payer or split (from the next one on), or to pause it. Resuming doesn't fill in the paused months. Stopping a rule keeps the entries it already added, and a voided or edited one never comes back. Bills paid by card also show up on your statements, so mark those vendors as "self" in `split-statements` to avoid counting them twice.
- **More > Default split**: the share each of you normally pays, like 60/40. It's one setting for both of you and can be set once you've both joined.
- **More > Import statement summary**: adds a statement to the app as totals only. On your computer, run `uv run split-ledger finish` (add `--person sam` for Sam's files). It writes `split_summary.json` with totals per month and category: the shared transactions, plus that person's own spending and income. Open it to see exactly what the app will get. It then archives the batch and prints where the file is. Get that small file to your phone (AirDrop, iCloud Drive), choose it in the app, and say **whose statement it is** (it also sets who paid the shared part). You can leave either part out. The shared part becomes one ledger entry, like `Expenses 01/15/26-02/03/26`, with its category breakdown. The personal part is saved as that person's monthly spending and income by category, visible to both of you. Everything is saved together or not at all, and the same statement can't be uploaded twice for the same person. The detailed transaction files never leave your computer: the app refuses them if you pick one by mistake. Older summary files (shared total only) still work.
- **Categories**: expenses you add by hand and recurring expenses can have an optional category, for the spending reports.
- **Spending tab** (Ledger · Spending · Trends at the top): spending and cash flow by month, built only from totals.
  - Switch between **You**, **Sam**, **Shared** and **Both**. "You" is your own uploaded spending plus *your share* of shared expenses (so a $100 shared grocery run at 50/50 counts as $50). "Shared" is shared expenses at their full amount. "Both" is everything, and always equals You + Sam.
  - **Net cash flow** is money in (income from your uploads) minus spending, with how much of your income you kept.
  - A **coverage strip** shows which days of the month your uploads cover. A month that's only partly uploaded says so and hides comparisons, and a month with nothing uploaded for someone is marked incomplete rather than shown as overspending.
  - **By category** lists the month's categories, with the change against the average of earlier months that have data. Tap one for its 12-month trend and what's in it: shared expenses by name, statement uploads as a monthly total only. **Move money to another category** fixes a month after the fact, e.g. $700 of a Costco run from groceries to household. It changes one upload or one imported shared statement, so totals and the balance stay the same; for a shared one the amount is the full shared amount and it changes for both of you. Undo right after, or move it back later. (Hand-added expenses: edit their category instead.)
  - **Last 6 months** charts net cash flow (or shared spending); tap a month to jump to it. "Show numbers" under each chart has the same numbers as a table.
  - **Statement uploads** lists every upload, and you can delete a wrong one. A shared entry added by the same import stays in the ledger; void it there.
  - Payments between you, starting balances and voided entries never count as spending. Shared expenses added without a category show as "No category".
  - **Trends** (its own tab at the top): the last 6 months (6M), the last year (1Y), or this year so far (YTD), for You, Sam, Shared or Both. The range sits on the same row as whose spending.
    - The total for the period: money in, spent and net (or shared spending).
    - Net cash flow by month.
    - **By category:** a list, largest first, with each category's total, its share of all spending, its average per month and a small month-by-month bar strip. The strips show shape only (each has its own scale); compare sizes by the numbers. Tap a category for a full chart of its months with the average marked. "Show numbers" has the full month-by-category table.
    - Months that are only partly uploaded are drawn lighter, marked `*`, and left out of the per-month averages.
    - **Export totals as CSV:** one row per month with money in, spent, net and each category, plus whether the month was partial. Totals only, saved to your device.
- **Void**: entries are never deleted. Voiding one keeps it in the history but stops it counting. Tap **Undo** on the message that appears, or later turn on "Show voided and edited entries" in **More**, open the entry and tap **Restore entry**. Edited originals can't be restored, since their replacement already exists.
- **More > Reset**: two permanent deletes, available to either of you.
  - **Delete voided and edited history** removes voided entries and the old versions of edited entries. Active entries and the balance don't change, but those entries can no longer be restored.
  - **Delete everything…** removes every entry and recurring expense. You have to type DELETE, and it offers to export a CSV first. Your accounts, the household, the invite code and the default split stay.
  - Neither can be undone in the app. If you need to, Cloudflare can roll the whole database back to an earlier moment (D1 "Time Travel"; wrangler's help says within the last 30 days, which may be shorter on the free plan). This also undoes anything added since:

        npx wrangler d1 time-travel restore ledger --timestamp=2026-11-07T18:00:00Z
- **More > Export ledger as CSV**: same columns as `ledger.csv` from `split_ledger.py` (`date,type,payer,amount,my_share,name`), written from your point of view, in the format `uv run split-ledger` reads.

## Changing the icon

The icon files live in `public/`: `apple-touch-icon.png` (180×180, iPhone), `icon-192.png` and `icon-512.png` (Android), and `icon.svg` (browser tab). They must be opaque PNGs, with no transparency. Safari ignores the manifest for the home-screen icon. It uses the `apple-touch-icon` links in `index.html`.

Because some iOS versions show a letter tile instead of fetching the icon, the 180×180 iPhone icon is also embedded directly in `index.html` as a `data:` URI. After replacing `public/apple-touch-icon.png`, regenerate that line:

    python3 - <<'PY'
    import base64, re
    uri = "data:image/png;base64," + base64.b64encode(open("public/apple-touch-icon.png", "rb").read()).decode()
    s = open("index.html").read()
    s = re.sub(r'(rel="apple-touch-icon" sizes="180x180" href=")[^"]*', lambda m: m.group(1) + uri, s)
    open("index.html", "w").write(s)
    PY

Also bump the `?v=` numbers on the other icon links, deploy, and remove and re-add the app on each phone. iOS keeps the icon it saw when the app was added.

## Layout

    migrations/           D1 (SQLite) tables, applied in order
    shared/owed.ts        the splitting rule, used by both the app and the Worker
    public/_headers       security headers for the pages
    scripts/              reset-password helper
    tests/api.test.mjs    end-to-end backend tests (npm run test:api)
    tests/fake-passkey.mjs  a software passkey for those tests
    worker/index.ts       the backend's front door: routes each /api/* request
    worker/http.ts        shared plumbing: JSON in and out, input checks, errors
    worker/auth.ts        accounts, passwords, sessions, sign-in throttling
    worker/passkeys.ts    passkeys, "confirm it's you", turning password sign-in off and on
    worker/household.ts   create and join, load everything, default split, reset
    worker/entries.ts     add, edit, void and restore entries
    worker/recurring.ts   recurring expenses
    worker/spending.ts    statement imports and spending totals
    eslint.config.js      lint rules (npm run lint)
    src/ledger.ts         money parsing, balance math, CSV import and export
    src/ledger.test.ts    tests for the above
    src/spending.ts       spending and cash-flow math for the Spending tab (+ spending.test.ts)
    src/charts.tsx        the small charts (no chart library)
    src/Trends.tsx        the Trends view (reports over several months, CSV export)
    src/api.ts            all the calls to the Worker
    src/LedgerScreen.tsx  the main screen, including the refresh timer
    src/forms.tsx         add expense, settle up, starting balance
    src/LedgerFilters.tsx search and filters above the ledger
    src/SignInSettings.tsx More > Passkeys and sign-in
    src/App.tsx           sign-in check and which screen to show
    src/AuthScreen.tsx    sign in and create account
    src/Onboarding.tsx    create or join a household
    src/ImportSummary.tsx the statement summary import
    src/SpendingScreen.tsx the Spending tab
    src/files.ts          saving files (CSV exports) to the device
    src/ui.tsx            shared UI pieces
    wrangler.jsonc        Cloudflare config

## Not done yet

Ideas, roughly in the order I'd do them. These will move to GitHub issues.

- Backups: a scheduled job that dumps the database somewhere I control, since D1's own restore window is 30 days at most.
- Recurring expenses on a schedule (a Cron Trigger) instead of when someone opens the app.
- Push notifications when the other person adds something. They work on iPhone for apps added to the home screen, but need a service worker and a small push sender in the Worker.
- Import bank CSV/OFX exports instead of PDFs. More reliable than reading PDF text.
- Tap a category on Spending to see its entries in the Ledger.
- Keep search filters when the app reloads.
- Settle up through Venmo or PayPal with the amount filled in.
- A note under the balance like "last settled 47 days ago".
- Notes on entries.
- A reminder when it's been a while since the last statement upload.
- Budgets per category.
- Shared savings goals, like a vacation fund.
- Splitting one receipt by item, part shared and part personal.
- A year in review page.
- Offline use. It needs a connection.
- Desktop page: a year in review, now that it has every transaction to work with.
- Desktop app: a Windows build, for when the files don't live in WSL.

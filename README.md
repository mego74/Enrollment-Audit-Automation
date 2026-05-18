# Slate + Google Sheets Enrollment Audit Automation

This project automates an enrollment-audit workflow between Google Sheets and Slate.

For each student row, the automation:

1. reads the student `N Number` from a chosen spreadsheet column
2. opens the matching applicant record in Slate
3. checks whether all `Final Official Transcript (...)` rows are satisfied
4. checks whether `Proof of Degree` is satisfied
5. writes the correct `App Status` back into the spreadsheet

## Status outcomes

The automation maps each applicant into one of these four outcomes:

- `Missing Required Docs - Needs to Stay on List`
- `FOT and POD are satisfied - Enrollment Audit Complete`
- `FOT is satisfied | POD is unsatisfied - Needs to Stay on List`
- `POD satisfied | FOT unsatisfied - Needs to Stay on List`

## Project structure

- `src/audit.mjs`: core Playwright automation
- `src/ui-server.mjs`: local web server for the dashboard
- `src/ui/`: dashboard UI
- `reports/`: JSON audit reports and debug artifacts
- `.browser-profile/`: reusable local browser session for Google Sheets and Slate

## Requirements

- Node.js 18+
- Brave or Google Chrome installed locally
- access to the target Google Sheet
- access to the target Slate instance

## Install

```bash
npm install
```

## Local dashboard

The dashboard is the main way to run the project.

Start the UI:

```bash
npm run ui
```

Then open:

```text
http://127.0.0.1:4318
```

Dashboard flow:

1. paste the spreadsheet link
2. choose the `N Number` column
3. choose the `App Status` column
4. click `Start Audit`
5. if Google Sheets or Slate needs a login, complete it in the opened browser window
6. continue from the dashboard when prompted
7. monitor live counts, recent results, and console output

## CLI usage

The CLI is still available for direct runs.

Basic run:

```bash
npm run audit -- --sheet-url "YOUR_GOOGLE_SHEET_URL"
```

Useful flags:

- `--n-column D`
- `--status-column E`
- `--limit 5`
- `--row-from 20`
- `--row-to 50`
- `--dry-run`
- `--overwrite`
- `--browser chrome`

Example dry run:

```bash
npm run audit -- \
  --sheet-url "YOUR_GOOGLE_SHEET_URL" \
  --n-column D \
  --status-column E \
  --limit 5 \
  --dry-run
```

## Setup-only mode

If a login session needs to be prepared before a full run:

```bash
npm run audit:setup -- --sheet-url "YOUR_GOOGLE_SHEET_URL"
```

This opens the reusable browser profile, loads Google Sheets and Slate, and saves the session for future runs.

## Write from a saved report

Audit runs save JSON reports to `reports/`. A saved report can be written back to Google Sheets without re-checking Slate:

```bash
npm run audit -- \
  --sheet-url "YOUR_GOOGLE_SHEET_URL" \
  --report "reports/audit-report-...json"
```

## Default processing rules

By default, the automation processes rows that:

- contain an `N Number` in the chosen N-number column
- have a blank value in the chosen App Status column

Use `--overwrite` to reprocess rows that already have a value.

## Output

Each audit run can produce:

- live progress in the dashboard or terminal
- a JSON report in `reports/`
- optional debug screenshots when a row needs manual review

## Notes

- Only run one audit process at a time.
- The local browser profile in `.browser-profile/` is intended to persist login state between runs.
- If Google Sheets or Slate changes its page structure, selectors in `src/audit.mjs` may need to be updated.

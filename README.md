# Sangeet Pathshala — Attendance Register

A standalone attendance tracker with a tick-mark roll call, grouped by teacher and course.

## Setup

1. Install [Node.js](https://nodejs.org) if you don't already have it (v18 or newer).
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
3. Start the app:
   ```
   npm start
   ```
4. Open **http://localhost:3300** in your browser.

Keep the terminal window open while you use the app — that's the server running. Close it (or Ctrl+C) to stop.

## How it works

### Roll Call tab
- Pick a date, tick the box next to each student who's present, and hit **Save attendance**.
- Students are grouped by **Teacher**, then by **Course**, so each teacher's classes are together.
- You can revisit any past date — it'll load whatever was saved for that day.

### Students tab
- **Add student**: fill in name, contact info, teacher, course, duration, and admission date.
- **Duration** can also be set (or changed) any time directly in the Students table — just pick it from the dropdown in that row. Handy for students who came in without a duration (e.g. from an Excel import) or who are renewing.
- **Import from Excel**: upload your existing student list (.xlsx). It reads the first sheet and looks for columns named (any casing, spaces ignored):
  - Name *(required)* — also accepts "Student Name" or "Full Name"
  - Teacher — also accepts "Instructor" or "Faculty". Known misspellings ("Shishir Lama") are automatically normalized to "Sishir Lama".
  - Course — also accepts "Subject" or "Program"
  - Duration
  - Admission Date — also accepts "Date of Admission" or "Joined"

  It **skips any student whose name already exists** in the register (case-insensitive match), so re-uploading the same sheet after new admissions only pulls in the new names. Anyone added this way is tagged "excel-import" in the source column so you can tell them apart from students you typed in yourself.
- **Payments**: click a student's payment total to expand their history, then **+ Record payment** to open a receipt form — payer, phone, course, tutor, schedule, class dates, months, itemized fee items, discount, total, paid amount, balance due, pay date, method, received by, and notes. Saving generates a receipt number and verification code, same style as your receipts ledger. Click ✕ next to any payment to remove it.
- **Remove** deletes a student from the register (their past attendance history stays in the data file, but they'll no longer appear in roll call).

### Dashboard tab
- One card per student with everything in one place: contact info, teacher, course, duration, admission date, attendance for the current course cycle (present/total sessions and %), and full payment history.
- Students who've used up their duration move into a "Course Completed — Needs Renewal" section, showing how many classes they went over by. Renewing carries forward only those extra classes into the new cycle — the rest of the finished cycle's count resets.
- Search box in the top bar filters by name, teacher, or course.

### Teachers tab
- Each teacher's block shows their schedule and roster by class-time slot.

### Sync tab
See **OneDrive auto-sync** below.

## OneDrive auto-sync

Instead of manually uploading a copy of your spreadsheets, the app can pull directly from the real files in your OneDrive — new students from the registration sheet, new payments from the receipts ledger — on a schedule you set.

This works the same way your Day-End Report app talks to OneDrive: through a **Power Automate flow**, since a locally-run Node app can't sign in to your Microsoft 365 account directly. You build one small flow per file; the attendance app just calls its URL.

### 1. Build the "list rows" flow (once per file)

Repeat this for both `Sangeet_Pathshala.xlsx` and `Sangeet_Pathshala_Receipts.xlsx`:

1. Go to [make.powerautomate.com](https://make.powerautomate.com) → **Create** → **Instant cloud flow**.
2. Trigger: **When an HTTP request is received**. Leave the request body schema blank — save the flow once to generate its URL.
3. Add action: **Excel Online (Business) → List rows present in a table**. Pick the file from OneDrive and the table on Sheet1 (make sure the data is formatted as an Excel *table*, not just a plain range — that's what lets this action see it).
4. Add action: **Response** (or "Respond to a PowerApp or flow"). Set the body to the output of the *List rows* action's `value` array.
5. Save. Open the trigger step and copy the **HTTP POST URL** — this is what goes into the app.

Do this twice: once for the students sheet, once for the receipts sheet. Keep both URLs private — anyone with the URL can read that data.

### 2. Configure the app

1. Open the **Sync** tab.
2. Paste the two flow URLs into "Student registrations flow URL" and "Payments / receipts flow URL".
3. Set "Only import students admitted on/after" — this defaults to tomorrow's date, so students already sitting in your OneDrive sheet from before today won't suddenly all get imported at once. Only rows with an Admission Date (or form Timestamp) on/after this date are pulled in. Leave it blank to import everything, including older rows.
4. Pick how often to check (2–30 minutes), turn **Auto-sync** on, and **Save settings**.
5. Use **Sync now** any time to run it immediately and see the result.

### 3. How the sync behaves

- **Students**: matched by name — a student already in the register (by name) is never duplicated, so re-running the sync is safe.
- **Payments**: matched to an existing student by the receipt's **Payer** name. If the payer doesn't match any student name exactly, that row is skipped and listed under "Unmatched payers" on the Sync tab — **no new student is ever created from a payment row**. Each receipt's own numbers (total, paid, balance due, etc.) are trusted as-is rather than recalculated, and each is only imported once (by Receipt No), so reruns won't create duplicates.
- If a flow URL is unreachable or returns an error, the sync reports it as failed on the Sync tab rather than silently doing nothing — nothing already in `students.json` or `payments.json` is touched when that happens.
- Auto-sync only runs while the server (`npm start`) is running — same as everything else in this app.

## Data storage

Everything lives in plain JSON files in the `data/` folder:
- `students.json` — the student register
- `attendance.json` — attendance records, keyed by date
- `payments.json` — payment history, one entry per payment
- `sync-config.json` — your saved flow URLs and schedule (created after you save Sync settings)
- `sync-status.json` — the result of the most recent sync

Back these up (or copy the whole folder) whenever you like — there's no database to manage.

## Notes for later

- This is a separate app from your other Node/Express day-end report tool — no shared code or data between them, though the OneDrive sync uses the same Power Automate approach.

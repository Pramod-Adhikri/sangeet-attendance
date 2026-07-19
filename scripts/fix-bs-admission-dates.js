// One-time repair for students imported BEFORE the Excel-import fix: if your
// registration sheet's Admission Date column had BS dates (e.g. "1/15/2083")
// typed directly into a plain Excel date cell, they got stored as if that
// were a real AD date 57 years in the future — which then broke Roll
// Call/Dashboard for that student, since every real attendance mark falls
// "before" that nonsensical future cycle start.
//
// This finds every enrollment whose admissionDate or cycleStartDate looks
// like that mistake (year 2070+) and re-derives the real AD date from it,
// the same way the fixed import now does automatically.
//
// SAFE BY DEFAULT: running this with no flags only PRINTS what it would
// change — it writes nothing. Review the list, then re-run with --apply to
// actually save the fix.
//
//   node scripts/fix-bs-admission-dates.js            (dry run — just look)
//   node scripts/fix-bs-admission-dates.js --apply     (actually fix them)

const path = require('path');
const { readJSON, writeJSON } = require('../db');
const NepaliDateLib = require('../public/vendor/nepali-date-converter.js').default;

const STUDENTS_FILE = path.join(__dirname, '..', 'data', 'students.json');
const APPLY = process.argv.includes('--apply');

function bsPartsToAdString(y, m, d) {
  try {
    const nd = new NepaliDateLib(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    const jsDate = nd.toJsDate();
    if (isNaN(jsDate.getTime())) return null;
    const mm = String(jsDate.getMonth() + 1).padStart(2, '0');
    const dd = String(jsDate.getDate()).padStart(2, '0');
    return `${jsDate.getFullYear()}-${mm}-${dd}`;
  } catch (err) {
    return null;
  }
}

function looksLikeMistypedBs(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 2070 || y > 2110) return null;
  return { y, m: Number(m[2]), d: Number(m[3]) };
}

async function main() {
  const students = await readJSON(STUDENTS_FILE, []);
  const changes = [];

  for (const s of students) {
    if (looksLikeMistypedBs(s.admissionDate)) {
      const parts = looksLikeMistypedBs(s.admissionDate);
      const fixed = bsPartsToAdString(parts.y, parts.m, parts.d);
      if (fixed) changes.push({ student: s, field: 'student.admissionDate', target: s, key: 'admissionDate', before: s.admissionDate, after: fixed });
    }
    for (const e of s.enrollments || []) {
      for (const key of ['admissionDate', 'cycleStartDate']) {
        const parts = looksLikeMistypedBs(e[key]);
        if (!parts) continue;
        const fixed = bsPartsToAdString(parts.y, parts.m, parts.d);
        if (fixed) changes.push({ student: s, field: `${e.course} enrollment.${key}`, target: e, key, before: e[key], after: fixed });
      }
    }
  }

  if (!changes.length) {
    console.log('No mistyped-BS dates found — nothing to fix.');
    return;
  }

  console.log(`Found ${changes.length} date(s) to fix:\n`);
  for (const c of changes) {
    console.log(`  ${c.student.name} (${c.student.studentId || 'no ID'}) — ${c.field}: ${c.before}  ->  ${c.after}`);
  }

  if (!APPLY) {
    console.log(`\nDry run only — nothing was changed. Review the list above, then run:`);
    console.log(`  node scripts/fix-bs-admission-dates.js --apply`);
    return;
  }

  for (const c of changes) {
    c.target[c.key] = c.after;
  }
  await writeJSON(STUDENTS_FILE, students);
  console.log(`\nApplied. ${changes.length} date(s) corrected and saved.`);
}

main().catch((err) => {
  console.error('Repair script failed:', err);
  process.exit(1);
});

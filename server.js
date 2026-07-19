const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { readJSON, writeJSON } = require('./db');

const app = express();
const PORT = process.env.PORT || 3300;

const DATA_DIR = path.join(__dirname, 'data');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json');
const ATTENDANCE_FILE = path.join(DATA_DIR, 'attendance.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const ALERT_CONFIG_FILE = path.join(DATA_DIR, 'alert-config.json');
const ALERT_STATE_FILE = path.join(DATA_DIR, 'alert-state.json');
const ALERT_STATUS_FILE = path.join(DATA_DIR, 'alert-status.json');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- basic login protection ----------
// The whole app (pages + API) sits behind a single shared username/password
// so it's safe to expose on the public internet. Set these via environment
// variables on your host (e.g. Render's "Environment" tab) — never hardcode
// real credentials into this file if it's ever pushed somewhere public.
const AUTH_USER = process.env.APP_USER || 'admin';
const AUTH_PASS = process.env.APP_PASSWORD || 'change-this-password';

function requireLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const sepIndex = decoded.indexOf(':');
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    if (user === AUTH_USER && pass === AUTH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Sangeet Pathshala"');
  return res.status(401).send('Login required.');
}

app.use(requireLogin);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
// readJSON/writeJSON now come from ./db (SQLite-backed) — see db.js for why.

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Canonical teacher roster (kept in sync with the TEACHERS list in app.js)
// used to normalize spelling variants that show up in imported spreadsheets
// (e.g. "Shishir Lama" vs "Sishir Lama") to a single consistent name.
const KNOWN_TEACHERS = [
  'Shiva Shrestha', 'Manjil Lama', 'Rojan Ranjit', 'Pravesh Thapa',
  'Sishir Lama', 'Sanjil Nepali', 'Prajwol Sijapati', 'Aayush Tiwari',
  'Parash Thapa Magar', 'Yagya Lama'
];
const TEACHER_ALIASES = {
  'shishir lama': 'Sishir Lama',
  'sishir lama': 'Sishir Lama',
  // old spellings/short forms retired in favor of the corrected roster above
  'manjil k.c.': 'Manjil Lama',
  'manjil kc': 'Manjil Lama',
  'prabesh thapa magar': 'Pravesh Thapa',
  'prabesh thapa': 'Pravesh Thapa',
  'sanjil': 'Sanjil Nepali',
  'prajwol': 'Prajwol Sijapati',
  'ayush tiwari': 'Aayush Tiwari',
  'parash': 'Parash Thapa Magar'
};

function canonicalizeTeacherName(raw) {
  const name = String(raw || '').trim();
  if (!name) return name;
  const norm = name.toLowerCase().replace(/\s+/g, ' ').trim();
  if (TEACHER_ALIASES[norm]) return TEACHER_ALIASES[norm];
  const match = KNOWN_TEACHERS.find((t) => t.toLowerCase() === norm);
  return match || name;
}

// Try to find a value in a row object regardless of exact header casing/spacing
// Try to find a value in a row object regardless of exact header casing/spacing.
// Pass 1: exact match on normalized header (e.g. "Phone Number" for "phone number").
// Pass 2: substring match, so longer real-world headers still get picked up
// (e.g. "Student Full Name" for "name", "Assign Teacher" for "teacher").
function pickField(row, candidates) {
  const keys = Object.keys(row);
  const targets = candidates.map((c) => c.toLowerCase().replace(/\s+/g, ''));

  for (const target of targets) {
    for (const key of keys) {
      const norm = key.toLowerCase().replace(/\s+/g, '');
      if (norm === target && row[key] !== undefined && row[key] !== '') return row[key];
    }
  }

  for (const target of targets) {
    for (const key of keys) {
      const norm = key.toLowerCase().replace(/\s+/g, '');
      if ((norm.includes(target) || target.includes(norm)) && row[key] !== undefined && row[key] !== '') {
        return row[key];
      }
    }
  }

  return '';
}

// Same conversion library used client-side for the BS calendar UI, loaded
// here too so Excel imports can detect and correct BS dates that were typed
// directly into a plain (Gregorian-only) Excel date cell — see
// excelDateToString below for why that needs correcting at all.
const NepaliDateLib = require('./public/vendor/nepali-date-converter.js').default;

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

// A school admission is never genuinely 50+ years in the future. A year
// that high almost always means someone typed a BS calendar date (e.g.
// "1/15/2083") directly into a plain Excel date cell — Excel has no BS
// calendar mode, so it just stores that as a literal (and wildly future)
// Gregorian date. This re-interprets the same y/m/d numbers as BS and
// converts them to the real AD date instead of storing the nonsense as-is.
function correctIfMistypedBs(y, m, d) {
  if (y >= 2070 && y <= 2110) {
    const converted = bsPartsToAdString(y, m, d);
    if (converted) return converted;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseLooseDateParts(str) {
  let m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return { y: Number(m[3]), m: Number(m[1]), d: Number(m[2]) };
  return null;
}

function excelDateToString(value) {
  if (value instanceof Date) {
    return correctIfMistypedBs(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  // Excel serial date — may arrive as a real number (from an uploaded
  // .xlsx) or as a numeric string (Power Automate's JSON often sends
  // Excel numeric cells as strings, e.g. "46138" instead of 46138).
  let serial = null;
  if (typeof value === 'number') serial = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) serial = Number(value.trim());

  if (serial !== null) {
    const parsed = XLSX.SSF.parse_date_code(serial);
    if (parsed) return correctIfMistypedBs(parsed.y, parsed.m, parsed.d);
  }

  // Plain text cell (e.g. "1/15/2083" or "2083-01-15" typed directly, not a
  // real Excel date). Same BS/AD detection applies once parsed.
  const str = String(value || '').trim();
  const parts = str ? parseLooseDateParts(str) : null;
  if (parts) return correctIfMistypedBs(parts.y, parts.m, parts.d);

  return str;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Saturday is the school's holiday — no classes happen, so it's never a
// valid attendance date and is excluded from every count/stat.
function isSaturday(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return false;
  return new Date(y, m - 1, d).getDay() === 6;
}

// Assigns permanent, human-readable roll numbers (SP0001, SP0002, ...).
// Backed by a persistent counter so numbers never get reused, even if a
// student is later removed.
async function getNextStudentId() {
  const meta = await readJSON(META_FILE, { nextStudentId: 1 });
  const num = meta.nextStudentId || 1;
  meta.nextStudentId = num + 1;
  await writeJSON(META_FILE, meta);
  return `SP${String(num).padStart(4, '0')}`;
}

// One-time catch-up for students created before this feature existed.
async function backfillStudentIds() {
  const students = await readJSON(STUDENTS_FILE, []);
  let changed = false;
  for (const s of students) {
    if (!s.studentId) {
      s.studentId = await getNextStudentId();
      changed = true;
    }
  }
  if (changed) await writeJSON(STUDENTS_FILE, students);
}

// Maps a course duration to its total class count. Returns null if the
// duration doesn't match one of the known course lengths.
// warnAt = class count at which a "classes almost over" warning email fires
// (2 classes before the allotment for every duration, per Pramod's spec).
const DURATION_CLASS_MAP = [
  { pattern: /^1\s*month$/, classes: 12, warnAt: 10 },
  { pattern: /^3\s*months?$/, classes: 36, warnAt: 34 },
  { pattern: /^6\s*months?$/, classes: 72, warnAt: 70 },
  { pattern: /^1\s*year$/, classes: 144, warnAt: 142 },
  { pattern: /^12\s*months?$/, classes: 144, warnAt: 142 }
];

function classesForDuration(duration) {
  const normalized = String(duration || '').trim().toLowerCase();
  if (!normalized) return null;
  const match = DURATION_CLASS_MAP.find((entry) => entry.pattern.test(normalized));
  return match ? match.classes : null;
}

function warnAtForDuration(duration) {
  const normalized = String(duration || '').trim().toLowerCase();
  if (!normalized) return null;
  const match = DURATION_CLASS_MAP.find((entry) => entry.pattern.test(normalized));
  return match ? match.warnAt : null;
}

// ---------- enrollments (multi-course support) ----------
//
// A student can now be enrolled in more than one course at once (e.g.
// Guitar AND Vocals), each with its own teacher, duration, class time and
// attendance/renewal cycle. Rather than one course living directly on the
// student record, each course is an "enrollment" inside student.enrollments.
//
// Backward compatibility, deliberately kept simple:
//  - The FIRST enrollment a student ever has is always given the fixed id
//    'primary'. Its attendance is stored under the plain student.id key —
//    EXACTLY like every student before this feature existed. This means
//    none of the existing attendance.json history needs to be touched or
//    migrated; nothing changes for the ~92% of students who only ever have
//    one course.
//  - Any SECOND (or later) enrollment gets its own generated id, and its
//    attendance is stored under the composite key `${student.id}::${enrollmentId}`
//    so it's tracked completely independently — separate cycle, separate
//    class count, separate dues — from the student's other course(s).
//  - student.course / teacher / duration / classTime / cycleStartDate /
//    baseline are kept mirroring the primary enrollment, so any older code
//    (or report) that still reads those flat fields keeps working.

function attendanceKeyFor(studentDbId, enrollmentId) {
  return enrollmentId === 'primary' ? studentDbId : `${studentDbId}::${enrollmentId}`;
}

function makeEnrollment({ id, course, teacher, classTime, duration, admissionDate, cycleStartDate, active, baseline }) {
  return {
    id: id || crypto.randomUUID(),
    course: String(course || '').trim(),
    teacher: canonicalizeTeacherName(teacher),
    classTime: String(classTime || '').trim(),
    duration: String(duration || '').trim(),
    admissionDate: String(admissionDate || '').trim(),
    cycleStartDate: String(cycleStartDate || admissionDate || '').trim() || todayISO(),
    active: active !== false,
    baseline: baseline || { present: 0, absent: 0 }
  };
}

// One-time-per-student upgrade: gives every legacy (pre-enrollments) student
// a single 'primary' enrollment built from their existing flat fields. Safe
// to call on every read — students that already have enrollments pass
// straight through untouched.
function ensureEnrollments(student) {
  if (Array.isArray(student.enrollments) && student.enrollments.length) return student;
  student.enrollments = [
    makeEnrollment({
      id: 'primary',
      course: student.course,
      teacher: student.teacher,
      classTime: student.classTime,
      duration: student.duration,
      admissionDate: student.admissionDate,
      cycleStartDate: student.cycleStartDate,
      active: true,
      baseline: student.baseline
    })
  ];
  return student;
}

// Keeps the legacy flat fields (student.course/teacher/etc) mirroring
// whichever enrollment is 'primary', so old code paths that still read
// student.course directly keep seeing the first/main course.
function syncPrimaryMirror(student) {
  const primary = student.enrollments.find((e) => e.id === 'primary') || student.enrollments[0];
  if (!primary) return student;
  student.course = primary.course;
  student.teacher = primary.teacher;
  student.classTime = primary.classTime;
  student.duration = primary.duration;
  student.cycleStartDate = primary.cycleStartDate;
  student.baseline = primary.baseline;
  return student;
}

async function loadStudentsWithEnrollments() {
  const students = await readJSON(STUDENTS_FILE, []);
  let changed = false;
  for (const s of students) {
    const before = JSON.stringify(s.enrollments || null);
    ensureEnrollments(s);
    if (JSON.stringify(s.enrollments) !== before) changed = true;
  }
  if (changed) await writeJSON(STUDENTS_FILE, students);
  return students;
}

// ---------- students ----------

app.get('/api/students', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  res.json(students);
});

app.post('/api/students', async (req, res) => {
  const { name, teacher, course, duration, admissionDate, contact, classTime, studentId, courses } = req.body;

  // `courses`, if present, is the "join with multiple courses at once"
  // path (e.g. Guitar + Vocals from day one) — an array of
  // { course, teacher, duration, classTime }. Otherwise fall back to the
  // single teacher/course/duration/classTime fields, same as before.
  const courseList = Array.isArray(courses) && courses.length ? courses : [{ teacher, course, duration, classTime }];

  if (!name || !name.trim()) return res.status(400).json({ error: 'Student name is required.' });
  for (const c of courseList) {
    if (!c.teacher || !String(c.teacher).trim()) return res.status(400).json({ error: 'Teacher name is required.' });
    if (!c.course || !String(c.course).trim()) return res.status(400).json({ error: 'Course is required.' });
  }

  const students = await loadStudentsWithEnrollments();

  let finalStudentId;
  const customId = (studentId || '').trim();
  if (customId) {
    if (students.some((s) => (s.studentId || '').toLowerCase() === customId.toLowerCase())) {
      return res.status(400).json({ error: `Student ID "${customId}" is already in use.` });
    }
    finalStudentId = customId;
  } else {
    finalStudentId = await getNextStudentId();
  }

  const enrollments = courseList.map((c, i) => makeEnrollment({
    id: i === 0 ? 'primary' : undefined,
    course: c.course,
    teacher: c.teacher,
    classTime: c.classTime,
    duration: c.duration,
    admissionDate: admissionDate,
    cycleStartDate: admissionDate
  }));

  const student = {
    id: crypto.randomUUID(),
    studentId: finalStudentId,
    name: name.trim(),
    contact: (contact || '').trim(),
    admissionDate: (admissionDate || '').trim(),
    active: true,
    source: 'manual',
    enrollments
  };
  syncPrimaryMirror(student);
  students.push(student);
  await writeJSON(STUDENTS_FILE, students);
  res.status(201).json(student);
});

// Adds a NEW course enrollment to an EXISTING student (e.g. they already
// take Guitar and now also want Vocals). This is the proper replacement for
// the old "type the same name again" trick — same person, same studentId,
// one more independent course cycle, instead of a second disconnected
// student record.
app.post('/api/students/:id/courses', async (req, res) => {
  const { course, teacher, classTime, duration, admissionDate } = req.body;
  if (!course || !String(course).trim()) return res.status(400).json({ error: 'Course is required.' });
  if (!teacher || !String(teacher).trim()) return res.status(400).json({ error: 'Teacher name is required.' });

  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const alreadyHas = student.enrollments.some(
    (e) => e.active && e.course.toLowerCase() === String(course).trim().toLowerCase()
  );
  if (alreadyHas) return res.status(400).json({ error: `${student.name} is already enrolled in ${course}.` });

  const enrollment = makeEnrollment({ course, teacher, classTime, duration, admissionDate });
  student.enrollments.push(enrollment);
  await writeJSON(STUDENTS_FILE, students);
  res.status(201).json({ student, enrollment });
});

app.put('/api/students/:id/courses/:enrollmentId', async (req, res) => {
  const { course, teacher, classTime, duration, active } = req.body;
  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const enrollment = student.enrollments.find((e) => e.id === req.params.enrollmentId);
  if (!enrollment) return res.status(404).json({ error: 'Course enrollment not found.' });

  if (course !== undefined) enrollment.course = String(course).trim();
  if (teacher !== undefined) enrollment.teacher = canonicalizeTeacherName(teacher);
  if (classTime !== undefined) enrollment.classTime = String(classTime).trim();
  if (duration !== undefined) enrollment.duration = String(duration).trim();
  if (active !== undefined) enrollment.active = !!active;

  syncPrimaryMirror(student);
  await writeJSON(STUDENTS_FILE, students);
  res.json({ student, enrollment });
});

// Removing a course only removes that one enrollment (and, going forward,
// stops it showing up in Roll Call / dues) — it never touches the
// student's other course(s), and never deletes the student. The last
// remaining enrollment can't be removed this way; delete the student
// instead if they're leaving entirely.
app.delete('/api/students/:id/courses/:enrollmentId', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (student.enrollments.length <= 1) {
    return res.status(400).json({ error: 'A student needs at least one course — delete the student instead if they are leaving entirely.' });
  }
  const before = student.enrollments.length;
  student.enrollments = student.enrollments.filter((e) => e.id !== req.params.enrollmentId);
  if (student.enrollments.length === before) return res.status(404).json({ error: 'Course enrollment not found.' });

  // If the 'primary' enrollment itself was removed, promote whichever
  // enrollment is left oldest to 'primary' so the legacy mirror fields
  // (and its attendance key, which stays student.id either way) keep
  // pointing at a real course.
  if (!student.enrollments.some((e) => e.id === 'primary')) {
    student.enrollments[0].id = 'primary';
  }
  syncPrimaryMirror(student);
  await writeJSON(STUDENTS_FILE, students);
  res.json({ student });
});

app.put('/api/students/:id', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const idx = students.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Student not found.' });

  const { name, teacher, course, duration, admissionDate, active, contact, classTime, studentId } = req.body;
  const existing = students[idx];

  let nextStudentIdValue = existing.studentId;
  if (studentId !== undefined) {
    const trimmedId = studentId.trim();
    if (!trimmedId) return res.status(400).json({ error: 'Student ID cannot be empty.' });
    const clash = students.some((s, i) => i !== idx && (s.studentId || '').toLowerCase() === trimmedId.toLowerCase());
    if (clash) return res.status(400).json({ error: `Student ID "${trimmedId}" is already in use.` });
    nextStudentIdValue = trimmedId;
  }

  ensureEnrollments(existing);
  const primary = existing.enrollments.find((e) => e.id === 'primary') || existing.enrollments[0];

  students[idx] = {
    ...existing,
    studentId: nextStudentIdValue,
    name: name !== undefined ? name.trim() : existing.name,
    contact: contact !== undefined ? contact.trim() : existing.contact,
    admissionDate: admissionDate !== undefined ? admissionDate.trim() : existing.admissionDate,
    active: active !== undefined ? active : existing.active
  };
  // This route edits the FIRST/primary course only — use
  // PUT /api/students/:id/courses/:enrollmentId to edit a student's other
  // course(s) when they have more than one.
  if (teacher !== undefined) primary.teacher = canonicalizeTeacherName(teacher);
  if (classTime !== undefined) primary.classTime = classTime.trim();
  if (course !== undefined) primary.course = course.trim();
  if (duration !== undefined) primary.duration = duration.trim();
  syncPrimaryMirror(students[idx]);

  await writeJSON(STUDENTS_FILE, students);
  res.json(students[idx]);
});

app.delete('/api/students/:id', async (req, res) => {
  const students = await readJSON(STUDENTS_FILE, []);
  const filtered = students.filter((s) => s.id !== req.params.id);
  if (filtered.length === students.length) return res.status(404).json({ error: 'Student not found.' });
  await writeJSON(STUDENTS_FILE, filtered);
  res.json({ deleted: true });
});

// Resets a student's class count — used when they renew/extend their course.
// Rather than wiping the slate to zero OR letting the old cycle's full class
// count bleed into the new one, this carries over only the classes ATTENDED
// *beyond* the previous duration's allotment (e.g. finished a 1-month/12-class
// course but was present for 15 — the 3 extra classes count against the new
// cycle, the other 12 are wiped since that cycle is done and paid for).
// Absences don't count toward "using up" a duration, so they're not part of
// this carry-over calculation either.
// Shared renew logic, now scoped to ONE enrollment (course) rather than the
// whole student, using that enrollment's own attendance key so renewing
// Guitar never touches Vocals' cycle, class count, or baseline.
async function renewEnrollment(student, enrollment, { duration, cycleStartDate }) {
  const newDuration = duration !== undefined && duration.trim() ? duration.trim() : enrollment.duration;

  const attendance = await readJSON(ATTENDANCE_FILE, {});
  const key = attendanceKeyFor(student.id, enrollment.id);
  const oldCycleStart = enrollment.cycleStartDate || enrollment.admissionDate || '0000-01-01';
  const oldAllotted = classesForDuration(enrollment.duration);

  const presentDatesInOldCycle = Object.keys(attendance)
    .filter((date) =>
      !isSaturday(date) &&
      date >= oldCycleStart &&
      Object.prototype.hasOwnProperty.call(attendance[date], key) &&
      attendance[date][key]
    )
    .sort();

  const presentTakenOld = presentDatesInOldCycle.length;
  const extra = oldAllotted !== null ? Math.max(0, presentTakenOld - oldAllotted) : 0;

  const newCycleStartDate = extra > 0
    ? presentDatesInOldCycle[presentDatesInOldCycle.length - extra]
    : (cycleStartDate || '').trim() || todayISO();

  enrollment.duration = newDuration;
  enrollment.cycleStartDate = newCycleStartDate;
  enrollment.baseline = { present: 0, absent: 0 };
  return enrollment;
}

// Renews the PRIMARY (first/main) course only — kept at this same URL for
// backward compatibility with anything already calling it. Use
// POST /api/students/:id/courses/:enrollmentId/renew for a student's other
// course(s).
app.post('/api/students/:id/renew', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const primary = student.enrollments.find((e) => e.id === 'primary') || student.enrollments[0];

  await renewEnrollment(student, primary, req.body);
  syncPrimaryMirror(student);
  await writeJSON(STUDENTS_FILE, students);
  res.json(student);
});

app.post('/api/students/:id/courses/:enrollmentId/renew', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const enrollment = student.enrollments.find((e) => e.id === req.params.enrollmentId);
  if (!enrollment) return res.status(404).json({ error: 'Course enrollment not found.' });

  await renewEnrollment(student, enrollment, req.body);
  syncPrimaryMirror(student);
  await writeJSON(STUDENTS_FILE, students);
  res.json({ student, enrollment });
});

// ---------- attendance ----------

app.get('/api/attendance/:date', async (req, res) => {
  const attendance = await readJSON(ATTENDANCE_FILE, {});
  res.json(attendance[req.params.date] || {});
});

app.post('/api/attendance/:date', async (req, res) => {
  const { records } = req.body; // { studentId: true/false }
  if (!records || typeof records !== 'object') {
    return res.status(400).json({ error: 'records object is required.' });
  }
  if (isSaturday(req.params.date)) {
    return res.status(400).json({ error: 'Saturday is a holiday — attendance cannot be recorded for this date.' });
  }
  const attendance = await readJSON(ATTENDANCE_FILE, {});
  attendance[req.params.date] = {
    ...(attendance[req.params.date] || {}),
    ...records
  };
  await writeJSON(ATTENDANCE_FILE, attendance);
  res.json({ saved: true, date: req.params.date, records: attendance[req.params.date] });

  // Fire-and-forget: re-check warning/renewal thresholds right after this
  // save so alerts go out the moment a student crosses one, without making
  // the person marking attendance wait on it.
  checkAndSendAlerts('attendance-save').catch((err) => console.error('Attendance-triggered alert check failed:', err));
});

// ---------- payments (receipt-style, matching the Sangeet Pathshala receipts ledger) ----------

// Turns [{label, amount}, ...] into the "Label=Amount | Label2=Amount2" text
// format used in the Fee Items column of the receipts spreadsheet.
function feeItemsToString(feeItems) {
  return (feeItems || [])
    .filter((f) => f && String(f.label || '').trim() && Number(f.amount) > 0)
    .map((f) => `${String(f.label).trim()}=${Number(f.amount)}`)
    .join(' | ');
}

// Receipt No format mirrors the ledger's "SP-<year>-<MMDD>-<HHMMSS>" style.
function generateReceiptNo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `SP-${d.getFullYear()}-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Verification code format mirrors the ledger's "SP-XXXXXXXX" style.
function generateVerificationCode() {
  return `SP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

app.get('/api/payments', async (req, res) => {
  const payments = await readJSON(PAYMENTS_FILE, []);
  res.json(payments);
});

// Builds one payment record for a single course enrollment. Used directly
// by POST /api/payments (single-course case) and internally, once per
// course, by POST /api/payments/combined (multi-course-at-once case) — that
// second path is what keeps a combined admission receipt from crediting one
// tutor for a course they didn't teach, or mixing two courses' dues
// together (the old comma-joined-course-string problem in the Excel
// ledger).
async function buildPayment(student, enrollmentId, body, payments, receiptGroupId) {
  const {
    payer, phone, course, tutor, schedule,
    classStart, classEnd, months, feeItems, discount,
    paidAmount, payDate, method, receivedBy, notes
  } = body;

  const feeItemsArr = Array.isArray(feeItems) ? feeItems : [];
  const feeItemsTotal = feeItemsArr.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const discountAmt = Number(discount) || 0;
  const totalAmount = Math.max(feeItemsTotal - discountAmt, 0);
  const paidAmt = Number(paidAmount) || 0;
  if (totalAmount <= 0 && paidAmt <= 0) {
    return { error: 'Enter a fee amount, a paid amount, or both.' };
  }
  const balanceDue = Math.max(totalAmount - paidAmt, 0);

  // Running balance is scoped to THIS course enrollment only — Guitar's
  // running balance never absorbs or gets absorbed by Vocals'.
  const priorNet = payments
    .filter((p) => p.studentId === student.id && (p.enrollmentId || 'primary') === enrollmentId)
    .reduce((sum, p) => sum + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0), 0);
  const runningBalance = Math.max(priorNet + (totalAmount - paidAmt), 0);

  return {
    id: crypto.randomUUID(),
    receiptNo: generateReceiptNo(),
    receiptGroupId: receiptGroupId || null,
    studentId: student.id,
    enrollmentId,
    studentCode: student.studentId || '',
    payer: (payer || student.name || '').trim(),
    phone: (phone || student.contact || '').trim(),
    course: (course || '').trim(),
    tutor: (tutor || '').trim(),
    schedule: (schedule || '').trim(),
    classStart: (classStart || '').trim(),
    classEnd: (classEnd || '').trim(),
    months: months ? Number(months) : null,
    feeItems: feeItemsToString(feeItemsArr),
    discount: discountAmt,
    totalAmount,
    paidAmount: paidAmt,
    balanceDue,
    runningBalance,
    payDate: (payDate || '').trim() || todayISO(),
    method: (method || '').trim() || 'Cash',
    receivedBy: (receivedBy || '').trim(),
    notes: (notes || '').trim(),
    verificationCode: generateVerificationCode(),
    timestamp: new Date().toISOString()
  };
}

app.post('/api/payments', async (req, res) => {
  const { studentId, enrollmentId } = req.body;

  if (!studentId) return res.status(400).json({ error: 'studentId is required.' });

  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === studentId);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const enrollment = student.enrollments.find((e) => e.id === (enrollmentId || 'primary')) || student.enrollments[0];
  // course/tutor default to the enrollment's own values when not supplied,
  // rather than falling back to whatever the student's PRIMARY course is —
  // that fallback is exactly what used to cause a Vocals payment to get
  // silently recorded under a student's Guitar teacher.
  req.body.course = req.body.course || enrollment.course;
  req.body.tutor = req.body.tutor || enrollment.teacher;

  const payments = await readJSON(PAYMENTS_FILE, []);
  const payment = await buildPayment(student, enrollment.id, req.body, payments, null);
  if (payment.error) return res.status(400).json({ error: payment.error });

  payments.push(payment);
  await writeJSON(PAYMENTS_FILE, payments);
  res.status(201).json(payment);

  checkAndSendAlerts('payment-save').catch((err) => console.error('Payment-triggered alert check failed:', err));
});

// One receipt covering MULTIPLE courses at once (e.g. admission into
// Guitar + Vocals same day, paid together). Rather than cramming both
// courses into one row like the old Excel ledger did (losing per-course
// tutor/duration/amount in the process), this creates one payment record
// PER course — each with its own course, tutor, duration, and amount —
// tagged with a shared receiptGroupId so they can still be displayed or
// printed together as "one receipt."
app.post('/api/payments/combined', async (req, res) => {
  const { studentId, items } = req.body;
  if (!studentId) return res.status(400).json({ error: 'studentId is required.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one course line item is required.' });

  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === studentId);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const payments = await readJSON(PAYMENTS_FILE, []);
  const receiptGroupId = crypto.randomUUID();
  const baseReceiptNo = generateReceiptNo();
  const created = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const enrollment = student.enrollments.find((e) => e.id === item.enrollmentId);
    if (!enrollment) return res.status(400).json({ error: `Unknown course enrollment for this student (${item.enrollmentId}).` });
    const body = { ...req.body, ...item, course: item.course || enrollment.course, tutor: item.tutor || enrollment.teacher };
    const payment = await buildPayment(student, enrollment.id, body, [...payments, ...created], receiptGroupId);
    if (payment.error) return res.status(400).json({ error: `${enrollment.course}: ${payment.error}` });
    // Same base receipt (so it's clear these belong to one transaction),
    // suffixed per line item so each stays individually identifiable —
    // same convention used when splitting legacy combined ledger rows.
    payment.receiptNo = items.length > 1 ? `${baseReceiptNo}-${i + 1}` : baseReceiptNo;
    created.push(payment);
  }

  payments.push(...created);
  await writeJSON(PAYMENTS_FILE, payments);
  res.status(201).json({ receiptGroupId, payments: created });

  checkAndSendAlerts('payment-save').catch((err) => console.error('Payment-triggered alert check failed:', err));
});

app.delete('/api/payments/:id', async (req, res) => {
  const payments = await readJSON(PAYMENTS_FILE, []);
  const filtered = payments.filter((p) => p.id !== req.params.id);
  if (filtered.length === payments.length) return res.status(404).json({ error: 'Payment not found.' });
  await writeJSON(PAYMENTS_FILE, filtered);
  res.json({ deleted: true });
});

// ---------- dashboard (combined per-student view) ----------

// Computes the full attendance/dues/status picture for ONE course
// enrollment — this is the same logic the dashboard always used, just
// scoped by the enrollment's own attendance key and its own payments
// (matched by studentId + enrollmentId) instead of by the whole student.
// A student with 2 courses gets this run twice, completely independently.
function computeEnrollmentStats(student, enrollment, attendance, paymentsForEnrollment) {
  const cycleStart = enrollment.cycleStartDate || enrollment.admissionDate || '0000-01-01';
  const key = attendanceKeyFor(student.id, enrollment.id);
  let present = 0;
  let total = 0;
  const presentDates = [];
  for (const date of Object.keys(attendance).sort()) {
    if (isSaturday(date)) continue;
    if (date >= cycleStart && Object.prototype.hasOwnProperty.call(attendance[date], key)) {
      total += 1;
      if (attendance[date][key]) {
        present += 1;
        presentDates.push(date);
      }
    }
  }
  const absent = total - present;

  const sortedPayments = [...paymentsForEnrollment].sort((a, b) => (a.payDate < b.payDate ? 1 : -1));
  const totalPaid = sortedPayments.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
  const outstandingBalance = Math.max(
    sortedPayments.reduce((sum, p) => sum + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0), 0),
    0
  );
  const duePending = outstandingBalance > 0;

  const allotted = classesForDuration(enrollment.duration);
  const baseline = enrollment.baseline || { present: 0, absent: 0 };
  const baselinePresent = Number(baseline.present) || 0;
  const baselineAbsent = Number(baseline.absent) || 0;

  const effectivePresent = present + baselinePresent;
  const effectiveAbsent = absent + baselineAbsent;
  const effectiveTotal = effectivePresent + effectiveAbsent;

  const overextended = allotted !== null && effectivePresent >= allotted;
  const extraClasses = allotted !== null ? Math.max(0, effectivePresent - allotted) : 0;
  const effectiveStatus = allotted === null ? null : (overextended ? 'Needs renewal' : 'Classes running');
  const remainingAfterBaseline = allotted !== null ? Math.max(0, allotted - baselinePresent) : null;
  const finalClassDate = overextended && remainingAfterBaseline !== null && presentDates[remainingAfterBaseline - 1]
    ? presentDates[remainingAfterBaseline - 1]
    : null;

  return {
    attendanceKey: key,
    attendance: { present, total, percentage: total ? Math.round((present / total) * 100) : null },
    baseline: { present: baselinePresent, absent: baselineAbsent },
    effectiveTotal, effectivePresent, effectiveAbsent, effectiveStatus,
    payments: sortedPayments, totalPaid, outstandingBalance, duePending,
    cycleStartDate: cycleStart, allotted, extraClasses, overextended, finalClassDate
  };
}

// One row per COURSE ENROLLMENT (not per student) — a student taking
// Guitar and Vocals appears as two rows, each with its own attendance,
// dues, and renewal status, tagged with the same studentDbId + name so the
// UI can still group/display them together as one person.
app.get('/api/dashboard', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const attendance = await readJSON(ATTENDANCE_FILE, {});
  const payments = await readJSON(PAYMENTS_FILE, []);

  const paymentsByKey = {}; // `${studentId}::${enrollmentId}` -> payments[]
  for (const p of payments) {
    const enrollmentId = p.enrollmentId || 'primary';
    const key = `${p.studentId}::${enrollmentId}`;
    paymentsByKey[key] = paymentsByKey[key] || [];
    paymentsByKey[key].push(p);
  }

  const rows = [];
  for (const s of students) {
    for (const enrollment of s.enrollments) {
      if (enrollment.active === false) continue;
      const stats = computeEnrollmentStats(
        s, enrollment, attendance,
        paymentsByKey[`${s.id}::${enrollment.id}`] || []
      );
      rows.push({
        // Row identity: dbId is unique per course row; id/studentDbId both
        // point at the underlying student for anything keying off "the
        // person" (payments, roll call links, etc).
        dbId: attendanceKeyFor(s.id, enrollment.id),
        id: s.id,
        studentDbId: s.id,
        enrollmentId: enrollment.id,
        isPrimary: enrollment.id === 'primary',
        courseCount: s.enrollments.filter((e) => e.active !== false).length,
        studentId: s.studentId || '',
        name: s.name,
        contact: s.contact || '',
        teacher: enrollment.teacher,
        classTime: enrollment.classTime || '',
        course: enrollment.course,
        duration: enrollment.duration,
        admissionDate: enrollment.admissionDate || s.admissionDate,
        active: s.active !== false,
        ...stats
      });
    }
  }

  res.json(rows.sort((a, b) => a.name.localeCompare(b.name) || a.course.localeCompare(b.course)));
});

// Re-checks the shared app password. Used as a lightweight second
// confirmation before letting someone add a baseline class count — even
// though they're already logged into the app, this adds a deliberate extra
// step before this kind of edit.
app.post('/api/verify-admin-password', (req, res) => {
  const { password } = req.body;
  res.json({ ok: password === AUTH_PASS });
});

// Sets a student's "baseline" — classes already taken before this system
// existed. This is ADDITIVE: it's added on top of whatever Roll Call
// records from here on, not a freeze. Send 0 for both fields to remove it.
app.put('/api/students/:id/baseline', async (req, res) => {
  const { password, baselinePresent, baselineAbsent, enrollmentId } = req.body;
  if (password !== AUTH_PASS) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const students = await loadStudentsWithEnrollments();
  const student = students.find((s) => s.id === req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const enrollment = student.enrollments.find((e) => e.id === (enrollmentId || 'primary')) || student.enrollments[0];

  const toNonNegativeInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const baseline = {
    present: toNonNegativeInt(baselinePresent),
    absent: toNonNegativeInt(baselineAbsent)
  };

  enrollment.baseline = baseline;
  syncPrimaryMirror(student);
  await writeJSON(STUDENTS_FILE, students);
  res.json({ ok: true, baseline, enrollmentId: enrollment.id });
});

// ---------- summary (single day) ----------

app.get('/api/summary/:date', async (req, res) => {
  const students = await loadStudentsWithEnrollments();
  const attendance = await readJSON(ATTENDANCE_FILE, {});
  const dayRecords = attendance[req.params.date] || {};

  // One "row" per active course enrollment, not per student — a student
  // taking Guitar and Vocals contributes two independent rows here, each
  // checked against its own attendance key, so the per-teacher breakdown
  // below is accurate for both teachers instead of only the primary one.
  const rows = [];
  for (const s of students) {
    if (s.active === false) continue;
    for (const e of s.enrollments) {
      if (e.active === false) continue;
      rows.push({ teacher: e.teacher || 'Unassigned', key: attendanceKeyFor(s.id, e.id) });
    }
  }

  const marked = rows.filter((r) => Object.prototype.hasOwnProperty.call(dayRecords, r.key));
  const present = marked.filter((r) => dayRecords[r.key]).length;
  const absent = marked.length - present;

  const byTeacherMap = {};
  for (const r of rows) {
    byTeacherMap[r.teacher] = byTeacherMap[r.teacher] || { teacher: r.teacher, present: 0, total: 0 };
    if (Object.prototype.hasOwnProperty.call(dayRecords, r.key)) {
      byTeacherMap[r.teacher].total += 1;
      if (dayRecords[r.key]) byTeacherMap[r.teacher].present += 1;
    }
  }

  res.json({
    date: req.params.date,
    totalStudents: rows.length,
    marked: marked.length,
    present,
    absent,
    percentage: marked.length ? Math.round((present / marked.length) * 100) : null,
    byTeacher: Object.values(byTeacherMap).sort((a, b) => a.teacher.localeCompare(b.teacher))
  });
});

// ---------- excel import (shared by manual upload and OneDrive sync) ----------

// Phone numbers only, digits-only, last 10 digits — lets "+977 980-1234567",
// "9801234567" and "980 123 4567" all match each other while still telling
// two genuinely different numbers apart.
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// Turns spreadsheet-style rows (from an uploaded .xlsx OR from a Power
// Automate "List rows present in a table" response — both arrive as plain
// objects keyed by column name) into student enrollments, and — if the
// sheet has them — an initial payment per course from two optional
// columns: `Course Fee` (total owed) and `Paid Amount` (what was actually
// handed over). Whatever's left between the two becomes that course's due,
// exactly like the manual "Add student" form's Course fee / Paid now
// fields. Mutates `students` and `payments` in place.
//
// A row is matched to an EXISTING student by name + phone together (not
// name alone) — this is what stops two different people who happen to
// share a name from getting merged, while still catching the same real
// student registering again for a second course. Matched rows add a new
// course enrollment to that student instead of creating a duplicate
// student record; rows with no match create a new student.
//
// The registration form can list more than one course for the same signup
// (its "Select Multiple Course" field, semicolon-separated) — each course
// in that list becomes its own enrollment, all sharing this row's single
// Teacher/Class Time/Duration/Start Date/Fee, since the form doesn't
// capture separate values per course in that case. A combined fee/paid
// amount is split evenly across the row's courses — safe here because
// Sangeet Pathshala charges the same fee for the same duration regardless
// of course (same rule already used for the receipts ledger's combined
// rows).
async function importStudentRows(rows, students, payments) {
  const existingIds = new Set(students.map((s) => (s.studentId || '').toLowerCase()).filter(Boolean));
  const addedStudents = [];
  const addedCourses = []; // new enrollments added to already-existing students
  const addedPayments = [];
  const skipped = [];

  for (const row of rows) {
    const name = pickField(row, ['name', 'student name', 'studentname', 'full name']);
    if (!name || !String(name).trim()) continue;

    const contact = pickField(row, ['contact', 'phone', 'contact number', 'mobile', 'phone number', 'contact info']);
    const norm = normalizeName(name);
    const phone = normalizePhone(contact);

    const match = students.find((s) => normalizeName(s.name) === norm && (!phone || normalizePhone(s.contact) === phone));

    const teacher = canonicalizeTeacherName(pickField(row, ['teacher', 'instructor', 'faculty', 'assign teacher']));
    const classTime = String(pickField(row, ['class time', 'classtime', 'time', 'schedule']) || '').trim();
    const multiCourseRaw = pickField(row, ['select multiple course', 'multiple course']);
    const singleCourseRaw = pickField(row, ['select individual course', 'course', 'subject', 'program']);
    const courseNames = (multiCourseRaw ? String(multiCourseRaw) : String(singleCourseRaw || ''))
      .split(/[;,]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!courseNames.length) courseNames.push('Unassigned');

    const durationRaw = pickField(row, ['duration', 'select fee plan']);
    const admissionRaw = pickField(row, ['admission date', 'admissiondate', 'date of admission', 'joined', 'start date', 'class start date', 'student class start date']);
    const admissionDate = admissionRaw ? excelDateToString(admissionRaw) : '';

    // Optional money columns — if the sheet doesn't have them, both come
    // back 0 and nothing payment-related happens, exactly like today.
    const courseFee = Number(pickField(row, ['course fee', 'fee', 'total fee', 'total amount'])) || 0;
    const paidNow = Number(pickField(row, ['paid amount', 'paid now', 'amount paid'])) || 0;
    const n = courseNames.length;
    const perCourseFee = Math.round((courseFee / n) * 100) / 100;
    const perCoursePaid = Math.round((paidNow / n) * 100) / 100;

    async function recordPaymentIfAny(student, enrollment) {
      if (perCourseFee <= 0 && perCoursePaid <= 0) return;
      const feeItems = perCourseFee > 0 ? [{ label: 'Course Fee', amount: perCourseFee }] : [{ label: 'Initial payment', amount: perCoursePaid }];
      const payment = await buildPayment(student, enrollment.id, {
        payer: student.name, phone: student.contact,
        course: enrollment.course, tutor: enrollment.teacher,
        classStart: admissionDate || todayISO(), months: 1,
        feeItems, discount: 0, paidAmount: perCoursePaid,
        payDate: admissionDate || todayISO(), method: 'Cash',
        notes: perCourseFee > 0 ? 'Admission fee (Excel import)' : 'Initial payment (Excel import)'
      }, payments, null);
      if (!payment.error) { payments.push(payment); addedPayments.push(payment); }
    }

    if (match) {
      ensureEnrollments(match);
      for (const courseName of courseNames) {
        const already = match.enrollments.some((e) => e.active !== false && e.course.toLowerCase() === courseName.toLowerCase());
        if (already) { skipped.push(`${match.name} — ${courseName} (already enrolled)`); continue; }
        const enrollment = makeEnrollment({
          course: courseName, teacher, classTime, duration: durationRaw, admissionDate
        });
        match.enrollments.push(enrollment);
        addedCourses.push({ student: match, enrollment });
        await recordPaymentIfAny(match, enrollment);
      }
      continue;
    }

    const studentIdRaw = pickField(row, ['student id', 'studentid', 'id', 'roll number', 'roll no']);
    let studentId;
    const customId = String(studentIdRaw || '').trim();
    if (customId && !existingIds.has(customId.toLowerCase())) {
      studentId = customId;
    } else {
      studentId = await getNextStudentId();
    }
    existingIds.add(studentId.toLowerCase());

    const enrollments = courseNames.map((courseName, i) => makeEnrollment({
      id: i === 0 ? 'primary' : undefined,
      course: courseName, teacher, classTime, duration: durationRaw, admissionDate
    }));

    const student = {
      id: crypto.randomUUID(),
      studentId,
      name: String(name).trim(),
      contact: String(contact || '').trim(),
      admissionDate,
      active: true,
      source: 'excel-import',
      enrollments
    };
    syncPrimaryMirror(student);
    students.push(student);
    addedStudents.push(student);
    for (const enrollment of enrollments) await recordPaymentIfAny(student, enrollment);
  }

  return { added: addedStudents, addedCourses, addedPayments, skipped };
}

// Matches a receipt row to a student, by Student ID if given, otherwise by
// name + phone TOGETHER (never name alone) — this is what stops two
// different people who happen to share a name from getting merged, and
// stops a typo'd name with a matching phone from being reported as
// unmatched. If neither matches cleanly, returns null and the row is
// reported as unmatched rather than guessed at.
function findMatchingStudent(row, students) {
  const studentId = String(pickField(row, ['student id', 'studentid']) || '').trim();
  if (studentId) {
    const byId = students.find((s) => (s.studentId || '').toLowerCase() === studentId.toLowerCase());
    if (byId) return byId;
  }

  const payer = String(pickField(row, ['payer']) || '').trim();
  const phoneRaw = String(pickField(row, ['phone']) || '').trim();
  const norm = normalizeName(payer);
  const phone = normalizePhone(phoneRaw);

  const nameMatches = students.filter((s) => normalizeName(s.name) === norm);
  if (nameMatches.length <= 1) return nameMatches[0] || null;
  if (!phone) return null; // multiple same-name students and no phone to tell them apart — don't guess

  const byPhone = nameMatches.filter((s) => normalizePhone(s.contact) === phone);
  return byPhone.length === 1 ? byPhone[0] : null;
}

// Given a matched student and a course name from a receipt row, finds the
// enrollment that course belongs to. Falls back to the student's primary
// enrollment for single-course students / rows with no course column, so
// existing receipts (which never had this problem) keep working exactly as
// before.
function findMatchingEnrollment(student, courseName) {
  ensureEnrollments(student);
  if (student.enrollments.length === 1) return student.enrollments[0];
  const norm = String(courseName || '').trim().toLowerCase();
  if (norm) {
    const byCourse = student.enrollments.find((e) => e.course.trim().toLowerCase() === norm);
    if (byCourse) return byCourse;
  }
  return student.enrollments.find((e) => e.id === 'primary') || student.enrollments[0];
}

// Turns rows from the receipts ledger (Receipt No, Student ID, Payer,
// Phone, Course, Tutor, Schedule, Class Start, Class End, Months,
// Fee Items, Discount, Total Amount, Paid Amount, Balance Due,
// Running Balance, Pay Date, Method, Received By, Notes, Verification
// Code, Timestamp) into payment records, one per COURSE ENROLLMENT.
//
// The ledger sometimes combines two courses into one row, comma-joined in
// the Course column (e.g. "Guitar, Western Vocal") with a single combined
// Total/Paid amount and one shared Tutor — this is what previously credited
// one tutor for a course they didn't teach, and mixed both courses' dues
// into one running balance. Since Sangeet Pathshala charges the same fee
// for the same duration regardless of course, that combined amount is
// split EVENLY across however many courses the row lists, and each split
// becomes its own payment record tied to its own course's enrollment, all
// sharing one receiptGroupId (and a -1/-2 suffixed Receipt No, so the
// dedup-by-receipt-no check below still treats re-imports correctly).
// A row's single Tutor value is applied to every course in the split, since
// the ledger doesn't yet capture a separate tutor per course — this is a
// known gap (see brainstorm notes), not something the split can fix.
//
// Rows that don't match any student, and rows whose Receipt No has already
// been imported, are reported but skipped (this never creates new
// students). Mutates `payments` in place.
function importPaymentRows(rows, students, payments) {
  const existingReceiptNos = new Set(payments.map((p) => p.receiptNo).filter(Boolean));

  const added = [];
  const skippedUnmatched = [];
  const skippedDuplicate = [];
  const skippedUnmatchedCourse = [];

  for (const row of rows) {
    const receiptNo = String(pickField(row, ['receipt no', 'receiptno']) || '').trim();
    if (!receiptNo) continue;
    if (existingReceiptNos.has(receiptNo)) {
      skippedDuplicate.push(receiptNo);
      continue;
    }

    const payer = String(pickField(row, ['payer']) || '').trim();
    const student = findMatchingStudent(row, students);
    if (!student) {
      skippedUnmatched.push(payer || receiptNo);
      continue;
    }

    const courseField = String(pickField(row, ['course']) || '').trim();
    const courseNames = courseField.split(',').map((c) => c.trim()).filter(Boolean);
    if (!courseNames.length) courseNames.push('');
    const n = courseNames.length;

    const classStartRaw = pickField(row, ['class start']);
    const classEndRaw = pickField(row, ['class end']);
    const payDateRaw = pickField(row, ['pay date']);
    const tutor = String(pickField(row, ['tutor']) || '').trim();
    const totalAmount = Number(pickField(row, ['total amount'])) || 0;
    const paidAmount = Number(pickField(row, ['paid amount'])) || 0;
    const discount = Number(pickField(row, ['discount'])) || 0;
    const runningBalanceRaw = Number(pickField(row, ['running balance'])) || 0;
    const groupId = n > 1 ? crypto.randomUUID() : null;

    let rowHadUnmatchedCourse = false;
    const rowPayments = [];

    for (let i = 0; i < n; i++) {
      const courseName = courseNames[i];
      const enrollment = findMatchingEnrollment(student, courseName);
      if (student.enrollments.length > 1 && courseName && enrollment.course.trim().toLowerCase() !== courseName.trim().toLowerCase()) {
        rowHadUnmatchedCourse = true;
        continue; // don't guess — this course doesn't match any of the student's enrollments
      }

      // Even split across the N courses in this row — safe because every
      // course costs the same for the same duration.
      const splitTotal = Math.round((totalAmount / n) * 100) / 100;
      const splitPaid = Math.round((paidAmount / n) * 100) / 100;
      const splitDiscount = Math.round((discount / n) * 100) / 100;

      rowPayments.push({
        id: crypto.randomUUID(),
        receiptNo: n > 1 ? `${receiptNo}-${i + 1}` : receiptNo,
        receiptGroupId: groupId,
        studentId: student.id,
        enrollmentId: enrollment.id,
        studentCode: student.studentId || '',
        payer,
        phone: String(pickField(row, ['phone']) || '').trim(),
        course: courseName || enrollment.course,
        tutor: tutor || enrollment.teacher,
        schedule: String(pickField(row, ['schedule']) || '').trim(),
        classStart: classStartRaw ? excelDateToString(classStartRaw) : '',
        classEnd: classEndRaw ? excelDateToString(classEndRaw) : '',
        months: Number(pickField(row, ['months'])) || null,
        feeItems: String(pickField(row, ['fee items']) || '').trim(),
        discount: splitDiscount,
        totalAmount: splitTotal,
        paidAmount: splitPaid,
        balanceDue: Math.max(splitTotal - splitPaid, 0),
        runningBalance: n > 1 ? Math.round((runningBalanceRaw / n) * 100) / 100 : runningBalanceRaw,
        payDate: payDateRaw ? excelDateToString(payDateRaw) : todayISO(),
        method: String(pickField(row, ['method']) || '').trim() || 'Cash',
        receivedBy: String(pickField(row, ['received by']) || '').trim(),
        notes: String(pickField(row, ['notes']) || '').trim() + (n > 1 ? ` (split ${i + 1}/${n} of combined receipt ${receiptNo})` : ''),
        verificationCode: String(pickField(row, ['verification code']) || '').trim() || generateVerificationCode(),
        timestamp: String(pickField(row, ['timestamp']) || '').trim() || new Date().toISOString(),
        source: 'onedrive-sync'
      });
    }

    if (rowHadUnmatchedCourse) {
      skippedUnmatchedCourse.push(`${payer || receiptNo} (${courseField})`);
      continue; // whole row skipped rather than importing a partial/misattributed split
    }
    if (!rowPayments.length) continue;

    payments.push(...rowPayments);
    existingReceiptNos.add(receiptNo);
    for (const p of rowPayments) existingReceiptNos.add(p.receiptNo);
    added.push(...rowPayments);
  }

  return { added, skippedUnmatched, skippedDuplicate, skippedUnmatchedCourse };
}

app.post('/api/import-excel', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not read the Excel file. Please check the format.' });
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const students = await loadStudentsWithEnrollments();
  const payments = await readJSON(PAYMENTS_FILE, []);
  const { added, addedCourses, addedPayments, skipped } = await importStudentRows(rows, students, payments);
  await writeJSON(STUDENTS_FILE, students);
  await writeJSON(PAYMENTS_FILE, payments);
  res.json({
    addedCount: added.length,
    added,
    addedCoursesCount: addedCourses.length,
    addedCourses: addedCourses.map((x) => ({ student: x.student.name, course: x.enrollment.course })),
    addedPaymentsCount: addedPayments.length,
    addedPayments: addedPayments.map((p) => ({ course: p.course, totalAmount: p.totalAmount, paidAmount: p.paidAmount, balanceDue: p.balanceDue })),
    skippedCount: skipped.length,
    skipped
  });
});

// ---------- OneDrive auto-sync ----------

const SYNC_CONFIG_FILE = path.join(DATA_DIR, 'sync-config.json');
const SYNC_STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');

const DEFAULT_SYNC_CONFIG = {
  studentsUrl: '',
  paymentsUrl: '',
  intervalMinutes: 5,
  enabled: false,
  studentsSinceDate: ''
};

let syncTimer = null;

async function getSyncConfig() {
  return { ...DEFAULT_SYNC_CONFIG, ...(await readJSON(SYNC_CONFIG_FILE, {})) };
}

// Calls a Power Automate "When an HTTP request is received" flow that
// wraps Excel Online's "List rows present in a table" action. Accepts a
// few common response shapes flows tend to send back.
async function fetchRowsFromFlow(url) {
  if (!url) return [];
  // Power Automate's "When an HTTP request is received" trigger expects a
  // POST by default (even with no body needed) — a plain GET gets rejected.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (!res.ok) throw new Error(`Flow request failed (HTTP ${res.status})`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.value)) return data.value;
  if (Array.isArray(data.rows)) return data.rows;
  return [];
}

// Keeps only rows whose Admission Date (or, if present, submission
// Timestamp) is on/after the given cutoff — lets the students sync ignore
// everyone already in the sheet before a chosen day, so only new
// registrations from that point on get pulled in. Rows with no
// recognizable date are excluded, since we can't confirm they're new.
function filterRowsSinceDate(rows, cutoffDate) {
  if (!cutoffDate) return rows;
  return rows.filter((row) => {
    const raw = pickField(row, ['timestamp', 'submitted', 'submission date', 'admission date', 'date of admission', 'joined', 'start date']);
    if (!raw) return false;
    const rowDate = excelDateToString(raw).slice(0, 10);
    if (!rowDate || Number.isNaN(Date.parse(rowDate))) return false;
    return rowDate >= cutoffDate;
  });
}

async function runSync(trigger) {
  const config = await getSyncConfig();
  const result = {
    trigger,
    ranAt: new Date().toISOString(),
    ok: true,
    error: null,
    studentsAdded: 0,
    studentsSkipped: 0,
    coursesAddedToExisting: 0,
    paymentsAdded: 0,
    paymentsSkippedDuplicate: 0,
    paymentsSkippedUnmatched: [],
    paymentsSkippedUnmatchedCourse: []
  };

  try {
    const students = await loadStudentsWithEnrollments();
    if (config.studentsUrl) {
      let rows = await fetchRowsFromFlow(config.studentsUrl);
      rows = filterRowsSinceDate(rows, config.studentsSinceDate);
      const payments = await readJSON(PAYMENTS_FILE, []);
      const { added, addedCourses, addedPayments, skipped } = await importStudentRows(rows, students, payments);
      result.studentsAdded = added.length;
      result.coursesAddedToExisting = addedCourses.length;
      result.studentsSkipped = skipped.length;
      result.paymentsAdded += addedPayments.length;
      await writeJSON(STUDENTS_FILE, students);
      await writeJSON(PAYMENTS_FILE, payments);
    }

    if (config.paymentsUrl) {
      // Re-read so payments can match students that were just added above.
      const latestStudents = await loadStudentsWithEnrollments();
      const payments = await readJSON(PAYMENTS_FILE, []);
      const rows = await fetchRowsFromFlow(config.paymentsUrl);
      const { added, skippedDuplicate, skippedUnmatched, skippedUnmatchedCourse } = importPaymentRows(rows, latestStudents, payments);
      result.paymentsAdded = added.length;
      result.paymentsSkippedDuplicate = skippedDuplicate.length;
      result.paymentsSkippedUnmatched = skippedUnmatched;
      result.paymentsSkippedUnmatchedCourse = skippedUnmatchedCourse;
      await writeJSON(PAYMENTS_FILE, payments);
    }
  } catch (err) {
    result.ok = false;
    result.error = err.message || 'Sync failed.';
  }

  await writeJSON(SYNC_STATUS_FILE, result);
  return result;
}

function scheduleSync(config) {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  if (config.enabled && (config.studentsUrl || config.paymentsUrl)) {
    const ms = Math.max(Number(config.intervalMinutes) || 5, 1) * 60 * 1000;
    syncTimer = setInterval(() => {
      runSync('scheduled').catch((err) => console.error('Scheduled sync failed:', err));
    }, ms);
  }
}

app.get('/api/sync-config', async (req, res) => {
  res.json(await getSyncConfig());
});

app.put('/api/sync-config', async (req, res) => {
  const { studentsUrl, paymentsUrl, intervalMinutes, enabled, studentsSinceDate } = req.body;
  const config = {
    studentsUrl: (studentsUrl || '').trim(),
    paymentsUrl: (paymentsUrl || '').trim(),
    intervalMinutes: Math.max(Number(intervalMinutes) || 5, 1),
    enabled: !!enabled,
    studentsSinceDate: (studentsSinceDate || '').trim()
  };
  await writeJSON(SYNC_CONFIG_FILE, config);
  scheduleSync(config);
  res.json(config);
});

app.get('/api/sync-status', async (req, res) => {
  res.json(await readJSON(SYNC_STATUS_FILE, { ranAt: null }));
});

app.post('/api/sync-now', async (req, res) => {
  try {
    const result = await runSync('manual');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Sync failed.' });
  }
});

// ---------- renewal / warning email alerts (via Power Automate) ----------

const DEFAULT_ALERT_CONFIG = {
  flowUrl: '',
  enabled: false,
  checkIntervalMinutes: 60
};

let alertTimer = null;

async function getAlertConfig() {
  return { ...DEFAULT_ALERT_CONFIG, ...(await readJSON(ALERT_CONFIG_FILE, {})) };
}

// Works out the date the CURRENT outstanding due actually started — i.e. the
// admission date (or renewal date) of the receipt that first left this
// student owing money, walking forward through every receipt since. This is
// deliberately based on the receipts' own payDate, NOT on when a periodic
// check happened to notice it — so the 20-day reminder clock starts from the
// real admission/renewal date even if alerts were off, or the first check
// only ran days later.
//
// If the balance was ever fully cleared and then a new due appeared later
// (e.g. paid off, then didn't pay in full on renewal), this returns the
// start of that newer, still-open episode — not the original one.
function deriveDueSince(payments) {
  const sorted = [...(payments || [])].sort((a, b) => {
    const dateA = a.payDate || '';
    const dateB = b.payDate || '';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return (a.timestamp || '') < (b.timestamp || '') ? -1 : 1;
  });

  let running = 0;
  let episodeStart = null;
  for (const p of sorted) {
    const before = running;
    running += (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0);
    if (before <= 0 && running > 0) {
      episodeStart = p.payDate || null;
    } else if (running <= 0) {
      episodeStart = null;
    }
  }
  return running > 0 ? episodeStart : null;
}

// For every active student, works out where they stand in their CURRENT
// course cycle (since cycleStartDate) and buckets them as "warning" (close
// to running out) or "renewal" (allotment reached/exceeded). Used both to
// decide which emails to send and to show a live status list in the UI.
// Also returns "dues" — every student (active or not) with a net
// outstanding balance right now, computed the same way as the dashboard.
// For every active course ENROLLMENT (not student), works out where it
// stands in its own current cycle (since that enrollment's own
// cycleStartDate) and buckets it as "warning" (close to running out) or
// "renewal" (allotment reached/exceeded). A student with 2 courses is
// evaluated independently for each — Guitar reaching renewal never
// triggers a false renewal alert for Vocals, and vice versa. Also returns
// "dues" — every enrollment (active or not) with its own net outstanding
// balance right now, computed the same way as the dashboard.
async function computeAlertCandidates() {
  const students = await loadStudentsWithEnrollments();
  const attendance = await readJSON(ATTENDANCE_FILE, {});
  const payments = await readJSON(PAYMENTS_FILE, []);

  const warnings = [];
  const renewals = [];
  const dues = [];

  const paymentsByKey = {};
  for (const p of payments) {
    const key = `${p.studentId}::${p.enrollmentId || 'primary'}`;
    paymentsByKey[key] = paymentsByKey[key] || [];
    paymentsByKey[key].push(p);
  }

  for (const s of students) {
    for (const e of s.enrollments) {
      const key = attendanceKeyFor(s.id, e.id);
      const enrollmentPayments = paymentsByKey[`${s.id}::${e.id}`] || [];

      const outstandingBalance = Math.max(
        enrollmentPayments.reduce((sum, p) => sum + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0), 0),
        0
      );
      if (outstandingBalance > 0) {
        dues.push({
          id: s.id,
          enrollmentId: e.id,
          studentId: s.studentId || '',
          name: s.name,
          contact: s.contact || '',
          teacher: e.teacher,
          course: e.course,
          duration: e.duration,
          outstandingBalance,
          dueSince: deriveDueSince(enrollmentPayments)
        });
      }

      if (s.active === false || e.active === false) continue;
      const allotted = classesForDuration(e.duration);
      const warnAt = warnAtForDuration(e.duration);
      if (allotted === null) continue;

      const cycleStart = e.cycleStartDate || e.admissionDate || '0000-01-01';
      const presentDates = [];
      for (const date of Object.keys(attendance)) {
        if (isSaturday(date)) continue;
        const rec = attendance[date];
        if (rec && date >= cycleStart && rec[key]) presentDates.push(date);
      }
      presentDates.sort();
      const present = presentDates.length;
      const finishDate = present >= allotted ? presentDates[allotted - 1] : null;

      const item = {
        id: s.id,
        enrollmentId: e.id,
        studentId: s.studentId || '',
        name: s.name,
        contact: s.contact || '',
        teacher: e.teacher,
        course: e.course,
        duration: e.duration,
        cycleStartDate: cycleStart,
        present,
        allotted,
        remaining: Math.max(0, allotted - present),
        finishDate
      };

      if (present >= allotted) renewals.push(item);
      else if (warnAt !== null && present >= warnAt) warnings.push(item);
    }
  }

  return { warnings, renewals, dues };
}

// Posts one alert at a time to a Power Automate "When an HTTP request is
// received" flow, which is responsible for actually sending the email
// (e.g. via an Office 365 Outlook "Send an email (V2)" action to the admin).
async function sendAlertToFlow(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (err) {
    console.error('Alert email flow call failed:', err.message);
    return false;
  }
}

// Sends at most ONE warning email and ONE renewal email per student per
// course cycle. Tracking resets automatically when a student renews (their
// cycleStartDate changes), so the same alerts fire again next cycle.
function escapeHtmlServer(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Formats an ISO date (YYYY-MM-DD) as e.g. "9 Jul 2026" for display in emails.
function formatDateForEmail(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Builds a self-contained, inline-styled HTML email (navy/gold, matching the
// school's brand) for a single warning or renewal alert. Inline styles are
// used throughout since Gmail/Outlook strip <style> blocks unpredictably.
function buildAlertEmailHtml({ type, name, studentId, course, teacher, contact, duration, present, allotted, remaining, finishDate, outstandingBalance, dueSince, daysSince }) {
  const isRenewal = type === 'renewal';
  const isDue = type === 'due';
  const isDueReminder = type === 'due-reminder';

  let accent, accentBg, bannerText, headline, bodyLine, actionLine;

  if (isDue || isDueReminder) {
    accent = '#b8791f';
    accentBg = '#fdf3e2';
    bannerText = isDueReminder ? 'PAYMENT STILL DUE' : 'PAYMENT DUE';
    const amount = `Rs. ${Number(outstandingBalance || 0).toLocaleString()}`;
    headline = isDueReminder
      ? `${escapeHtmlServer(name)}'s balance is still unpaid after ${daysSince} days.`
      : `${escapeHtmlServer(name)} has an outstanding balance.`;
    bodyLine = isDueReminder
      ? `A due of <strong>${amount}</strong> has been outstanding since <strong>${escapeHtmlServer(formatDateForEmail(dueSince) || '—')}</strong> on their <strong>${escapeHtmlServer(duration || '—')}</strong> ${escapeHtmlServer(course)} course.`
      : `A due of <strong>${amount}</strong> was just recorded on their <strong>${escapeHtmlServer(duration || '—')}</strong> ${escapeHtmlServer(course)} course.`;
    actionLine = isDueReminder
      ? 'Action needed &mdash; this due has been pending for over 20 days.'
      : 'No action needed yet &mdash; just a record of the new due.';
  } else if (isRenewal) {
    accent = '#b91c1c';
    accentBg = '#fdecec';
    bannerText = 'RENEWAL REQUIRED';
    headline = `${escapeHtmlServer(name)}'s course cycle is complete.`;
    bodyLine = `This student has attended <strong>${present} of ${allotted}</strong> classes on their <strong>${escapeHtmlServer(duration)}</strong> ${escapeHtmlServer(course)} course and is now due for renewal.`;
    actionLine = 'Action needed &mdash; please contact the student to arrange renewal.';
  } else {
    accent = '#c9822a';
    accentBg = '#fdf3e2';
    bannerText = 'ATTENDANCE ALERT';
    headline = `${escapeHtmlServer(name)}'s classes are almost over.`;
    bodyLine = `This student has attended <strong>${present} of ${allotted}</strong> classes on their <strong>${escapeHtmlServer(duration)}</strong> ${escapeHtmlServer(course)} course, with <strong>${remaining}</strong> class${remaining === 1 ? '' : 'es'} remaining.`;
    actionLine = 'No action needed yet &mdash; just a heads-up ahead of renewal.';
  }

  const row = (label, value) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;color:#8a8578;font-size:13px;width:38%;">${escapeHtmlServer(label)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;color:#2b2b2b;">${value}</td>
    </tr>`;

  const classRows = (isDue || isDueReminder) ? '' : `
    <tr>
      <td style="padding:8px 0;${isRenewal && finishDate ? 'border-bottom:1px solid #eee;' : ''}color:#8a8578;font-size:13px;">Classes attended</td>
      <td style="padding:8px 0;${isRenewal && finishDate ? 'border-bottom:1px solid #eee;' : ''}font-size:14px;color:${accent};font-weight:700;">${present} / ${allotted}</td>
    </tr>
    ${isRenewal && finishDate ? `
    <tr>
      <td style="padding:8px 0;color:#8a8578;font-size:13px;">Class finished on</td>
      <td style="padding:8px 0;font-size:14px;color:#2b2b2b;font-weight:700;">${escapeHtmlServer(formatDateForEmail(finishDate))}</td>
    </tr>` : ''}
  `;

  const dueRows = (isDue || isDueReminder) ? `
    <tr>
      <td style="padding:8px 0;${isDueReminder ? 'border-bottom:1px solid #eee;' : ''}color:#8a8578;font-size:13px;">Outstanding due</td>
      <td style="padding:8px 0;${isDueReminder ? 'border-bottom:1px solid #eee;' : ''}font-size:14px;color:${accent};font-weight:700;">Rs. ${Number(outstandingBalance || 0).toLocaleString()}</td>
    </tr>
    ${isDueReminder ? `
    <tr>
      <td style="padding:8px 0;color:#8a8578;font-size:13px;">Due since</td>
      <td style="padding:8px 0;font-size:14px;color:#2b2b2b;font-weight:700;">${escapeHtmlServer(formatDateForEmail(dueSince) || '—')}</td>
    </tr>` : ''}
  ` : '';

  return `<div style="font-family:Georgia,'Times New Roman',serif;background:#f4ede1;padding:32px 16px;margin:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e3d9c4;">
    <tr>
      <td style="background:#152238;padding:24px 32px;">
        <div style="color:#e7c873;font-family:Arial,Helvetica,sans-serif;letter-spacing:2px;font-size:12px;font-weight:700;text-transform:uppercase;">Sangeet Pathshala</div>
        <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:6px;">${bannerText}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px 0;font-size:15px;color:#2b2b2b;">Dear Administrator,</p>
        <p style="margin:0 0 22px 0;font-size:15px;color:#2b2b2b;line-height:1.6;">${headline} ${bodyLine}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px;">
          ${row('Student', `${escapeHtmlServer(name)} (${escapeHtmlServer(studentId || '—')})`)}
          ${row('Course', escapeHtmlServer(course))}
          ${row('Teacher', escapeHtmlServer(teacher))}
          ${row('Contact', escapeHtmlServer(contact || '—'))}
          ${row('Duration', escapeHtmlServer(duration || '—'))}
          ${classRows}
          ${dueRows}
        </table>
        <div style="background:${accentBg};border-left:4px solid ${accent};padding:12px 16px;border-radius:4px;">
          <span style="font-size:13px;color:${accent};font-weight:700;">${actionLine}</span>
        </div>
        <p style="margin:28px 0 0 0;font-size:12px;color:#8a8578;">Sent automatically by the Sangeet Pathshala Attendance System.</p>
      </td>
    </tr>
  </table>
</div>`;
}

async function checkAndSendAlerts(trigger) {
  const config = await getAlertConfig();
  const result = {
    trigger,
    ranAt: new Date().toISOString(),
    ok: true,
    error: null,
    warningsSent: 0,
    renewalsSent: 0,
    duesSent: 0,
    dueRemindersSent: 0
  };

  if (!config.enabled || !config.flowUrl) {
    result.ok = false;
    result.error = 'Alerts are not turned on, or no flow URL is set.';
    return result;
  }

  try {
    const { warnings, renewals, dues } = await computeAlertCandidates();
    const state = await readJSON(ALERT_STATE_FILE, {});

    // Preserves any existing fields (e.g. due-tracking) on an enrollment's
    // state entry when its course-cycle tracking resets — only the
    // cycle-scoped warning/renewal flags get wiped, since dues aren't tied
    // to a course cycle. Keyed by student+enrollment (not just student) so
    // a 2-course student's Guitar and Vocals alerts are tracked, and can
    // fire, completely independently of each other.
    const stateKeyFor = (item) => `${item.id}::${item.enrollmentId || 'primary'}`;
    const trackFor = (item) => {
      const existing = state[stateKeyFor(item)];
      if (existing && existing.cycleStartDate === item.cycleStartDate) return existing;
      return { ...(existing || {}), cycleStartDate: item.cycleStartDate, warningSent: false, renewalSent: false };
    };

    for (const item of renewals) {
      const track = trackFor(item);
      if (!track.renewalSent) {
        const ok = await sendAlertToFlow(config.flowUrl, {
          alertType: 'renewal',
          studentName: item.name,
          studentId: item.studentId,
          course: item.course,
          teacher: item.teacher,
          contact: item.contact,
          duration: item.duration,
          classesAttended: item.present,
          classesAllotted: item.allotted,
          classesRemaining: 0,
          classFinishedDate: item.finishDate || '',
          subject: `Renewal needed: ${item.name} has finished their ${item.duration} course`,
          message: `${item.name} (${item.studentId || 'no ID'}) has attended ${item.present}/${item.allotted} classes on the ${item.duration} ${item.course} course and is due for renewal.`,
          htmlMessage: buildAlertEmailHtml({
            type: 'renewal',
            name: item.name,
            studentId: item.studentId,
            course: item.course,
            teacher: item.teacher,
            contact: item.contact,
            duration: item.duration,
            present: item.present,
            allotted: item.allotted,
            remaining: 0,
            finishDate: item.finishDate
          })
        });
        if (ok) { track.renewalSent = true; result.renewalsSent += 1; }
      }
      state[stateKeyFor(item)] = track;
    }

    for (const item of warnings) {
      const track = trackFor(item);
      if (!track.warningSent) {
        const ok = await sendAlertToFlow(config.flowUrl, {
          alertType: 'warning',
          studentName: item.name,
          studentId: item.studentId,
          course: item.course,
          teacher: item.teacher,
          contact: item.contact,
          duration: item.duration,
          classesAttended: item.present,
          classesAllotted: item.allotted,
          classesRemaining: item.remaining,
          subject: `Heads up: ${item.name}'s classes are almost over`,
          message: `${item.name} (${item.studentId || 'no ID'}) has attended ${item.present}/${item.allotted} classes on the ${item.duration} ${item.course} course — only ${item.remaining} left.`,
          htmlMessage: buildAlertEmailHtml({
            type: 'warning',
            name: item.name,
            studentId: item.studentId,
            course: item.course,
            teacher: item.teacher,
            contact: item.contact,
            duration: item.duration,
            present: item.present,
            allotted: item.allotted,
            remaining: item.remaining
          })
        });
        if (ok) { track.warningSent = true; result.warningsSent += 1; }
      }
      state[stateKeyFor(item)] = track;
    }

    // ---------- payment due alerts ----------
    // One "due recorded" email the moment a due first appears, then one
    // follow-up reminder if it's STILL unpaid 20 days later. The 20-day
    // clock is anchored to item.dueSince — the actual admission/renewal
    // receipt date that created the shortfall (see deriveDueSince) — NOT to
    // whenever this check happens to run. So it's correct even if alerts
    // were off, or the first check only ran days after admission.
    const DUE_FOLLOWUP_DAYS = 20;
    const todayStr = todayISO();
    const dueIdsThisRun = new Set(dues.map((item) => stateKeyFor(item)));

    for (const item of dues) {
      if (!item.dueSince) continue; // no receipt date to anchor to — skip rather than guess

      const existing = state[stateKeyFor(item)] || {};
      // A new due episode (this dueSince differs from the one we were last
      // tracking, e.g. an old due was fully paid off and a new one started
      // at a later renewal) resets both "sent" flags so it gets its own
      // fresh immediate + 20-day-reminder cycle.
      const track = existing.dueSince === item.dueSince
        ? existing
        : { ...existing, dueSince: item.dueSince, dueInitialSent: false, dueFollowUpSent: false };

      if (!track.dueInitialSent) {
        const ok = await sendAlertToFlow(config.flowUrl, {
          alertType: 'due',
          studentName: item.name,
          studentId: item.studentId,
          course: item.course,
          teacher: item.teacher,
          contact: item.contact,
          duration: item.duration,
          outstandingBalance: item.outstandingBalance,
          dueSince: item.dueSince,
          subject: `Payment due: ${item.name} has an outstanding balance of Rs. ${item.outstandingBalance.toLocaleString()}`,
          message: `${item.name} (${item.studentId || 'no ID'}) has an outstanding balance of Rs. ${item.outstandingBalance.toLocaleString()} on their ${item.duration || ''} ${item.course} course, since ${item.dueSince}.`,
          htmlMessage: buildAlertEmailHtml({
            type: 'due',
            name: item.name,
            studentId: item.studentId,
            course: item.course,
            teacher: item.teacher,
            contact: item.contact,
            duration: item.duration,
            outstandingBalance: item.outstandingBalance,
            dueSince: item.dueSince
          })
        });
        if (ok) { track.dueInitialSent = true; result.duesSent += 1; }
      } else if (!track.dueFollowUpSent) {
        const daysSince = Math.floor(
          (Date.parse(todayStr) - Date.parse(item.dueSince)) / (24 * 60 * 60 * 1000)
        );
        if (daysSince >= DUE_FOLLOWUP_DAYS) {
          const ok = await sendAlertToFlow(config.flowUrl, {
            alertType: 'due-reminder',
            studentName: item.name,
            studentId: item.studentId,
            course: item.course,
            teacher: item.teacher,
            contact: item.contact,
            duration: item.duration,
            outstandingBalance: item.outstandingBalance,
            dueSince: item.dueSince,
            daysSince,
            subject: `Still unpaid: ${item.name}'s Rs. ${item.outstandingBalance.toLocaleString()} due after ${daysSince} days`,
            message: `${item.name} (${item.studentId || 'no ID'}) still owes Rs. ${item.outstandingBalance.toLocaleString()} — outstanding since ${item.dueSince} (${daysSince} days).`,
            htmlMessage: buildAlertEmailHtml({
              type: 'due-reminder',
              name: item.name,
              studentId: item.studentId,
              course: item.course,
              teacher: item.teacher,
              contact: item.contact,
              duration: item.duration,
              outstandingBalance: item.outstandingBalance,
              dueSince: item.dueSince,
              daysSince
            })
          });
          if (ok) { track.dueFollowUpSent = true; result.dueRemindersSent += 1; }
        }
      }
      state[stateKeyFor(item)] = track;
    }

    // Clear due tracking for anyone who's fully paid off (not in this run's
    // dues list) so a future due for them starts a fresh 0/20-day cycle.
    for (const id of Object.keys(state)) {
      if (state[id].dueSince && !dueIdsThisRun.has(id)) {
        delete state[id].dueSince;
        delete state[id].dueInitialSent;
        delete state[id].dueFollowUpSent;
      }
    }

    await writeJSON(ALERT_STATE_FILE, state);
  } catch (err) {
    result.ok = false;
    result.error = err.message || 'Alert check failed.';
  }

  await writeJSON(ALERT_STATUS_FILE, result);
  return result;
}

function scheduleAlertCheck(config) {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = null;
  if (config.enabled && config.flowUrl) {
    const ms = Math.max(Number(config.checkIntervalMinutes) || 60, 5) * 60 * 1000;
    alertTimer = setInterval(() => {
      checkAndSendAlerts('scheduled').catch((err) => console.error('Scheduled alert check failed:', err));
    }, ms);
  }
}

app.get('/api/alert-config', async (req, res) => {
  res.json(await getAlertConfig());
});

app.put('/api/alert-config', async (req, res) => {
  const { flowUrl, enabled, checkIntervalMinutes } = req.body;
  const config = {
    flowUrl: (flowUrl || '').trim(),
    enabled: !!enabled,
    checkIntervalMinutes: Math.max(Number(checkIntervalMinutes) || 60, 5)
  };
  await writeJSON(ALERT_CONFIG_FILE, config);
  scheduleAlertCheck(config);
  res.json(config);
});

// Live snapshot (doesn't send anything) — powers the Alerts tab list so
// Pramod can see who's close to/over their allotment right now.
app.get('/api/alerts/status', async (req, res) => {
  const [candidates, lastRun] = await Promise.all([
    computeAlertCandidates(),
    readJSON(ALERT_STATUS_FILE, { ranAt: null })
  ]);
  res.json({ ...candidates, lastRun });
});

app.post('/api/alerts/check-now', async (req, res) => {
  const result = await checkAndSendAlerts('manual');
  res.json(result);
});

backfillStudentIds()
  .catch((err) => console.error('Student ID backfill failed:', err))
  .then(() => getSyncConfig())
  .then((config) => scheduleSync(config))
  .catch((err) => console.error('Could not start sync scheduler:', err))
  .then(() => getAlertConfig())
  .then((config) => scheduleAlertCheck(config))
  .catch((err) => console.error('Could not start alert scheduler:', err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Sangeet Pathshala attendance tracker running at http://localhost:${PORT}`);
    });
  });

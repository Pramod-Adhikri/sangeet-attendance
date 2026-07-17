// ---------- nav / tabs ----------

const pageTitles = {
  rollcall: { eyebrow: 'Today', title: 'Roll Call' },
  students: { eyebrow: 'Register', title: 'Students' },
  dashboard: { eyebrow: 'Full record', title: 'Dashboard' },
  teachers: { eyebrow: 'Directory', title: 'Teachers' },
  sync: { eyebrow: 'OneDrive', title: 'Sync' },
  alerts: { eyebrow: 'Email', title: 'Alerts' }
};

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.topbar-controls').forEach((c) => (c.hidden = true));

    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`${tab}-controls`).hidden = false;

    document.getElementById('page-eyebrow').textContent = pageTitles[tab].eyebrow;
    document.getElementById('page-title').textContent = pageTitles[tab].title;

    if (tab === 'students') loadStudents();
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'teachers') loadTeachers();
    if (tab === 'sync') loadSyncTab();
    if (tab === 'alerts') loadAlertsTab();
  });
});

function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------- BS (Bikram Sambat) date conversion ----------
//
// Every date is still STORED and sent to the server in AD/Gregorian
// (yyyy-mm-dd) exactly as before — attendance keys, cycle math, and sorting
// all stay untouched and safe. Only the UI layer changes: every date a
// person types or reads is in BS, converted to/from AD right at the edge
// (just before a fetch() call, and right after data comes back for
// display), using the vendored nepali-date-converter library.
const NepaliDateCtor = window.NepaliDate && window.NepaliDate.default;

// AD "yyyy-mm-dd" -> BS "yyyy-mm-dd" for display. Falls back to showing the
// original string if the input is missing/unparseable, rather than crashing
// or silently showing a blank date.
function adToBs(adIso) {
  if (!adIso || !NepaliDateCtor) return adIso || '';
  const m = String(adIso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return adIso;
  try {
    const nd = new NepaliDateCtor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return nd.format('YYYY-MM-DD');
  } catch (err) {
    return adIso;
  }
}

// BS "yyyy-mm-dd" (typed by a person) -> AD "yyyy-mm-dd" for the server.
// Returns '' for empty/invalid input so callers can treat it the same way
// an empty native date input used to behave.
function bsToAd(bsStr) {
  if (!bsStr || !NepaliDateCtor) return '';
  try {
    const nd = new NepaliDateCtor(String(bsStr).trim());
    const jsDate = nd.toJsDate();
    if (isNaN(jsDate.getTime())) return '';
    const mm = String(jsDate.getMonth() + 1).padStart(2, '0');
    const dd = String(jsDate.getDate()).padStart(2, '0');
    return `${jsDate.getFullYear()}-${mm}-${dd}`;
  } catch (err) {
    return '';
  }
}

function bsTodayIso() {
  if (!NepaliDateCtor) return todayISO();
  return new NepaliDateCtor().format('YYYY-MM-DD');
}

// ---------- BS calendar popover (native-picker look, BS calendar) ----------
//
// Browsers have no built-in BS calendar, so this replicates the native
// date-picker's look (month/year header, up/down to page months, a day
// grid with greyed-out spillover from neighbouring months, Clear/Today
// links) but computes everything against the BS calendar using the
// vendored library's own month-length table, so leap/short months are
// exactly right rather than assumed.
const BS_MONTH_NAMES = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Aswin', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
const BS_WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function daysInBsMonth(year, monthIdx) {
  const map = window.NepaliDate && window.NepaliDate.dateConfigMap;
  const yearData = map && map[String(year)];
  return (yearData && yearData[BS_MONTH_NAMES[monthIdx]]) || 30;
}

function parseBsParts(bsStr) {
  const m = String(bsStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };
}

function bsPartsToString(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Attaches a click-to-open calendar popover to one BS date input. Typing
// directly still works exactly as before (and still updates the AD hint);
// this just adds a point-and-click option on top, so a person isn't forced
// to remember today's BS date off the top of their head.
function initBsDatePicker(input) {
  if (input.dataset.pickerAttached) return;
  input.dataset.pickerAttached = '1';

  const wrap = document.createElement('div');
  wrap.className = 'bs-datepicker-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.className = 'bs-datepicker-icon';
  iconBtn.setAttribute('aria-label', 'Open calendar');
  iconBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
  wrap.appendChild(iconBtn);

  const popover = document.createElement('div');
  popover.className = 'bs-datepicker-popover';
  popover.hidden = true;
  wrap.appendChild(popover);

  let viewYear, viewMonth;

  function currentParts() {
    return parseBsParts(input.value) || parseBsParts(bsTodayIso());
  }

  function render() {
    const selected = parseBsParts(input.value);
    const todayParts = parseBsParts(bsTodayIso());
    const daysThis = daysInBsMonth(viewYear, viewMonth);
    const firstDow = (() => {
      try { return new NepaliDateCtor(bsPartsToString(viewYear, viewMonth, 1)).getDay(); } catch (e) { return 0; }
    })();

    let prevYear = viewYear, prevMonth = viewMonth - 1;
    if (prevMonth < 0) { prevMonth = 11; prevYear -= 1; }
    const daysPrev = daysInBsMonth(prevYear, prevMonth);

    let nextYear = viewYear, nextMonth = viewMonth + 1;
    if (nextMonth > 11) { nextMonth = 0; nextYear += 1; }

    const cells = [];
    for (let i = firstDow - 1; i >= 0; i--) cells.push({ day: daysPrev - i, muted: true });
    for (let d = 1; d <= daysThis; d++) cells.push({ day: d, muted: false });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const nextIdx = cells.length - (firstDow + daysThis) + 1;
      cells.push({ day: nextIdx, muted: true });
      if (cells.length >= 42) break;
    }

    const weekdayRow = BS_WEEKDAY_NAMES.map((w) => `<div class="bs-dp-weekday">${w}</div>`).join('');
    const dayRows = cells.map((c) => {
      const isSelected = !c.muted && selected && selected.year === viewYear && selected.month === viewMonth && selected.day === c.day;
      const isToday = !c.muted && todayParts && todayParts.year === viewYear && todayParts.month === viewMonth && todayParts.day === c.day;
      const cls = ['bs-dp-day'];
      if (c.muted) cls.push('muted');
      if (isSelected) cls.push('selected');
      if (isToday && !isSelected) cls.push('today');
      return `<button type="button" class="${cls.join(' ')}" data-day="${c.day}" data-muted="${c.muted}">${c.day}</button>`;
    }).join('');

    popover.innerHTML = `
      <div class="bs-dp-header">
        <span class="bs-dp-month-label">${BS_MONTH_NAMES[viewMonth]} ${viewYear}</span>
        <span class="bs-dp-nav">
          <button type="button" class="bs-dp-nav-btn" data-nav="prev" title="Previous month">&#8593;</button>
          <button type="button" class="bs-dp-nav-btn" data-nav="next" title="Next month">&#8595;</button>
        </span>
      </div>
      <div class="bs-dp-grid">${weekdayRow}${dayRows}</div>
      <div class="bs-dp-footer">
        <button type="button" class="bs-dp-link" data-action="clear">Clear</button>
        <button type="button" class="bs-dp-link" data-action="today">Today</button>
      </div>
    `;

    popover.querySelectorAll('.bs-dp-day:not([data-muted="true"])').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = bsPartsToString(viewYear, viewMonth, Number(btn.dataset.day));
        updateBsHint(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        closePopover();
      });
    });
    popover.querySelector('[data-nav="prev"]').addEventListener('click', () => {
      viewMonth -= 1;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      render();
    });
    popover.querySelector('[data-nav="next"]').addEventListener('click', () => {
      viewMonth += 1;
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      render();
    });
    popover.querySelector('[data-action="clear"]').addEventListener('click', () => {
      input.value = '';
      updateBsHint(input);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closePopover();
    });
    popover.querySelector('[data-action="today"]').addEventListener('click', () => {
      input.value = bsTodayIso();
      updateBsHint(input);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closePopover();
    });
  }

  function openPopover() {
    const parts = currentParts() || parseBsParts(bsTodayIso());
    viewYear = parts.year;
    viewMonth = parts.month;
    render();
    popover.hidden = false;
    document.addEventListener('click', outsideClickHandler, true);
  }

  function closePopover() {
    popover.hidden = true;
    document.removeEventListener('click', outsideClickHandler, true);
  }

  function outsideClickHandler(e) {
    if (!wrap.contains(e.target)) closePopover();
  }

  iconBtn.addEventListener('click', () => {
    if (popover.hidden) openPopover(); else closePopover();
  });
  input.addEventListener('focus', () => {
    if (popover.hidden) openPopover();
  });
}

// Every BS date-entry field gets a small live "AD: ..." caption underneath
// so a mistyped or ambiguous BS date is easy to catch — this is the only
// safety net now that dates are typed as text rather than picked from a
// native calendar (which has no BS mode in any browser).
function updateBsHint(input) {
  let hint = input._bsHintEl;
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'bs-date-hint';
    input._bsHintEl = hint;
    // If the calendar picker has already wrapped this input in
    // .bs-datepicker-wrap, the caption goes right after that whole wrap
    // (reads as one caption under the input+icon+popover control);
    // otherwise it just goes after the bare input, same as before.
    const wrap = input.closest('.bs-datepicker-wrap');
    (wrap || input).insertAdjacentElement('afterend', hint);
  }
  const ad = bsToAd(input.value);
  hint.textContent = input.value ? (ad ? `AD: ${ad}` : 'AD: —') : '';
}

// Re-syncs every BS date field's little "AD: ..." caption — needed after
// JS sets a field's value directly (e.g. opening a modal with a default
// date), since that doesn't fire the input/change events the live listener
// below relies on.
function refreshAllBsHints() {
  document.querySelectorAll('.bs-date-input').forEach(updateBsHint);
}

function attachBsDateHints() {
  document.querySelectorAll('.bs-date-input').forEach((input) => {
    if (input.dataset.hintAttached) return;
    input.dataset.hintAttached = '1';
    updateBsHint(input);
    input.addEventListener('input', () => updateBsHint(input));
    input.addEventListener('change', () => updateBsHint(input));
    initBsDatePicker(input);
  });
}
document.addEventListener('DOMContentLoaded', attachBsDateHints);

// ---------- roll call ----------

const dateInput = document.getElementById('rollcall-date');
dateInput.value = bsTodayIso();

// Roll Call's date input is typed in BS, but attendance is still stored and
// keyed by AD date on the server exactly as before — this converts at the
// boundary, right before any fetch. Falls back to today's AD date if the
// typed BS value doesn't parse, so a bad date never silently 404s.
function rollCallAdDate() {
  return bsToAd(dateInput.value) || todayISO();
}

function isSaturdayStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return false;
  return new Date(y, m - 1, d).getDay() === 6;
}

const rollcallEmptyDefaultHtml = document.getElementById('rollcall-empty').innerHTML;

async function loadRollCall() {
  const groupsEl = document.getElementById('rollcall-groups');
  const emptyEl = document.getElementById('rollcall-empty');
  const saveBtn = document.getElementById('save-attendance');
  const adDate = rollCallAdDate();

  if (isSaturdayStr(adDate)) {
    groupsEl.innerHTML = '';
    emptyEl.innerHTML = '<p>Saturday is a holiday — no classes are held.</p><p class="empty-sub">There\'s nothing to mark attendance for on this date.</p>';
    emptyEl.hidden = false;
    saveBtn.disabled = true;
    updateLiveChip(0, 0);
    return;
  }
  saveBtn.disabled = false;
  emptyEl.innerHTML = rollcallEmptyDefaultHtml;

  const [studentsRes, attendanceRes] = await Promise.all([
    fetch('/api/students'),
    fetch(`/api/attendance/${adDate}`)
  ]);
  const students = await studentsRes.json();
  const attendance = await attendanceRes.json();

  groupsEl.innerHTML = '';

  const teacherFilter = document.getElementById('rollcall-teacher-filter').value;

  // One roster ROW per active course enrollment, not per student — a
  // 2-course student contributes a row under each of their teachers,
  // each checked/saved independently via its own attendance key.
  const active = [];
  for (const s of students) {
    if (s.active === false) continue;
    const enrollments = Array.isArray(s.enrollments) && s.enrollments.length
      ? s.enrollments
      : [{ id: 'primary', course: s.course, teacher: s.teacher, duration: s.duration, active: true }];
    for (const e of enrollments) {
      if (e.active === false) continue;
      if (teacherFilter && e.teacher !== teacherFilter) continue;
      const attendanceKey = e.id === 'primary' ? s.id : `${s.id}::${e.id}`;
      active.push({
        attendanceKey,
        name: s.name,
        studentId: s.studentId,
        teacher: e.teacher || 'Unassigned',
        course: e.course || 'Unassigned',
        duration: e.duration
      });
    }
  }

  if (active.length === 0) {
    emptyEl.hidden = false;
    updateLiveChip(0, 0);
    return;
  }
  emptyEl.hidden = true;

  const byTeacher = {};
  for (const row of active) {
    byTeacher[row.teacher] = byTeacher[row.teacher] || {};
    byTeacher[row.teacher][row.course] = byTeacher[row.teacher][row.course] || [];
    byTeacher[row.teacher][row.course].push(row);
  }

  for (const teacher of Object.keys(byTeacher).sort()) {
    const teacherTotal = Object.values(byTeacher[teacher]).reduce((sum, arr) => sum + arr.length, 0);

    const card = document.createElement('div');
    card.className = 'teacher-card';

    const ribbon = document.createElement('div');
    ribbon.className = 'teacher-ribbon';
    const teacherInfo = TEACHERS.find((t) => t.name === teacher);
    const scheduleText = teacherInfo ? `${teacherInfo.days}, ${teacherInfo.time}` : '';
    ribbon.innerHTML = `<span class="t-name">${escapeHtml(teacher)}</span><span class="t-schedule">${escapeHtml(scheduleText)}</span><span class="t-count">${teacherTotal} student${teacherTotal === 1 ? '' : 's'}</span>`;
    card.appendChild(ribbon);

    for (const course of Object.keys(byTeacher[teacher]).sort()) {
      const block = document.createElement('div');
      block.className = 'course-block';

      const label = document.createElement('div');
      label.className = 'course-label';
      label.textContent = course;
      block.appendChild(label);

      for (const row of byTeacher[teacher][course]) {
        const rowEl = document.createElement('label');
        rowEl.className = 'student-row';
        const checked = attendance[row.attendanceKey] ? 'checked' : '';
        rowEl.innerHTML = `
          <span class="tick-box">
            <input type="checkbox" data-student-id="${row.attendanceKey}" ${checked} />
            <span class="tick-visual"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6"/></svg></span>
          </span>
          <span class="s-name">${escapeHtml(row.name)}${row.studentId ? ` <span class="s-id">${escapeHtml(row.studentId)}</span>` : ''}</span>
          <span class="s-duration">${escapeHtml(row.duration || '')}</span>
        `;
        block.appendChild(rowEl);
      }
      card.appendChild(block);
    }
    groupsEl.appendChild(card);
  }

  updateLiveChip(countChecked(), active.length);
}

function countChecked() {
  return document.querySelectorAll('#rollcall-groups input[type="checkbox"]:checked').length;
}

function updateLiveChip(marked, total) {
  document.getElementById('live-chip').textContent = `${marked} / ${total} marked`;
}

document.addEventListener('change', (e) => {
  if (e.target.matches('#rollcall-groups input[type="checkbox"]')) {
    const total = document.querySelectorAll('#rollcall-groups input[type="checkbox"]').length;
    updateLiveChip(countChecked(), total);
  }
});

dateInput.addEventListener('change', loadRollCall);

document.getElementById('save-attendance').addEventListener('click', async () => {
  const statusEl = document.getElementById('rollcall-status');
  const adDate = rollCallAdDate();
  if (isSaturdayStr(adDate)) {
    statusEl.textContent = 'Saturday is a holiday — attendance cannot be recorded for this date.';
    statusEl.classList.add('error');
    return;
  }
  const records = {};
  document.querySelectorAll('#rollcall-groups input[type="checkbox"]').forEach((cb) => {
    records[cb.dataset.studentId] = cb.checked;
  });
  try {
    const res = await fetch(`/api/attendance/${adDate}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records })
    });
    if (!res.ok) throw new Error('Save failed');
    statusEl.textContent = `Saved attendance for ${dateInput.value} BS (${adDate} AD).`;
    statusEl.classList.remove('error');
  } catch (err) {
    statusEl.textContent = 'Could not save attendance. Check the server is running.';
    statusEl.classList.add('error');
  }
});

// ---------- teacher roster (fixed — not editable from the UI) ----------

const TEACHERS = [
  { name: 'Shiva Shrestha', instrument: 'Vocal', days: 'Sun, Wed, Fri', time: '11am – 2pm', contact: '9851108998' },
  { name: 'Manjil Lama', instrument: 'Vocal', days: 'Mon, Tue, Thurs', time: '11am – 7pm', contact: '9818927926' },
  { name: 'Rojan Ranjit', instrument: 'Guitar', days: 'Sun, Wed, Fri', time: '12pm – 7pm', contact: '9823546545' },
  { name: 'Pravesh Thapa', instrument: 'Guitar', days: 'Mon, Tue, Thurs', time: '11am – 6pm', contact: '9861686011' },
  { name: 'Sishir Lama', instrument: 'Guitar', days: 'Mon, Tue, Thurs', time: '11am – 6pm', contact: '9861062157' },
  { name: 'Sanjil Nepali', instrument: 'Guitar', days: 'Sun – Fri (6 days)', time: '8am – 8pm', contact: '9805175659' },
  { name: 'Prajwol Sijapati', instrument: 'Keyboard', days: 'Sun, Tue, Thurs', time: '2pm – 7pm', contact: '9864642640' },
  { name: 'Aayush Tiwari', instrument: 'Drums', days: 'Mon, Tue, Thurs', time: '11am – 6pm', contact: '9808392447' },
  { name: 'Parash Thapa Magar', instrument: 'Drums', days: 'Sun, Wed, Fri', time: '1pm – 6pm', contact: '9810117438' },
  { name: 'Yagya Lama', instrument: 'Bass Guitar', days: 'Sun, Wed, Fri', time: '4pm – 7pm', contact: '9828948293' }
];

const COURSES = [
  'Guitar',
  'Bass Guitar',
  'Keyboard',
  'Drum',
  'Western Vocal',
  'Eastern Vocal',
  'Music Production'
];

function parseHour12(token) {
  const m = token.trim().match(/^(\d{1,2})\s*(am|pm)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[2].toLowerCase() === 'pm') hour += 12;
  return hour;
}

function formatHour12(hour24) {
  const h = ((hour24 % 24) + 24) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  let display = h % 12;
  if (display === 0) display = 12;
  return `${display} ${period}`;
}

// Splits a teacher's overall window (e.g. "11am – 2pm") into individual
// 1-hour class slots: 11-12, 12-1, 1-2, etc.
function generateSlots(timeRange) {
  const parts = timeRange.split('–').map((p) => p.trim());
  if (parts.length !== 2) return [];
  const start = parseHour12(parts[0]);
  const end = parseHour12(parts[1]);
  if (start === null || end === null) return [];
  const slots = [];
  let h = start;
  while (h !== end) {
    const next = (h + 1) % 24;
    slots.push({
      value: `${String(h).padStart(2, '0')}:00-${String(next).padStart(2, '0')}:00`,
      label: `${formatHour12(h)} – ${formatHour12(next)}`
    });
    h = next;
  }
  return slots;
}

function populateTeacherDropdown() {
  const select = document.getElementById('new-teacher');
  select.innerHTML =
    '<option value="" disabled selected>Select teacher</option>' +
    TEACHERS.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} — ${escapeHtml(t.instrument)}</option>`).join('');
}

function populateCourseDropdown() {
  const select = document.getElementById('new-course');
  select.innerHTML =
    '<option value="" disabled selected>Select course</option>' +
    COURSES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function populateRollCallTeacherFilter() {
  const select = document.getElementById('rollcall-teacher-filter');
  select.innerHTML =
    '<option value="">All teachers</option>' +
    TEACHERS.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)} — ${escapeHtml(t.instrument)}</option>`).join('');
}

document.getElementById('rollcall-teacher-filter').addEventListener('change', loadRollCall);

function populateClassTimeDropdown() {
  const teacherName = document.getElementById('new-teacher').value;
  const timeSelect = document.getElementById('new-class-time');
  const teacher = TEACHERS.find((t) => t.name === teacherName);

  if (!teacher) {
    timeSelect.innerHTML = '<option value="" disabled selected>Select teacher first</option>';
    timeSelect.disabled = true;
    return;
  }

  const slots = generateSlots(teacher.time);
  timeSelect.disabled = false;
  timeSelect.innerHTML =
    '<option value="" disabled selected>Select class time</option>' +
    slots.map((s) => `<option value="${s.value}">${s.label}</option>`).join('');
}

async function updateTeacherSessionInfo() {
  const teacherName = document.getElementById('new-teacher').value;
  const classTime = document.getElementById('new-class-time').value;
  const infoEl = document.getElementById('teacher-session-info');

  if (!teacherName) {
    infoEl.textContent = '';
    return;
  }
  const teacher = TEACHERS.find((t) => t.name === teacherName);
  const res = await fetch('/api/students');
  const students = await res.json();

  if (!classTime) {
    infoEl.textContent = `${teacher.days} — pick a class time to see how many students are in that session.`;
    return;
  }

  const slot = generateSlots(teacher.time).find((s) => s.value === classTime);
  const count = students.filter((s) => s.active !== false && s.teacher === teacherName && s.classTime === classTime).length;
  infoEl.textContent = `${teacher.days}, ${slot ? slot.label : classTime} — ${count} student${count === 1 ? '' : 's'} currently in this session (1 hr class)`;
}

document.getElementById('new-teacher').addEventListener('change', () => {
  populateClassTimeDropdown();
  updateTeacherSessionInfo();
});
document.getElementById('new-class-time').addEventListener('change', updateTeacherSessionInfo);



function formatClassTimeLabel(value) {
  if (!value) return '—';
  const m = value.match(/^(\d{2}):00-(\d{2}):00$/);
  if (!m) return value;
  return `${formatHour12(parseInt(m[1], 10))} – ${formatHour12(parseInt(m[2], 10))}`;
}

// Renders an editable class-time dropdown for a student row, using their
// assigned teacher's available hourly slots — same source used when adding
// a student. Falls back to a plain text box if the teacher isn't recognized
// (e.g. an imported/unassigned teacher name) so the value can still be set.
function timeSelectHtml(student) {
  const current = student.classTime || '';
  const teacherInfo = TEACHERS.find((t) => t.name === student.teacher);
  const slots = teacherInfo ? generateSlots(teacherInfo.time) : [];

  if (!slots.length) {
    return `<input type="text" class="classtime-edit-text" data-id="${student.id}" value="${escapeHtml(current)}" placeholder="e.g. 11:00-12:00" />`;
  }

  const options = ['<option value="">Time</option>']
    .concat(slots.map((s) => `<option value="${s.value}" ${s.value === current ? 'selected' : ''}>${s.label}</option>`));
  return `<select class="classtime-edit" data-id="${student.id}">${options.join('')}</select>`;
}

const DURATION_OPTIONS = ['1 month', '3 month', '6 month', '1 year'];

// Renders an editable Duration dropdown for a student row — lets imported
// students (which arrive with a blank duration) get one set manually,
// instead of only being settable through the Renew flow on the dashboard.
function durationSelectHtml(student) {
  const current = student.duration || '';
  const options = ['<option value="">Duration</option>']
    .concat(DURATION_OPTIONS.map((d) => `<option value="${d}" ${d === current ? 'selected' : ''}>${d}</option>`));
  return `<select class="duration-edit" data-id="${student.id}">${options.join('')}</select>`;
}

let studentsPaymentsMap = {};
let allStudentsCache = [];

// Net outstanding = sum of (totalAmount - paidAmount) across every receipt,
// floored at 0. Computed fresh from the raw payment records (not any single
// stored runningBalance) so it's always correct regardless of the order
// receipts were entered/imported in, and automatically reaches 0 the moment
// a later payment (e.g. imported from receipt.xlsx) pays off the due.
function outstandingBalanceFor(list) {
  const net = (list || []).reduce(
    (sum, p) => sum + (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0),
    0
  );
  return Math.max(net, 0);
}

// The most recently made payment (by payDate, tie-broken by timestamp) —
// used for the quick "Rs. X" button in the students table, which should
// reflect what was last paid, not a lifetime total.
function mostRecentPayment(list) {
  if (!list || list.length === 0) return null;
  return [...list].sort((a, b) => {
    const dateA = a.payDate || '';
    const dateB = b.payDate || '';
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return (a.timestamp || '') < (b.timestamp || '') ? 1 : -1;
  })[0];
}

async function loadStudents() {
  const [studentsRes, paymentsRes] = await Promise.all([
    fetch('/api/students'),
    fetch('/api/payments')
  ]);
  const students = await studentsRes.json();
  const payments = await paymentsRes.json();

  // Keyed by `${studentId}::${enrollmentId}` so a 2-course student's Guitar
  // and Vocals payments never get mixed together in the UI, the same way
  // they're kept separate on the server.
  studentsPaymentsMap = {};
  for (const p of payments) {
    const key = `${p.studentId}::${p.enrollmentId || 'primary'}`;
    studentsPaymentsMap[key] = studentsPaymentsMap[key] || [];
    studentsPaymentsMap[key].push(p);
  }
  Object.values(studentsPaymentsMap).forEach((list) => list.sort((a, b) => (a.date < b.date ? 1 : -1)));

  allStudentsCache = students;
  populateExistingStudentNames();
  renderStudentsTable();
}

// Powers the Name field's autocomplete AND the "is this an existing
// student getting another course?" hint — one list of unique names drives
// both, kept in sync every time students reload.
function populateExistingStudentNames() {
  const datalist = document.getElementById('existing-student-names');
  if (!datalist) return;
  const seen = new Set();
  const options = [];
  for (const s of allStudentsCache) {
    const key = normalizeNameClient(s.name);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(s.name);
  }
  datalist.innerHTML = options.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
}

function normalizeNameClient(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function renderStudentsTable() {
  const query = (document.getElementById('students-search').value || '').trim().toLowerCase();
  const students = query
    ? allStudentsCache.filter((s) =>
        s.name.toLowerCase().includes(query) ||
        (s.contact || '').toLowerCase().includes(query) ||
        (s.teacher || '').toLowerCase().includes(query) ||
        (s.course || '').toLowerCase().includes(query) ||
        (s.studentId || '').toLowerCase().includes(query) ||
        (s.enrollments || []).some((e) => (e.course || '').toLowerCase().includes(query) || (e.teacher || '').toLowerCase().includes(query))
      )
    : allStudentsCache;

  const tbody = document.getElementById('students-tbody');
  tbody.innerHTML = '';

  students
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((s) => {
      const enrollments = (s.enrollments && s.enrollments.length ? s.enrollments : [{ id: 'primary', course: s.course, teacher: s.teacher, classTime: s.classTime, duration: s.duration, admissionDate: s.admissionDate, active: true }])
        .filter((e) => e.active !== false);

      const tr = document.createElement('tr');
      tr.className = 'student-row-main';

      // Every active course shows in the SAME row — same ID/Name/Contact
      // (shared, one person), but its own line for Teacher/Time/Course/
      // Duration/Admitted/payment status, lined up by position so line 1
      // across every column is the same course, line 2 is the next, etc.
      // Nothing about a student's other course is hidden behind a toggle.
      const teacherLines = enrollments.map((e) => `<div class="course-line">${escapeHtml(e.teacher)}</div>`).join('');
      const timeLines = enrollments.map((e) => `<div class="course-line">${timeSelectHtml({ id: `${s.id}::${e.id}`, teacher: e.teacher, classTime: e.classTime })}</div>`).join('');
      const durationLines = enrollments.map((e) => `<div class="course-line">${durationSelectHtml({ id: `${s.id}::${e.id}`, duration: e.duration })}</div>`).join('');
      const admittedLines = enrollments.map((e) => `<div class="course-line">${escapeHtml(adToBs(e.admissionDate || s.admissionDate) || '—')}</div>`).join('');

      const courseLines = enrollments.map((e) => {
        const enrPayments = studentsPaymentsMap[`${s.id}::${e.id}`] || [];
        const lastPayment = mostRecentPayment(enrPayments);
        const due = outstandingBalanceFor(enrPayments);
        return `
          <div class="course-line course-line-with-actions">
            <button type="button" class="link-btn payment-toggle-btn" data-student-id="${s.id}" data-enrollment-id="${e.id}" title="Last paid${lastPayment ? ' on ' + escapeHtml(adToBs(lastPayment.payDate) || '') : ''}">${escapeHtml(e.course)}</button>
            ${due > 0 ? `<span class="due-chip" title="Outstanding due for ${escapeHtml(e.course)}">Due Rs. ${due.toLocaleString()}</span>` : ''}
            <button type="button" class="link-btn extra-course-remove-btn" data-student-id="${s.id}" data-enrollment-id="${e.id}" data-course="${escapeHtml(e.course)}" title="Remove this course only">✕</button>
          </div>`;
      }).join('');

      tr.innerHTML = `
        <td class="tag-id"><input type="text" class="student-id-edit" data-id="${s.id}" value="${escapeHtml(s.studentId || '')}" />${s.source === 'excel-import' ? '<span class="tag-source-mini" title="Added via Excel import">E</span>' : ''}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.contact || '—')}</td>
        <td>${teacherLines}</td>
        <td>${timeLines}</td>
        <td>${courseLines}</td>
        <td>${durationLines}</td>
        <td>${admittedLines}</td>
        <td class="actions-cell">
          <button class="link-btn add-course-btn" data-id="${s.id}" title="Register another course for this student">+ Course</button>
          <button class="link-btn remove-btn" data-id="${s.id}">Remove student</button>
        </td>
      `;
      tbody.appendChild(tr);

      // One payment panel per course, each independently toggled by
      // clicking that course's name above — never combined, since Guitar's
      // payment history has nothing to do with Vocals'.
      enrollments.forEach((e) => {
        const detailTr = document.createElement('tr');
        detailTr.className = 'payment-details-row';
        detailTr.dataset.studentId = s.id;
        detailTr.dataset.enrollmentId = e.id;
        detailTr.hidden = true;
        const detailTd = document.createElement('td');
        detailTd.colSpan = 9;
        detailTd.appendChild(buildPaymentSection(s, e.id, e));
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
      });
    });

  tbody.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this student from the register?')) return;
      await fetch(`/api/students/${btn.dataset.id}`, { method: 'DELETE' });
      loadStudents();
    });
  });

  tbody.querySelectorAll('.add-course-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const student = allStudentsCache.find((s) => s.id === btn.dataset.id);
      if (!student) return;
      startAddCourseFor(student);
    });
  });

  tbody.querySelectorAll('.extra-course-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const student = allStudentsCache.find((s) => s.id === btn.dataset.studentId);
      const activeCourseCount = (student?.enrollments || []).filter((x) => x.active !== false).length;
      if (activeCourseCount <= 1) {
        alert('A student needs at least one course — use "Remove student" instead if they are leaving entirely.');
        return;
      }
      if (!confirm(`Remove ${btn.dataset.course}? Their other course(s) are unaffected.`)) return;
      const res = await fetch(`/api/students/${btn.dataset.studentId}/courses/${btn.dataset.enrollmentId}`, { method: 'DELETE' });
      if (res.ok) loadStudents();
      else { const err = await res.json(); alert(err.error || 'Could not remove course.'); }
    });
  });

  tbody.querySelectorAll('.payment-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = tbody.querySelector(`.payment-details-row[data-student-id="${btn.dataset.studentId}"][data-enrollment-id="${btn.dataset.enrollmentId}"]`);
      if (row) row.hidden = !row.hidden;
    });
  });

  tbody.querySelectorAll('.student-id-edit').forEach((input) => {
    const original = input.value;
    const save = async () => {
      const newValue = input.value.trim();
      if (newValue === original) return;
      if (!newValue) {
        alert('Student ID cannot be empty.');
        input.value = original;
        return;
      }
      const res = await fetch(`/api/students/${input.dataset.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: newValue })
      });
      if (res.ok) {
        document.getElementById('import-status').textContent = 'Student ID updated.';
        document.getElementById('import-status').classList.remove('error');
        loadStudents();
      } else {
        const err = await res.json();
        alert(err.error || 'Could not update Student ID.');
        input.value = original;
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  });

  // A "::" in data-id means this control belongs to a NON-primary course
  // enrollment (`${studentId}::${enrollmentId}`) and needs the course-level
  // PUT endpoint; otherwise it's the student's primary course and keeps
  // using the original student-level PUT, unchanged from before.
  async function saveField(compositeOrStudentId, field, value) {
    if (compositeOrStudentId.includes('::')) {
      const [studentId, enrollmentId] = compositeOrStudentId.split('::');
      return fetch(`/api/students/${studentId}/courses/${enrollmentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value })
      });
    }
    return fetch(`/api/students/${compositeOrStudentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value })
    });
  }

  tbody.querySelectorAll('.duration-edit').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const res = await saveField(sel.dataset.id, 'duration', sel.value);
      if (res.ok) {
        document.getElementById('import-status').textContent = 'Duration updated.';
        document.getElementById('import-status').classList.remove('error');
      } else {
        alert('Could not update duration.');
      }
    });
  });

  async function saveClassTime(id, value) {
    const res = await saveField(id, 'classTime', value);
    if (res.ok) {
      document.getElementById('import-status').textContent = 'Class time updated.';
      document.getElementById('import-status').classList.remove('error');
    } else {
      alert('Could not update class time.');
    }
  }

  tbody.querySelectorAll('.classtime-edit').forEach((sel) => {
    sel.addEventListener('change', () => saveClassTime(sel.dataset.id, sel.value));
  });

  tbody.querySelectorAll('.classtime-edit-text').forEach((input) => {
    input.addEventListener('change', () => saveClassTime(input.dataset.id, input.value.trim()));
  });
}

function buildPaymentSection(student, enrollmentId, enrollment) {
  const wrap = document.createElement('div');
  wrap.className = 'sc-payments students-payments-panel';

  const list = studentsPaymentsMap[`${student.id}::${enrollmentId}`] || [];
  const due = outstandingBalanceFor(list);

  const paymentRows = list
    .map(
      (p) => `
      <li class="payment-row" data-payment-id="${p.id}">
        <button type="button" class="p-delete" data-id="${p.id}" title="Delete this payment">✕</button>
        <div class="p-top">
          <span class="p-date">${escapeHtml(adToBs(p.payDate) || '')}</span>
          <span class="p-amount">Rs. ${(p.paidAmount || 0).toLocaleString()}</span>
        </div>
        <div class="p-mid">
          ${p.method ? `<span class="p-method">${escapeHtml(p.method)}</span>` : ''}
          ${p.receiptNo ? `<span class="p-receipt" title="${escapeHtml(p.verificationCode || '')}">${escapeHtml(p.receiptNo)}</span>` : ''}
        </div>
        ${p.notes ? `<div class="p-note" title="${escapeHtml(p.notes)}">${escapeHtml(p.notes)}</div>` : ''}
        ${p.balanceDue ? `<div class="p-due-note">Due since ${escapeHtml(adToBs(p.payDate) || '')} · Rs. ${p.balanceDue.toLocaleString()}</div>` : ''}
      </li>`
    )
    .join('');

  wrap.innerHTML = `
    <div class="sc-payments-head">
      <span>Payment history${enrollment ? ` — ${escapeHtml(enrollment.course)}` : ''}</span>
    </div>
    <ul class="payment-list">${paymentRows || '<li class="payment-empty">No payments recorded yet.</li>'}</ul>
    ${due > 0 ? `<div class="due-summary">Due pending: <strong>Rs. ${due.toLocaleString()}</strong></div>` : ''}
    <div class="payment-panel-actions">
      <button type="button" class="btn-secondary btn-small pay-add-btn">+ Record payment</button>
      ${due > 0 ? `<button type="button" class="btn-primary btn-small pay-due-btn">Record due payment</button>` : ''}
    </div>
  `;

  wrap.querySelector('.pay-add-btn').addEventListener('click', () => openPaymentModal(student, { enrollment }));
  const dueBtn = wrap.querySelector('.pay-due-btn');
  if (dueBtn) {
    dueBtn.addEventListener('click', () =>
      openPaymentModal(student, { enrollment, dueClearance: true, presetPaid: due, presetNotes: 'Due clearance' })
    );
  }

  wrap.querySelectorAll('.p-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this payment record?')) return;
      await fetch(`/api/payments/${btn.dataset.id}`, { method: 'DELETE' });
      loadStudents();
    });
  });

  return wrap;
}

// ---------- payment modal (matches the receipts spreadsheet's fields) ----------

function addFeeItemRow(label, amount) {
  const row = document.createElement('div');
  row.className = 'fee-item-row';
  row.innerHTML = `
    <input type="text" class="fee-label" placeholder="Fee label (e.g. Monthly Fee)" value="${escapeHtml(label || '')}" />
    <input type="number" class="fee-amount" placeholder="Amount" min="0" step="1" value="${amount || ''}" />
    <button type="button" class="fee-remove" title="Remove fee item">✕</button>
  `;
  row.querySelector('.fee-remove').addEventListener('click', () => {
    row.remove();
    updatePaymentTotals();
  });
  row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', updatePaymentTotals));
  document.getElementById('pay-fee-items').appendChild(row);
}

function getFeeItems() {
  return [...document.querySelectorAll('#pay-fee-items .fee-item-row')]
    .map((row) => ({
      label: row.querySelector('.fee-label').value.trim(),
      amount: Number(row.querySelector('.fee-amount').value) || 0
    }))
    .filter((f) => f.label || f.amount);
}

function updatePaymentTotals() {
  const feeTotal = getFeeItems().reduce((sum, f) => sum + f.amount, 0);
  const discount = Number(document.getElementById('pay-discount').value) || 0;
  const total = Math.max(feeTotal - discount, 0);
  const paid = Number(document.getElementById('pay-paid').value) || 0;
  const balance = Math.max(total - paid, 0);
  document.getElementById('pay-total-display').textContent = `Rs. ${total.toLocaleString()}`;
  document.getElementById('pay-balance-display').textContent = `Rs. ${balance.toLocaleString()}`;
}

function openPaymentModal(student, options = {}) {
  const enrollment = options.enrollment || (student.enrollments || []).find((e) => e.id === 'primary') || student.enrollments?.[0] || {
    id: 'primary', course: student.course, teacher: student.teacher, classTime: student.classTime
  };

  document.getElementById('pay-student-id').value = student.id;
  document.getElementById('pay-enrollment-id').value = enrollment.id;
  document.getElementById('pay-student-heading').textContent =
    `${student.name}${student.studentId ? ' · ' + student.studentId : ''}${enrollment.course ? ' · ' + enrollment.course : ''}`;

  document.getElementById('pay-payer').value = student.name || '';
  document.getElementById('pay-phone').value = student.contact || '';
  document.getElementById('pay-course').value = enrollment.course || '';

  const teacherInfo = TEACHERS.find((t) => t.name === enrollment.teacher);
  document.getElementById('pay-tutor').value = teacherInfo
    ? `${teacherInfo.name} (${teacherInfo.instrument})`
    : (enrollment.teacher || '');

  const slotLabel = formatClassTimeLabel(enrollment.classTime);
  document.getElementById('pay-schedule').value = teacherInfo
    ? `${teacherInfo.days} · ${slotLabel === '—' ? teacherInfo.time : slotLabel}`
    : '';

  document.getElementById('pay-months').value = 1;
  document.getElementById('pay-class-start').value = bsTodayIso();
  document.getElementById('pay-class-end').value = '';
  document.getElementById('pay-date').value = bsTodayIso();
  document.getElementById('pay-discount').value = 0;
  document.getElementById('pay-paid').value = options.presetPaid || '';
  document.getElementById('pay-method').value = 'Cash';
  document.getElementById('pay-received-by').value = '';
  document.getElementById('pay-notes').value = options.presetNotes || '';

  document.getElementById('pay-fee-items').innerHTML = '';
  // A due-clearance payment pays down an existing balance rather than
  // charging something new, so it deliberately starts with NO fee items
  // (total amount 0) — only the "paid" amount is filled in.
  if (!options.dueClearance) {
    addFeeItemRow('Monthly Fee', '');
  }
  updatePaymentTotals();

  document.getElementById('payment-modal').hidden = false;
  refreshAllBsHints();
}

function closePaymentModal() {
  document.getElementById('payment-modal').hidden = true;
}

document.getElementById('payment-modal-close').addEventListener('click', closePaymentModal);
document.getElementById('payment-modal-cancel').addEventListener('click', closePaymentModal);
document.getElementById('payment-modal').addEventListener('click', (e) => {
  if (e.target.id === 'payment-modal') closePaymentModal();
});
document.getElementById('pay-add-fee-item').addEventListener('click', () => addFeeItemRow());
document.getElementById('pay-discount').addEventListener('input', updatePaymentTotals);
document.getElementById('pay-paid').addEventListener('input', updatePaymentTotals);

document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    studentId: document.getElementById('pay-student-id').value,
    enrollmentId: document.getElementById('pay-enrollment-id').value || 'primary',
    payer: document.getElementById('pay-payer').value.trim(),
    phone: document.getElementById('pay-phone').value.trim(),
    course: document.getElementById('pay-course').value.trim(),
    tutor: document.getElementById('pay-tutor').value.trim(),
    schedule: document.getElementById('pay-schedule').value.trim(),
    classStart: bsToAd(document.getElementById('pay-class-start').value),
    classEnd: bsToAd(document.getElementById('pay-class-end').value),
    months: document.getElementById('pay-months').value,
    feeItems: getFeeItems(),
    discount: document.getElementById('pay-discount').value,
    paidAmount: document.getElementById('pay-paid').value,
    payDate: bsToAd(document.getElementById('pay-date').value),
    method: document.getElementById('pay-method').value,
    receivedBy: document.getElementById('pay-received-by').value.trim(),
    notes: document.getElementById('pay-notes').value.trim()
  };

  const res = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    const payment = await res.json();
    closePaymentModal();
    loadStudents();
    if (document.getElementById('tab-dashboard').classList.contains('active')) {
      loadDashboard();
    }
    document.getElementById('import-status').textContent = `Receipt saved: ${payment.receiptNo}`;
    document.getElementById('import-status').classList.remove('error');
  } else {
    const err = await res.json();
    alert(err.error || 'Could not save payment.');
  }
});

function updateNewStudentDueDisplay() {
  const fee = Number(document.getElementById('new-course-fee').value) || 0;
  const paid = Number(document.getElementById('new-payment').value) || 0;
  const due = Math.max(fee - paid, 0);
  document.getElementById('new-due-display').textContent = `Rs. ${due.toLocaleString()}`;
}
document.getElementById('new-course-fee').addEventListener('input', updateNewStudentDueDisplay);
document.getElementById('new-payment').addEventListener('input', updateNewStudentDueDisplay);

// Adding a course for someone already registered reuses this same form,
// but in a distinct mode: submitting calls POST /api/students/:id/courses
// (adding a new, independently-tracked course enrollment to the SAME
// student record) instead of POST /api/students (which would create a
// second, disconnected student record with the same name).
let addCourseForStudentId = null;

function startAddCourseFor(student) {
  addCourseForStudentId = student.id;
  document.getElementById('add-course-banner').hidden = false;
  document.getElementById('add-course-banner-text').textContent =
    `Adding a new course for ${student.name}${student.studentId ? ' (' + student.studentId + ')' : ''} — this keeps their existing course(s) untouched.`;
  document.getElementById('add-student-submit').textContent = 'Add course';
  document.getElementById('new-student-id').value = '';
  document.getElementById('new-student-id').disabled = true;
  document.getElementById('new-name').value = student.name;
  document.getElementById('new-name').disabled = true;
  document.getElementById('new-contact').value = student.contact || '';
  document.getElementById('new-admission').value = bsTodayIso();
  document.getElementById('new-course-fee').value = '';
  document.getElementById('new-payment').value = '';
  document.getElementById('existing-student-hint').hidden = true;
  document.getElementById('add-student-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  refreshAllBsHints();
  const teacherSelect = document.getElementById('new-teacher');
  if (teacherSelect) teacherSelect.focus();
}

function cancelAddCourseMode() {
  addCourseForStudentId = null;
  document.getElementById('add-course-banner').hidden = true;
  document.getElementById('add-student-submit').textContent = 'Add student';
  document.getElementById('new-student-id').disabled = false;
  document.getElementById('new-name').disabled = false;
  document.getElementById('add-student-form').reset();
  document.getElementById('new-due-display').textContent = 'Rs. 0';
  refreshAllBsHints();
}
document.getElementById('add-course-cancel').addEventListener('click', cancelAddCourseMode);

// While adding a brand-new student, if the typed name matches someone
// already on the register, this is very likely meant to be a second course
// for that same person — surface a one-click way to do that properly
// (a linked course enrollment) instead of silently creating a same-name
// duplicate student record.
function checkExistingStudentName() {
  if (addCourseForStudentId) return; // already in add-course mode
  const nameInput = document.getElementById('new-name');
  const hint = document.getElementById('existing-student-hint');
  const typed = normalizeNameClient(nameInput.value);

  if (!typed) {
    hint.hidden = true;
    return;
  }

  const match = allStudentsCache.find((s) => normalizeNameClient(s.name) === typed);
  if (!match) {
    hint.hidden = true;
    return;
  }

  const courseNames = (match.enrollments || []).filter((e) => e.active !== false).map((e) => e.course).join(', ') || match.course;
  hint.hidden = false;
  hint.innerHTML = `${escapeHtml(match.name)} is already registered (currently: ${escapeHtml(courseNames)}). `;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn';
  btn.textContent = 'Add another course for them instead';
  btn.addEventListener('click', () => startAddCourseFor(match));
  hint.appendChild(btn);
}
document.getElementById('new-name').addEventListener('input', checkExistingStudentName);

document.getElementById('add-student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const studentId = document.getElementById('new-student-id').value.trim();
  const name = document.getElementById('new-name').value.trim();
  const contact = document.getElementById('new-contact').value.trim();
  const teacher = document.getElementById('new-teacher').value;
  const classTime = document.getElementById('new-class-time').value;
  const course = document.getElementById('new-course').value.trim();
  const duration = document.getElementById('new-duration').value;
  const admissionDate = bsToAd(document.getElementById('new-admission').value);
  const courseFee = Number(document.getElementById('new-course-fee').value) || 0;
  const paidNow = Number(document.getElementById('new-payment').value) || 0;

  const addingCourseFor = addCourseForStudentId;

  const res = addingCourseFor
    ? await fetch(`/api/students/${addingCourseFor}/courses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course, teacher, classTime, duration, admissionDate })
      })
    : await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, name, contact, teacher, classTime, course, duration, admissionDate })
      });

  if (res.ok) {
    const data = await res.json();
    // For a new student, the enrollment is the primary one on the returned
    // student; for an added course, the endpoint returns { student, enrollment }.
    const student = addingCourseFor ? data.student : data;
    const enrollment = addingCourseFor ? data.enrollment : student.enrollments[0];

    // Course fee = what's actually owed for THIS course; paid now = what was
    // actually handed over today for it. Whatever's left becomes that
    // course's own due (never mixed with the student's other course, if any).
    if (courseFee > 0 || paidNow > 0) {
      const feeItems = courseFee > 0
        ? [{ label: 'Course Fee', amount: courseFee }]
        : [{ label: 'Initial payment', amount: paidNow }];
      await fetch('/api/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: student.id,
          enrollmentId: enrollment.id,
          payer: student.name,
          phone: student.contact,
          course: enrollment.course,
          tutor: enrollment.teacher,
          classStart: admissionDate || todayISO(),
          months: 1,
          feeItems,
          discount: 0,
          paidAmount: paidNow,
          payDate: admissionDate || todayISO(),
          method: 'Cash',
          notes: courseFee > 0 ? 'Admission fee' : 'Initial payment'
        })
      });
    }
    e.target.reset();
    document.getElementById('teacher-session-info').textContent = '';
    document.getElementById('new-due-display').textContent = 'Rs. 0';
    document.getElementById('existing-student-hint').hidden = true;
    cancelAddCourseMode();
    populateClassTimeDropdown();
    loadStudents();
  } else {
    const err = await res.json();
    alert(err.error || (addingCourseFor ? 'Could not add course.' : 'Could not add student.'));
  }
});

const excelFileInput = document.getElementById('excel-file');
document.getElementById('import-excel-btn').addEventListener('click', () => excelFileInput.click());

excelFileInput.addEventListener('change', async () => {
  const file = excelFileInput.files[0];
  if (!file) return;

  const statusEl = document.getElementById('import-status');
  statusEl.textContent = 'Importing…';
  statusEl.classList.remove('error');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/import-excel', { method: 'POST', body: formData });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Import failed');

    statusEl.textContent = `Added ${result.addedCount} new student${result.addedCount === 1 ? '' : 's'}` +
      (result.skippedCount ? ` — ${result.skippedCount} already on the register were skipped.` : '.');
    loadStudents();
  } catch (err) {
    statusEl.textContent = err.message || 'Could not import the file.';
    statusEl.classList.add('error');
  } finally {
    excelFileInput.value = '';
  }
});

// ---------- dashboard ----------

let dashboardData = [];

async function loadDashboard() {
  const res = await fetch('/api/dashboard');
  dashboardData = await res.json();
  renderDashboard();
}

async function loadTeachers() {
  const res = await fetch('/api/dashboard');
  const students = await res.json();
  const container = document.getElementById('teachers-list');
  container.innerHTML = '';
  TEACHERS.forEach((t) => container.appendChild(buildTeacherBlock(t, students)));
}

function buildTeacherBlock(teacher, students) {
  const teacherStudents = students.filter((s) => s.active !== false && s.teacher === teacher.name);
  const slots = generateSlots(teacher.time).map((slot) => ({
    ...slot,
    students: teacherStudents.filter((s) => s.classTime === slot.value)
  }));

  const block = document.createElement('div');
  block.className = 'teacher-block';

  const chipsHtml = slots
    .map(
      (slot, i) => `
      <button type="button" class="slot-chip${i === 0 ? ' active' : ''}" data-slot="${escapeHtml(slot.value)}">
        <span class="slot-chip-time">${escapeHtml(slot.label)}</span>
        <span class="slot-chip-count">${slot.students.length}</span>
      </button>`
    )
    .join('');

  block.innerHTML = `
    <div class="tb-header">
      <div class="tb-heading">
        <span class="tb-name">${escapeHtml(teacher.name)}</span>
        <span class="tb-instrument">${escapeHtml(teacher.instrument)}</span>
      </div>
      <div class="tb-meta">
        <span>${escapeHtml(teacher.days)}</span>
        <span class="tb-dot">·</span>
        <span>${escapeHtml(teacher.contact || 'No contact on file')}</span>
        <span class="tb-dot">·</span>
        <span>${teacherStudents.length} student${teacherStudents.length === 1 ? '' : 's'} total</span>
      </div>
    </div>
    <div class="tb-chips">${chipsHtml || '<p class="empty-sub">No class slots configured for this schedule.</p>'}</div>
    <div class="tb-roster"></div>
  `;

  const rosterEl = block.querySelector('.tb-roster');
  const chips = block.querySelectorAll('.slot-chip');

  function renderRoster(slotValue) {
    const slot = slots.find((s) => s.value === slotValue);
    if (!slot) {
      rosterEl.innerHTML = '';
      return;
    }
    if (slot.students.length === 0) {
      rosterEl.innerHTML = `
        <div class="roster-head"><span>${escapeHtml(slot.label)}</span><span>0 students</span></div>
        <p class="roster-empty">No students scheduled in this slot yet.</p>
      `;
      return;
    }
    const rows = slot.students
      .map(
        (s) => `
        <div class="roster-row">
          <span class="roster-id">${escapeHtml(s.studentId || '—')}</span>
          <span class="roster-name">${escapeHtml(s.name)}</span>
          <span class="roster-contact">${escapeHtml(s.contact || '—')}</span>
          <span class="roster-duration">${escapeHtml(s.duration || '—')}</span>
        </div>`
      )
      .join('');

    rosterEl.innerHTML = `
      <div class="roster-head"><span>${escapeHtml(slot.label)}</span><span>${slot.students.length} student${slot.students.length === 1 ? '' : 's'}</span></div>
      <div class="roster-columns"><span>ID</span><span>Name</span><span>Contact</span><span>Duration</span></div>
      <div class="roster-list">${rows}</div>
    `;
  }

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderRoster(chip.dataset.slot);
    });
  });

  if (slots.length > 0) renderRoster(slots[0].value);

  return block;
}

document.getElementById('dashboard-search').addEventListener('input', renderDashboard);
document.getElementById('students-search').addEventListener('input', renderStudentsTable);

function renderDashboard() {
  const query = (document.getElementById('dashboard-search').value || '').trim().toLowerCase();
  const gridEl = document.getElementById('dashboard-grid');
  const overrunSection = document.getElementById('overrun-section');
  const overrunGridEl = document.getElementById('overrun-grid');
  const activeHeading = document.getElementById('active-heading');
  const emptyEl = document.getElementById('dashboard-empty');
  gridEl.innerHTML = '';
  overrunGridEl.innerHTML = '';

  if (dashboardData.length === 0) {
    emptyEl.hidden = false;
    overrunSection.hidden = true;
    activeHeading.hidden = true;
    return;
  }
  emptyEl.hidden = true;

  const filtered = query
    ? dashboardData.filter((s) =>
        s.name.toLowerCase().includes(query) ||
        (s.teacher || '').toLowerCase().includes(query) ||
        (s.course || '').toLowerCase().includes(query)
      )
    : dashboardData;

  const overrunList = filtered.filter((s) => s.overextended || s.duePending);
  const activeList = filtered.filter((s) => !s.overextended && !s.duePending);

  if (overrunList.length > 0) {
    overrunSection.hidden = false;
    activeHeading.hidden = false;
    overrunList.forEach((s) => overrunGridEl.appendChild(buildStudentCard(s)));
  } else {
    overrunSection.hidden = true;
    activeHeading.hidden = true;
  }

  activeList.forEach((s) => gridEl.appendChild(buildStudentCard(s)));
}

function buildStudentCard(s) {
  const card = document.createElement('div');
  let cardClass = 'student-card';
  if (s.overextended) cardClass += ' overrun';
  if (s.duePending) cardClass += ' due-pending';
  card.className = cardClass;

  const totalClasses = s.effectiveTotal;
  const presentCount = s.effectivePresent;
  const absentCount = s.effectiveAbsent;

  const paymentRows = s.payments
    .map(
      (p) => `
      <li class="payment-row">
        <div class="p-top">
          <span class="p-date">${escapeHtml(adToBs(p.payDate) || '')}</span>
          <span class="p-amount">Rs. ${(p.paidAmount || 0).toLocaleString()}</span>
        </div>
        <div class="p-mid">
          ${p.method ? `<span class="p-method">${escapeHtml(p.method)}</span>` : ''}
        </div>
        ${p.notes ? `<div class="p-note" title="${escapeHtml(p.notes)}">${escapeHtml(p.notes)}</div>` : ''}
        ${p.balanceDue ? `<div class="p-due-note">Due since ${escapeHtml(adToBs(p.payDate) || '')} · Rs. ${p.balanceDue.toLocaleString()}</div>` : ''}
      </li>`
    )
    .join('');

  const statusValue = s.allotted === null ? '—' : (s.effectiveStatus || (s.overextended ? 'Needs renewal' : 'Classes running'));
  const hasBaseline = s.baseline && (s.baseline.present > 0 || s.baseline.absent > 0);
  const overrideBadge = hasBaseline ? ' <span class="sc-override-badge" title="Includes a starting balance of classes taken before this system">+carry-in</span>' : '';
  const statusInfo = `
    <div class="sc-row sc-editable" data-edit-student="${s.dbId}" title="Click to add classes taken before this system">
      <span class="sc-label">Total classes</span><span>${totalClasses}${overrideBadge}</span>
    </div>
    <div class="sc-row"><span class="sc-label">Present</span><span>${presentCount}</span></div>
    ${s.allotted !== null && s.extraClasses > 0 ? `<div class="sc-row"><span class="sc-label">Extra classes</span><span class="sc-extra">${s.extraClasses} beyond duration</span></div>` : ''}
    <div class="sc-row"><span class="sc-label">Absent</span><span>${absentCount}</span></div>
    <div class="sc-row"><span class="sc-label">Status</span><span class="${s.overextended ? 'sc-extra' : ''}">${statusValue}</span></div>
    ${s.overextended && s.finalClassDate ? `<div class="sc-row"><span class="sc-label">Final class date</span><span>${escapeHtml(adToBs(s.finalClassDate))}</span></div>` : ''}
    <div class="sc-row"><span class="sc-label">Payment</span><span class="${s.duePending ? 'sc-due' : ''}">${s.duePending ? `Due pending · Rs. ${s.outstandingBalance.toLocaleString()}` : 'Paid in full'}</span></div>
  `;


  const renewBlock = s.overextended
    ? `
      <div class="renew-block">
        <div class="renew-label">Renew course</div>
        <form class="renew-form" data-dashboard-id="${s.dbId}">
          <select class="renew-duration">
            <option value="1 month">1 month — 12 classes</option>
            <option value="3 month">3 month — 36 classes</option>
            <option value="6 month">6 month — 72 classes</option>
            <option value="1 year">1 year — 144 classes</option>
          </select>
          <div class="renew-fee-row">
            <input type="number" class="renew-course-fee" placeholder="Course fee (optional)" min="0" step="1" />
            <input type="number" class="renew-paid-now" placeholder="Paid now (optional)" min="0" step="1" />
          </div>
          <div class="renew-due-display">Due: Rs. 0</div>
          <button type="submit" class="btn-primary btn-small">Renew</button>
        </form>
      </div>`
    : '';

  const dueBlock = s.duePending
    ? `
      <div class="due-block">
        <div class="due-label">Rs. ${s.outstandingBalance.toLocaleString()} due</div>
        <button type="button" class="btn-primary btn-small due-pay-btn">Record due payment</button>
      </div>`
    : '';

  card.innerHTML = `
    <div class="sc-header">
      <div class="sc-name">${escapeHtml(s.name)}${s.studentId ? ` <span class="sc-id">${escapeHtml(s.studentId)}</span>` : ''}${s.courseCount > 1 ? ` <span class="sc-multi-badge" title="This student has ${s.courseCount} courses">${s.courseCount} courses</span>` : ''}</div>
      <div class="sc-teacher-tag">${escapeHtml(s.teacher)}</div>
    </div>
    <div class="sc-body">
      <div class="sc-row"><span class="sc-label">Contact</span><span>${escapeHtml(s.contact || '—')}</span></div>
      <div class="sc-row"><span class="sc-label">Course</span><span>${escapeHtml(s.course)}</span></div>
      <div class="sc-row"><span class="sc-label">Duration</span><span>${escapeHtml(s.duration || '—')}</span></div>
      <div class="sc-row"><span class="sc-label">Admitted</span><span>${escapeHtml(adToBs(s.admissionDate) || '—')}</span></div>
      ${statusInfo}

      <div class="sc-payments">
        <div class="sc-payments-head">
          <span>Payment history</span>
        </div>
        <ul class="payment-list">${paymentRows || '<li class="payment-empty">No payments recorded yet.</li>'}</ul>
      </div>

      ${dueBlock}
      ${renewBlock}
    </div>
  `;

  // Every action below is scoped to THIS card's specific course
  // (s.enrollmentId), never just the student, so a 2-course student's
  // Guitar card can never accidentally renew, pay off, or override Vocals.
  const dueBtn = card.querySelector('.due-pay-btn');
  if (dueBtn) {
    dueBtn.addEventListener('click', () =>
      openPaymentModal(
        { id: s.studentDbId, name: s.name, contact: s.contact, studentId: s.studentId },
        {
          enrollment: { id: s.enrollmentId, course: s.course, teacher: s.teacher, classTime: s.classTime },
          dueClearance: true, presetPaid: s.outstandingBalance, presetNotes: 'Due clearance'
        }
      )
    );
  }

  const renewForm = card.querySelector('.renew-form');
  if (renewForm) {
    const feeInput = renewForm.querySelector('.renew-course-fee');
    const paidInput = renewForm.querySelector('.renew-paid-now');
    const dueDisplay = renewForm.querySelector('.renew-due-display');
    const updateRenewDue = () => {
      const fee = Number(feeInput.value) || 0;
      const paid = Number(paidInput.value) || 0;
      dueDisplay.textContent = `Due: Rs. ${Math.max(fee - paid, 0).toLocaleString()}`;
    };
    feeInput.addEventListener('input', updateRenewDue);
    paidInput.addEventListener('input', updateRenewDue);

    renewForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const duration = renewForm.querySelector('.renew-duration').value;
      const courseFee = Number(feeInput.value) || 0;
      const paidNow = Number(paidInput.value) || 0;
      const renewDate = todayISO();

      const res = await fetch(`/api/students/${s.studentDbId}/courses/${s.enrollmentId}/renew`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration, cycleStartDate: renewDate })
      });
      if (res.ok) {
        // Renewal fee is recorded as its own receipt, dated to the actual
        // renewal day, tied to THIS course's enrollment — this is what lets
        // the due-pending flag and the 20-day reminder clock anchor to the
        // renewal date (not the original admission date) when a student
        // doesn't pay in full here, without touching their other course(s).
        if (courseFee > 0 || paidNow > 0) {
          const feeItems = courseFee > 0
            ? [{ label: 'Renewal Fee', amount: courseFee }]
            : [{ label: 'Paid at renewal', amount: paidNow }];
          await fetch('/api/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentId: s.studentDbId,
              enrollmentId: s.enrollmentId,
              payer: s.name,
              phone: s.contact,
              course: s.course,
              tutor: s.teacher,
              classStart: renewDate,
              months: 1,
              feeItems,
              discount: 0,
              paidAmount: paidNow,
              payDate: renewDate,
              method: 'Cash',
              notes: courseFee > 0 ? 'Renewal fee' : 'Renewal payment'
            })
          });
        }
        loadDashboard();
      } else {
        const err = await res.json();
        alert(err.error || 'Could not renew course.');
      }
    });
  }

  const editRow = card.querySelector('.sc-editable');
  if (editRow) {
    editRow.addEventListener('click', () => openOverrideModal(s));
  }

  return card;
}

// ---------- baseline modal (add classes taken before this system) ----------

function openOverrideModal(student) {
  document.getElementById('override-student-id').value = student.dbId;
  document.getElementById('override-student-heading').textContent = `${student.name}${student.studentId ? ` (${student.studentId})` : ''}${student.course ? ' · ' + student.course : ''}`;
  document.getElementById('override-password').value = '';

  const baseline = student.baseline || { present: 0, absent: 0 };
  document.getElementById('override-baseline-present').value = baseline.present || 0;
  document.getElementById('override-baseline-absent').value = baseline.absent || 0;
  document.getElementById('override-status-msg').textContent = '';
  document.getElementById('override-status-msg').classList.remove('error');

  updateOverridePreview(student);

  document.getElementById('override-modal').hidden = false;
  document.getElementById('override-password').focus();
}

function updateOverridePreview(student) {
  const bp = Number(document.getElementById('override-baseline-present').value) || 0;
  const ba = Number(document.getElementById('override-baseline-absent').value) || 0;
  const realPresent = student.attendance.present;
  const realTotal = student.attendance.total;
  const realAbsent = realTotal - realPresent;
  const newPresent = realPresent + bp;
  const newAbsent = realAbsent + ba;
  const newTotal = newPresent + newAbsent;
  document.getElementById('override-preview').textContent =
    `With this added: Total classes ${newTotal}, Present ${newPresent}, Absent ${newAbsent}. Roll Call from here on keeps adding to these normally.`;
}

document.getElementById('override-baseline-present').addEventListener('input', () => {
  const dbId = document.getElementById('override-student-id').value;
  const student = dashboardData.find((s) => s.dbId === dbId);
  if (student) updateOverridePreview(student);
});
document.getElementById('override-baseline-absent').addEventListener('input', () => {
  const dbId = document.getElementById('override-student-id').value;
  const student = dashboardData.find((s) => s.dbId === dbId);
  if (student) updateOverridePreview(student);
});

function closeOverrideModal() {
  document.getElementById('override-modal').hidden = true;
}

document.getElementById('override-modal-close').addEventListener('click', closeOverrideModal);
document.getElementById('override-modal-cancel').addEventListener('click', closeOverrideModal);
document.getElementById('override-modal').addEventListener('click', (e) => {
  if (e.target.id === 'override-modal') closeOverrideModal();
});

document.getElementById('override-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById('override-status-msg');
  const dbId = document.getElementById('override-student-id').value;
  const row = dashboardData.find((s) => s.dbId === dbId);
  if (!row) {
    msgEl.textContent = 'Could not find this course — try reloading the dashboard.';
    msgEl.classList.add('error');
    return;
  }

  const body = {
    password: document.getElementById('override-password').value,
    baselinePresent: document.getElementById('override-baseline-present').value,
    baselineAbsent: document.getElementById('override-baseline-absent').value,
    enrollmentId: row.enrollmentId
  };

  const res = await fetch(`/api/students/${row.studentDbId}/baseline`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    closeOverrideModal();
    loadDashboard();
  } else {
    const err = await res.json();
    msgEl.textContent = err.error || 'Could not save. Check the password and try again.';
    msgEl.classList.add('error');
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- sync (OneDrive auto-sync via Power Automate) ----------

async function loadSyncTab() {
  const [configRes, statusRes] = await Promise.all([
    fetch('/api/sync-config'),
    fetch('/api/sync-status')
  ]);
  const config = await configRes.json();
  const status = await statusRes.json();

  document.getElementById('sync-students-url').value = config.studentsUrl || '';
  document.getElementById('sync-payments-url').value = config.paymentsUrl || '';
  document.getElementById('sync-interval').value = String(config.intervalMinutes || 5);
  document.getElementById('sync-enabled').value = config.enabled ? 'true' : 'false';

  const sinceInput = document.getElementById('sync-students-since');
  if (config.studentsSinceDate) {
    sinceInput.value = adToBs(config.studentsSinceDate);
  } else {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    sinceInput.value = adToBs(`${tomorrow.getFullYear()}-${mm}-${dd}`);
  }
  refreshAllBsHints();

  renderSyncStatus(status);
}

function renderSyncStatus(status) {
  const body = document.getElementById('sync-status-body');
  const card = document.getElementById('sync-status-card');

  if (!status || !status.ranAt) {
    body.textContent = 'No sync has run yet.';
    card.classList.remove('sync-error');
    return;
  }

  const when = new Date(status.ranAt).toLocaleString();

  if (!status.ok) {
    card.classList.add('sync-error');
    body.innerHTML = `
      <div class="sync-row"><span>Ran</span><span>${escapeHtml(when)} (${escapeHtml(status.trigger || '')})</span></div>
      <div class="sync-row"><span>Result</span><span>Failed — ${escapeHtml(status.error || 'unknown error')}</span></div>
    `;
    return;
  }

  card.classList.remove('sync-error');
  const unmatched = (status.paymentsSkippedUnmatched || []);
  body.innerHTML = `
    <div class="sync-row"><span>Ran</span><span>${escapeHtml(when)} (${escapeHtml(status.trigger || '')})</span></div>
    <div class="sync-row"><span>Students added</span><span>${status.studentsAdded || 0} (${status.studentsSkipped || 0} already on file)</span></div>
    <div class="sync-row"><span>Payments added</span><span>${status.paymentsAdded || 0} (${status.paymentsSkippedDuplicate || 0} already recorded)</span></div>
    ${unmatched.length ? `<div class="sync-row sync-warning"><span>Unmatched payers</span><span>${escapeHtml(unmatched.join(', '))}</span></div>` : ''}
  `;
}

document.getElementById('sync-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('sync-config-status');
  const body = {
    studentsUrl: document.getElementById('sync-students-url').value.trim(),
    paymentsUrl: document.getElementById('sync-payments-url').value.trim(),
    intervalMinutes: document.getElementById('sync-interval').value,
    enabled: document.getElementById('sync-enabled').value === 'true',
    studentsSinceDate: bsToAd(document.getElementById('sync-students-since').value)
  };
  const res = await fetch('/api/sync-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    statusEl.textContent = body.enabled
      ? `Saved. Auto-sync will run every ${body.intervalMinutes} minute${body.intervalMinutes === '1' ? '' : 's'}.`
      : 'Saved. Auto-sync is off — use "Sync now" to run it manually.';
    statusEl.classList.remove('error');
  } else {
    statusEl.textContent = 'Could not save sync settings.';
    statusEl.classList.add('error');
  }
});

document.getElementById('sync-now-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-now-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const res = await fetch('/api/sync-now', { method: 'POST' });
    const result = await res.json();
    renderSyncStatus(result);
  } catch (err) {
    alert('Sync failed. Check the server is running and the flow URLs are correct.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

// ---------- alerts (warning / renewal emails via Power Automate) ----------

async function loadAlertsTab() {
  const [configRes, statusRes] = await Promise.all([
    fetch('/api/alert-config'),
    fetch('/api/alerts/status')
  ]);
  const config = await configRes.json();
  const status = await statusRes.json();

  document.getElementById('alert-flow-url').value = config.flowUrl || '';
  document.getElementById('alert-interval').value = String(config.checkIntervalMinutes || 60);
  document.getElementById('alert-enabled').value = config.enabled ? 'true' : 'false';

  renderAlertRunStatus(status.lastRun);
  renderAlertLists(status.renewals || [], status.warnings || [], status.dues || []);
}

function renderAlertRunStatus(lastRun) {
  const body = document.getElementById('alert-status-body');
  const card = document.getElementById('alert-status-card');

  if (!lastRun || !lastRun.ranAt) {
    body.textContent = 'No check has run yet.';
    card.classList.remove('sync-error');
    return;
  }

  const when = new Date(lastRun.ranAt).toLocaleString();

  if (!lastRun.ok) {
    card.classList.add('sync-error');
    body.innerHTML = `
      <div class="sync-row"><span>Ran</span><span>${escapeHtml(when)} (${escapeHtml(lastRun.trigger || '')})</span></div>
      <div class="sync-row"><span>Result</span><span>${escapeHtml(lastRun.error || 'Not sent')}</span></div>
    `;
    return;
  }

  card.classList.remove('sync-error');
  body.innerHTML = `
    <div class="sync-row"><span>Ran</span><span>${escapeHtml(when)} (${escapeHtml(lastRun.trigger || '')})</span></div>
    <div class="sync-row"><span>Renewal emails sent</span><span>${lastRun.renewalsSent || 0}</span></div>
    <div class="sync-row"><span>Warning emails sent</span><span>${lastRun.warningsSent || 0}</span></div>
    <div class="sync-row"><span>Due emails sent</span><span>${lastRun.duesSent || 0}</span></div>
    <div class="sync-row"><span>Due reminder emails sent (20+ days)</span><span>${lastRun.dueRemindersSent || 0}</span></div>
  `;
}

function renderAlertLists(renewals, warnings, dues) {
  const renewalsBody = document.getElementById('alert-renewals-body');
  const warningsBody = document.getElementById('alert-warnings-body');
  const duesBody = document.getElementById('alert-dues-body');

  renewalsBody.innerHTML = renewals.length
    ? renewals.map((item) => `
        <div class="sync-row sync-warning">
          <span>${escapeHtml(item.name)} (${escapeHtml(item.studentId || '—')})</span>
          <span>${item.present}/${item.allotted} classes · ${escapeHtml(item.duration)} ${escapeHtml(item.course)}</span>
        </div>
      `).join('')
    : 'No students are over their allotment right now.';

  warningsBody.innerHTML = warnings.length
    ? warnings.map((item) => `
        <div class="sync-row">
          <span>${escapeHtml(item.name)} (${escapeHtml(item.studentId || '—')})</span>
          <span>${item.present}/${item.allotted} classes · ${item.remaining} left</span>
        </div>
      `).join('')
    : 'No students are close to their allotment right now.';

  duesBody.innerHTML = (dues || []).length
    ? dues.map((item) => `
        <div class="sync-row sync-warning">
          <span>${escapeHtml(item.name)} (${escapeHtml(item.studentId || '—')})</span>
          <span>Rs. ${item.outstandingBalance.toLocaleString()} due · ${escapeHtml(item.course)}${item.dueSince ? ` · since ${escapeHtml(adToBs(item.dueSince))}` : ''}</span>
        </div>
      `).join('')
    : 'No students have an outstanding due right now.';
}

document.getElementById('alert-config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('alert-config-status');
  const body = {
    flowUrl: document.getElementById('alert-flow-url').value.trim(),
    checkIntervalMinutes: document.getElementById('alert-interval').value,
    enabled: document.getElementById('alert-enabled').value === 'true'
  };
  const res = await fetch('/api/alert-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    statusEl.textContent = body.enabled
      ? `Saved. Alerts will also be checked every ${body.checkIntervalMinutes} minutes, plus right after every attendance save.`
      : 'Saved. Alerts are off — no emails will be sent.';
    statusEl.classList.remove('error');
  } else {
    statusEl.textContent = 'Could not save alert settings.';
    statusEl.classList.add('error');
  }
});

document.getElementById('alerts-check-now-btn').addEventListener('click', async () => {
  const btn = document.getElementById('alerts-check-now-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/alerts/check-now', { method: 'POST' });
    const result = await res.json();
    renderAlertRunStatus(result);
    const statusRes = await fetch('/api/alerts/status');
    const status = await statusRes.json();
    renderAlertLists(status.renewals || [], status.warnings || [], status.dues || []);
  } catch (err) {
    alert('Alert check failed. Check the server is running and the flow URL is correct.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check & send now';
  }
});

// ---------- init ----------

populateTeacherDropdown();
populateCourseDropdown();
populateRollCallTeacherFilter();
loadRollCall();

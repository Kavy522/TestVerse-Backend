/**
 * TestVerse — Staff Live Monitor
 *
 * Reads ?id= from URL → polls these endpoints every N seconds:
 *   GET STAFF_EXAM_LIVE_MONITOR(examId)   → student list, progress, time left
 *   GET STAFF_EXAM_STATISTICS(examId)     → aggregate KPIs
 *
 * Actions (one-shot POSTs):
 *   POST STAFF_EXAM_EXTEND_TIME(examId)   → { student_id?, extra_minutes }
 *   POST STAFF_EXAM_PLAGIARISM(examId)    → {}
 */
'use strict';

// ── State ──────────────────────────────────────────────────────────
let _examId       = null;
let _examData     = null;
let _students     = [];     // raw list from live-monitor
let _pollTimer    = null;
let _countdownId  = null;
let _pollInterval = 15000;  // ms — updated from selector
let _extendTarget = null;   // null = all, else student_id
let _searchQ      = '';
let _statusF      = '';

// ── Boot ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!Auth.requireStaff()) return;
    _initSidebar();
    _initTopbar();

    // Read exam ID from URL
    const params = new URLSearchParams(window.location.search);
    _examId = params.get('id') || params.get('examId');
    if (!_examId) {
        _showAlert('No exam ID provided. Please go back and select an exam.', 'error');
        return;
    }

    _initControls();
    await _loadExamMeta();
    await _fetchLiveData();
    _startPolling();
});

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════

function _initTopbar() {
    const u    = Auth.getUser(); if (!u) return;
    const name = u.name || u.username || 'Staff';
    const av   = _avatar(name);
    _setText('sidebarName', name); _setText('topbarName', name);
    _setImg('sidebarAvatar', av);  _setImg('topbarAvatar', av);
}

function _initSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('sidebarOverlay');
    const o  = () => { sb?.classList.add('open');    ov?.classList.add('show'); };
    const cl = () => { sb?.classList.remove('open'); ov?.classList.remove('show'); };
    document.getElementById('menuToggle')?.addEventListener('click', o);
    document.getElementById('sidebarClose')?.addEventListener('click', cl);
    ov?.addEventListener('click', cl);
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
        if (confirm('Logout from TestVerse?')) Auth.logout();
    });
}

function _initControls() {
    // Poll interval selector
    const sel = document.getElementById('pollInterval');
    sel?.addEventListener('change', () => {
        _pollInterval = parseInt(sel.value, 10);
        _setText('hintInterval', _pollInterval / 1000);
        _startPolling(); // restart with new interval
    });
    _setText('hintInterval', '15');

    // Manual refresh
    document.getElementById('refreshNowBtn')?.addEventListener('click', () => _fetchLiveData());

    // Search
    let timer;
    document.getElementById('studentSearch')?.addEventListener('input', e => {
        clearTimeout(timer);
        timer = setTimeout(() => { _searchQ = e.target.value.toLowerCase(); _renderTable(); }, 200);
    });

    // Status filter
    document.getElementById('statusFilter')?.addEventListener('change', e => {
        _statusF = e.target.value; _renderTable();
    });

    // Extend all time
    document.getElementById('extendAllBtn')?.addEventListener('click', () => {
        _extendTarget = null;
        _setText('extendSubText', 'Extend time for ALL active students in this exam.');
        _openModal('extendModal');
    });

    // Extend modal controls
    document.getElementById('extendMinus')?.addEventListener('click', () => {
        const inp = document.getElementById('extendMinutes');
        inp.value = Math.max(1, parseInt(inp.value||10) - 5);
    });
    document.getElementById('extendPlus')?.addEventListener('click', () => {
        const inp = document.getElementById('extendMinutes');
        inp.value = Math.min(120, parseInt(inp.value||10) + 5);
    });
    document.getElementById('extendModalClose')?.addEventListener('click', () => _closeModal('extendModal'));
    document.getElementById('extendCancelBtn')?.addEventListener('click',  () => _closeModal('extendModal'));
    document.getElementById('extendConfirmBtn')?.addEventListener('click', _confirmExtend);
    document.getElementById('extendModal')?.addEventListener('click', e => {
        if (e.target.id === 'extendModal') _closeModal('extendModal');
    });

    // Plagiarism
    document.getElementById('plagiarismBtn')?.addEventListener('click', () => {
        document.getElementById('plagResult').style.display = 'none';
        _openModal('plagModal');
    });
    document.getElementById('plagModalClose')?.addEventListener('click',  () => _closeModal('plagModal'));
    document.getElementById('plagCancelBtn')?.addEventListener('click',   () => _closeModal('plagModal'));
    document.getElementById('plagConfirmBtn')?.addEventListener('click',  _runPlagiarism);
    document.getElementById('plagModal')?.addEventListener('click', e => {
        if (e.target.id === 'plagModal') _closeModal('plagModal');
    });
}

// ══════════════════════════════════════════════════════════════════
//  DATA LOADING
// ══════════════════════════════════════════════════════════════════

async function _loadExamMeta() {
    try {
        const res = await Api.get(CONFIG.ENDPOINTS.STAFF_EXAM_DETAIL(_examId));
        const { data, error } = await Api.parse(res);
        if (error || !data) return;
        _examData = data;
        _renderExamHeader(data);
        _startCountdown(data.end_time);
    } catch { /* non-critical */ }
}

async function _fetchLiveData() {
    _spinPollIcon(true);
    try {
        // Fetch both in parallel
        const [monRes, statRes] = await Promise.all([
            Api.get(CONFIG.ENDPOINTS.STAFF_EXAM_LIVE_MONITOR(_examId)),
            Api.get(CONFIG.ENDPOINTS.STAFF_EXAM_STATISTICS(_examId)),
        ]);

        const { data: monData,  error: monErr  } = await Api.parse(monRes);
        const { data: statData, error: statErr } = await Api.parse(statRes);

        if (monErr && statErr) {
            _showAlert('Could not fetch live data. Retrying…', 'error'); return;
        }

        // Students come from live-monitor endpoint
        const students = Array.isArray(monData)
            ? monData
            : (monData?.students ?? monData?.results ?? []);
        _students = students;

        // Build KPIs from statistics endpoint OR compute from student list
        const kpi = _buildKpis(statData, students);
        _renderKpis(kpi);
        _renderAggBar(kpi);
        _renderTable();

        // Update last refresh time
        _setText('kpiLastUpdate', _timeNow());
        _updateLiveIndicator(true);
        _clearAlert();

        // Show content first time
        document.getElementById('pageLoading').style.display  = 'none';
        document.getElementById('monitorContent').style.display = '';
        document.getElementById('examHeaderCard').style.display = '';

    } catch (err) {
        _showAlert('Network error during live fetch.', 'error');
    } finally {
        _spinPollIcon(false);
    }
}

// ──────────────────────────────────────────────────────────────────
//  KPIs
// ──────────────────────────────────────────────────────────────────
function _buildKpis(stat, students) {
    // Prefer stats endpoint values, fallback to computing from student list
    const total      = stat?.total_students  ?? stat?.total       ?? students.length;
    const active     = stat?.active_students ?? stat?.in_progress ??
                       students.filter(s => _normStatus(s) === 'in_progress').length;
    const submitted  = stat?.submitted_count ?? stat?.submitted   ??
                       students.filter(s => _normStatus(s) === 'submitted').length;
    const notStarted = total - active - submitted;
    const avgProg    = stat?.average_progress ??
                       (students.length
                           ? (students.reduce((a,s) => a + _normPct(s), 0) / students.length).toFixed(0)
                           : 0);
    return { total, active, submitted, notStarted: Math.max(0, notStarted), avgProg };
}

function _renderKpis(k) {
    _setText('kpiActive',     k.active);
    _setText('kpiSubmitted',  k.submitted);
    _setText('kpiNotStarted', k.notStarted);
    _setText('kpiTotal',      k.total);
    _setText('kpiAvgProg',    k.avgProg + '%');
}

function _renderAggBar(k) {
    const tot  = k.total || 1;
    const subP = ((k.submitted  / tot) * 100).toFixed(1);
    const actP = ((k.active     / tot) * 100).toFixed(1);
    const pct  = ((( k.submitted + k.active) / tot) * 100).toFixed(0);
    _setProp('aggSubmittedFill', 'width', subP + '%');
    _setProp('aggActiveFill',    'width', actP + '%');
    _setText('aggPct', pct + '%');
}

// ──────────────────────────────────────────────────────────────────
//  TABLE
// ──────────────────────────────────────────────────────────────────
function _renderTable() {
    const tbody = document.getElementById('monitorTableBody');
    const empty = document.getElementById('tableEmpty');
    if (!tbody) return;

    // Filter
    let list = _students.filter(s => {
        const st = s.student || s.user || s;
        const name  = (st.name || st.username || st.email || '').toLowerCase();
        const email = (st.email || '').toLowerCase();
        const matchQ = !_searchQ || name.includes(_searchQ) || email.includes(_searchQ);
        const matchS = !_statusF || _normStatus(s) === _statusF;
        return matchQ && matchS;
    });

    _setText('monitorCount', `${list.length} student${list.length !== 1 ? 's' : ''}`);

    if (!list.length) {
        tbody.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = list.map((s, idx) => _buildRow(s, idx + 1)).join('');
}

function _buildRow(s, idx) {
    const st       = s.student || s.user || {};
    const name     = st.name || st.username || st.email?.split('@')[0] || '—';
    const email    = st.email || '';
    const status   = _normStatus(s);
    const pct      = _normPct(s);
    const answered = s.answered_questions ?? s.answers_count ?? '—';
    const total_q  = s.total_questions    ?? '—';
    const timeLeft = _fmtTimeLeft(s);
    const startedAt= s.started_at ? _fmtTime(s.started_at) : '—';
    const av       = _avatar(name);

    const statusHTML = {
        in_progress: `<span class="status-badge s-in-progress"><span class="s-dot"></span>In Progress</span>`,
        submitted:   `<span class="status-badge s-submitted"><span class="s-dot"></span>Submitted</span>`,
        not_started: `<span class="status-badge s-not-started"><span class="s-dot"></span>Not Started</span>`,
    }[status] || `<span class="status-badge s-not-started">${status}</span>`;

    const timeClass = _timeClass(s);
    const extendBtn = status !== 'submitted'
        ? `<button class="btn-extend" onclick="window._extendSingle('${st.id}','${_esc(name)}')">
               <i class="fas fa-plus"></i> +Time
           </button>`
        : `<span style="color:#334155;font-size:.75rem;">Submitted</span>`;

    return `<tr>
        <td class="row-num">${idx}</td>
        <td>
            <div class="student-cell">
                <img class="student-avatar" src="${av}" alt="">
                <div>
                    <div class="student-name">${_esc(name)}</div>
                    <div class="student-email">${_esc(email)}</div>
                </div>
            </div>
        </td>
        <td>${statusHTML}</td>
        <td>
            <div class="progress-cell">
                <div class="prog-track">
                    <div class="prog-fill" style="width:${pct}%"></div>
                </div>
                <span class="prog-pct">${pct}%</span>
            </div>
        </td>
        <td style="font-weight:600;color:#94a3b8;">${answered}${total_q !== '—' ? '<span style="color:#334155;font-weight:400;"> / '+total_q+'</span>' : ''}</td>
        <td><span class="time-left ${timeClass}">${timeLeft}</span></td>
        <td style="font-size:.78rem;color:#475569;">${startedAt}</td>
        <td>${extendBtn}</td>
    </tr>`;
}

// ──────────────────────────────────────────────────────────────────
//  EXAM HEADER + COUNTDOWN
// ──────────────────────────────────────────────────────────────────
function _renderExamHeader(e) {
    _setText('examTitle',    e.title || '—');
    _setText('examType',     e.exam_type || '—');
    _setText('examDuration', e.duration || '—');
    _setText('examMarks',    e.total_marks || '—');
    _setText('examStart',    e.start_time ? _fmtTime(e.start_time) : '—');
    _setText('examEnd',      e.end_time   ? _fmtTime(e.end_time)   : '—');
}

function _startCountdown(endTimeIso) {
    if (_countdownId) clearInterval(_countdownId);
    const el = document.getElementById('examCountdown');
    if (!el || !endTimeIso) return;
    const end = new Date(endTimeIso).getTime();
    const tick = () => {
        const diff = end - Date.now();
        if (diff <= 0) {
            el.textContent = 'ENDED';
            el.classList.add('urgent');
            clearInterval(_countdownId);
            return;
        }
        el.textContent = _fmtMs(diff);
        el.classList.toggle('urgent', diff < 5 * 60 * 1000); // urgent if < 5 min
    };
    tick();
    _countdownId = setInterval(tick, 1000);
}

// ══════════════════════════════════════════════════════════════════
//  ACTIONS
// ══════════════════════════════════════════════════════════════════

// Expose for inline onclick
window._extendSingle = (studentId, name) => {
    _extendTarget = studentId;
    _setText('extendSubText', `Extend time for: ${name}`);
    _openModal('extendModal');
};

async function _confirmExtend() {
    const mins = parseInt(document.getElementById('extendMinutes')?.value || '10', 10);
    if (!mins || mins < 1 || mins > 120) {
        _showAlert('Enter between 1–120 minutes.', 'error'); return;
    }

    const btn     = document.getElementById('extendConfirmBtn');
    const payload = { extra_minutes: mins };
    if (_extendTarget) payload.student_id = _extendTarget;

    _setBtnLoading(btn, true);
    try {
        const res = await Api.post(CONFIG.ENDPOINTS.STAFF_EXAM_EXTEND_TIME(_examId), payload);
        const { error } = await Api.parse(res);
        if (error) {
            _showAlert(_extractErr(error), 'error');
        } else {
            _closeModal('extendModal');
            _showAlert(
                _extendTarget
                    ? `✓ Extended time by ${mins} min for selected student.`
                    : `✓ Extended time by ${mins} min for all active students.`,
                'success'
            );
            await _fetchLiveData(); // refresh immediately
        }
    } catch {
        _showAlert('Network error. Could not extend time.', 'error');
    } finally {
        _setBtnLoading(btn, false);
    }
}

async function _runPlagiarism() {
    const btn    = document.getElementById('plagConfirmBtn');
    const result = document.getElementById('plagResult');
    _setBtnLoading(btn, true);
    try {
        const res = await Api.post(CONFIG.ENDPOINTS.STAFF_EXAM_PLAGIARISM(_examId), {});
        const { data, error } = await Api.parse(res);
        if (error) {
            _showAlert(_extractErr(error), 'error');
        } else {
            const msg = data?.message || data?.detail || 'Plagiarism check triggered. Results will appear shortly.';
            result.textContent = msg;
            result.style.display = 'block';
            _showAlert('✓ Plagiarism check is running in the background.', 'success');
        }
    } catch {
        _showAlert('Network error. Could not trigger plagiarism check.', 'error');
    } finally {
        _setBtnLoading(btn, false);
    }
}

// ══════════════════════════════════════════════════════════════════
//  POLLING
// ══════════════════════════════════════════════════════════════════
function _startPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(_fetchLiveData, _pollInterval);
}

// Stop polling when tab hidden, resume when visible (saves API calls)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearInterval(_pollTimer); _pollTimer = null;
        _updateLiveIndicator(false);
    } else {
        _fetchLiveData();
        _startPolling();
        _updateLiveIndicator(true);
    }
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    clearInterval(_pollTimer);
    clearInterval(_countdownId);
});

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function _normStatus(s) {
    const raw = s.status || s.attempt_status || '';
    if (/in.?progress|ongoing|started/i.test(raw)) return 'in_progress';
    if (/submit/i.test(raw))                        return 'submitted';
    return 'not_started';
}

function _normPct(s) {
    if (s.progress_percentage != null) return parseFloat(s.progress_percentage).toFixed(0);
    if (s.progress != null) return parseFloat(s.progress).toFixed(0);
    const a = s.answered_questions ?? 0;
    const t = s.total_questions    ?? 1;
    return t > 0 ? Math.round((a / t) * 100) : 0;
}

function _fmtTimeLeft(s) {
    if (_normStatus(s) === 'submitted') return 'Done';
    if (!s.time_remaining && s.time_remaining !== 0) return '—';
    const secs = parseInt(s.time_remaining, 10);
    if (secs <= 0) return '00:00';
    return _fmtMs(secs * 1000);
}

function _timeClass(s) {
    if (_normStatus(s) === 'submitted') return 'done';
    const secs = parseInt(s.time_remaining ?? -1, 10);
    if (secs < 0)    return '';
    if (secs < 300)  return 'low';    // < 5 min
    if (secs < 900)  return 'mid';    // < 15 min
    return 'ok';
}

function _fmtMs(ms) {
    const s   = Math.floor(ms / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const p   = n => String(n).padStart(2, '0');
    return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function _fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
}

function _timeNow() {
    return new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function _spinPollIcon(on) {
    document.getElementById('pollIcon')?.classList.toggle('spinning', on);
}

function _updateLiveIndicator(on) {
    const el = document.getElementById('liveIndicator');
    if (!el) return;
    el.style.opacity = on ? '1' : '0.4';
}

// Modal helpers
function _openModal(id)  { document.getElementById(id)?.classList.add('show'); }
function _closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

// Button loading
function _setBtnLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.querySelector('.btn-text')?.classList.toggle('hidden', on);
    btn.querySelector('.btn-loader')?.classList.toggle('hidden', !on);
}

// Alert
let _alertTimer;
function _showAlert(msg, type = 'info') {
    const w = document.getElementById('alertContainer'); if (!w) return;
    const icons = { error:'exclamation-circle', success:'check-circle', info:'info-circle', warning:'exclamation-triangle' };
    w.innerHTML = `<div class="alert alert-${type}"><i class="fas fa-${icons[type]||'info-circle'}"></i><span>${_esc(msg)}</span></div>`;
    clearTimeout(_alertTimer);
    _alertTimer = setTimeout(() => { w.innerHTML = ''; }, type === 'error' ? 8000 : 4000);
}
function _clearAlert() {
    const w = document.getElementById('alertContainer'); if (w) w.innerHTML = '';
}

function _avatar(n) { return `https://ui-avatars.com/api/?name=${encodeURIComponent(n||'?')}&background=6366f1&color=fff&size=64`; }
function _setText(id, v)    { const e = document.getElementById(id); if (e) e.textContent = String(v ?? ''); }
function _setImg(id, src)   { const e = document.getElementById(id); if (e) e.src = src; }
function _setProp(id, p, v) { const e = document.getElementById(id); if (e) e.style[p] = v; }
function _extractErr(e) {
    if (!e) return 'Something went wrong.';
    if (typeof e === 'string') return e;
    return e.detail || e.message || e.error || Object.values(e)[0] || 'Something went wrong.';
}
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

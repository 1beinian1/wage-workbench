/* ============================================================
   app.js — 幸运咖兼职工资工作台 核心逻辑
   Implements C1-C8 per PRD §4
   ============================================================ */

(function () {
  'use strict';

  /* ===== App State ===== */
  const state = {
    db: null,
    settings: null,
    currentTab: 'calendar',
    viewYear: 0,
    viewMonth: 0,        // 0-based month for calendar view
    selectedDate: null,   // 'YYYY-MM-DD'
    selectedRecord: null, // current workRecord object (or null)
    cycleDetailPeriod: null,
    pendingImportData: null
  };

  /* ===== DOM Shortcuts ===== */
  const $ = (id) => document.getElementById(id);

  /* ============================================================
     INIT
     ============================================================ */
  async function init() {
    try {
      state.db = await openDB();
      state.settings = await getSettings();

      // Set current month to today
      const now = new Date();
      state.viewYear = now.getFullYear();
      state.viewMonth = now.getMonth();
      state.selectedDate = formatDateKey(now);
      document.body.classList.add('calendar-active');

      // Request persistent storage (C7/C8)
      requestPersistentStorage();

      // Register Service Worker (C8)
      registerSW();

      // Render all views
      await renderCalendar();
      await renderWageTab();
      renderSettings();

      // Check reminders (C4)
      await checkReminders();

      // Show install banner if browser mode (C8)
      checkInstallBanner();

      // Bind all events
      bindEvents();
    } catch (err) {
      console.error('Init failed:', err);
      showToast('应用初始化失败，请刷新重试');
    }
  }

  /* ============================================================
     C8: PWA — Service Worker + Storage Persist + Install Banner
     ============================================================ */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        console.log('Persistent storage:', granted ? 'granted' : 'not granted');
      }).catch(() => {});
    }
  }

  function checkInstallBanner() {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;

    if (!isStandalone) {
      try {
        const dismissed = localStorage.getItem('installBannerDismissed');
        if (!dismissed) {
          $('installBanner').classList.remove('hidden');
        }
      } catch (e) { /* localStorage may be blocked */ }
    }
  }

  function dismissInstallBanner() {
    $('installBanner').classList.add('hidden');
    try { localStorage.setItem('installBannerDismissed', '1'); } catch (e) {}
  }

  /* ============================================================
     C4: Reminder Banner — Payday + Missing Days
     ============================================================ */
  async function checkReminders() {
    const banner = $('reminderBanner');
    let html = '';
    let cls = '';

    // Check payday reminder
    const paydayReminder = await checkPaydayReminder();
    if (paydayReminder) {
      cls = 'payday';
      html = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>
        </svg>
        <span>今天是发薪日，去核对实发工资</span>
      `;
    } else {
      // Check missing days
        const missing = await getMissingDays();
      if (missing.length > 0) {
        cls = 'missing';
        html = `
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>
          </svg>
          <span>${missing.length} 天未录工时，点击去补录</span>
        `;
        // Store missing dates for navigation
        state._missingDates = missing;
      }
    }

    if (html) {
      banner.className = `reminder-banner ${cls}`;
      banner.innerHTML = html;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  /* ============================================================
     Tab Navigation
     ============================================================ */
  function switchTab(tabName) {
    state.currentTab = tabName;
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.remove('active');
    });
    $(`tab-${tabName}`).classList.add('active');
    document.querySelectorAll('.tab-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });
    document.body.classList.toggle('calendar-active', tabName === 'calendar');
  }

  /* ============================================================
     C2: Calendar View
     ============================================================ */
  async function renderCalendar() {
    const year = state.viewYear;
    const month = state.viewMonth;

    // Month title
    $('monthTitle').textContent = `${year}年${month + 1}月`;

    // Calendar grid
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startWeekday = firstDay.getDay(); // 0=Sun
    const daysInMonth = lastDay.getDate();

    const today = new Date();
    const todayKey = formatDateKey(today);

    const body = $('calendarBody');
    body.innerHTML = '';

    // Get all records for this month
    const periodKey = getPeriodKey(firstDay);
    const records = await getRecordsByPeriod(periodKey);
    const recordMap = {};
    records.forEach((r) => { recordMap[r.date] = r; });

    // Empty cells before first day
    for (let i = 0; i < startWeekday; i++) {
      const cell = document.createElement('div');
      cell.className = 'cal-cell empty';
      body.appendChild(cell);
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const record = recordMap[dateKey];

      cell.className = 'cal-cell';
      cell.dataset.date = dateKey;

      // Determine state
      const isToday = dateKey === todayKey;
      const isFuture = new Date(year, month, d) > today && !isToday;
      const isPast = new Date(year, month, d) < today && !isToday;

      let innerHTML = `<span class="cal-date">${d}</span>`;

      if (record) {
        if (record.isRest) {
          cell.classList.add('rest');
          innerHTML = `<span class="cal-date">休</span>`;
        } else if (record.hours > 0) {
          cell.classList.add('work');
          innerHTML += `<span class="cal-hours">${record.hours.toFixed(1)}h</span>`;
        } else {
          // hours=0, not rest → missing (漏记态)
          if (isPast) {
            cell.classList.add('missing');
            innerHTML += `<span class="cal-missing-label">未录</span>`;
          }
        }
      } else {
        // No record
        if (isPast) {
          cell.classList.add('missing');
          innerHTML += `<span class="cal-missing-label">未录</span>`;
        } else if (isFuture) {
          cell.classList.add('future');
        }
      }

      if (isToday) cell.classList.add('today');
      if (dateKey === state.selectedDate) cell.classList.add('selected');

      cell.innerHTML = innerHTML;
      cell.addEventListener('click', () => selectDate(dateKey));
      body.appendChild(cell);
    }

    // Keep six rows so the calendar height stays stable across months.
    while (body.children.length < 42) {
      const cell = document.createElement('div');
      cell.className = 'cal-cell empty';
      body.appendChild(cell);
    }

    // Update summary
    await updateSummary(periodKey);

    // Populate the day edit sheet for the currently selected date.
    await renderDayEditCard();
  }

  /* ===== C3: Monthly Summary ===== */
  async function updateSummary(periodKey) {
    const stats = await getPeriodStats(periodKey);
    $('sumDays').textContent = stats.days;
    $('sumHours').textContent = stats.totalHours.toFixed(1);
    $('sumWage').textContent = `¥${stats.expectedWage.toFixed(2)}`;
  }

  /* ===== C1: Select Date + Render Edit Card ===== */
  async function selectDate(dateKey) {
    state.selectedDate = dateKey;
    // Update selected highlight
    document.querySelectorAll('.cal-cell').forEach((c) => {
      c.classList.toggle('selected', c.dataset.date === dateKey);
    });
    await renderDayEditCard();
    openDayEditSheet();
  }

  async function renderDayEditCard() {
    const dateKey = state.selectedDate;
    if (!dateKey) return;

    const record = await getWorkRecord(dateKey);
    state.selectedRecord = record;

    // Parse date for display
    const [y, m, d] = dateKey.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][dateObj.getDay()];
    $('dayEditDate').textContent = `${m}月${d}日 周${weekday}`;

    // Hours
    const hours = record && !record.isRest ? (record.hours || 0) : 0;
    $('hoursInput').value = hours > 0 ? hours.toFixed(1) : '';
    $('hoursError').classList.add('hidden');

    // Wage display
    const rate = record ? record.rate : state.settings.hourlyRate;
    const wage = hours * rate;
    $('dayEditWage').textContent = `¥${wage.toFixed(2)}`;

    // Rest toggle
    const isRest = record ? record.isRest : false;
    const restBtn = $('restToggle');
    restBtn.classList.toggle('active', isRest);
    $('restToggleText').textContent = isRest ? '已标记为休息日' : '标记为休息日';

    // Delete button
    $('deleteRecordBtn').classList.toggle('hidden', !record);

    // If rest day, disable hours input visually
    const hoursInput = $('hoursInput');
    hoursInput.disabled = isRest;
    hoursInput.placeholder = isRest ? '休息日' : '0.0';
  }

  /* ===== C1: Save Work Record ===== */
  async function saveCurrentRecord() {
    const dateKey = state.selectedDate;
    if (!dateKey) return;

    const existing = state.selectedRecord;
    const isRest = $('restToggle').classList.contains('active');

    if (isRest) {
      // Rest day: hours=0
      const record = {
        ...existing,
        date: dateKey,
        hours: 0,
        rate: existing && existing.rate ? existing.rate : state.settings.hourlyRate,
        isRest: true,
        createdAt: existing ? existing.createdAt : undefined
      };
      await saveWorkRecord(record);
      state.selectedRecord = await getWorkRecord(dateKey);
      await renderCalendar();
      await checkReminders();
      await renderWageTab();
      return true;
    }

    // Parse hours
    const hoursStr = $('hoursInput').value.trim();
    const hours = hoursStr === '' ? 0 : parseFloat(hoursStr);

    // Validate
    if (isNaN(hours) || hours < 0 || hours > 24) {
      $('hoursError').classList.remove('hidden');
      return false;
    }

    // Round to 0.1
    const roundedHours = Math.round(hours * 10) / 10;

    // If hours=0 and no existing record → delete (or don't create)
    if (roundedHours === 0 && !existing) {
      $('dayEditWage').textContent = '¥0.00';
      await renderCalendar();
      await checkReminders();
      return true;
    }

    // If hours=0 and existing record → delete record (turn to missing/rest)
    if (roundedHours === 0 && existing && !existing.isRest) {
      await deleteWorkRecord(dateKey);
      state.selectedRecord = null;
      await renderDayEditCard();
      await renderCalendar();
      await checkReminders();
      return true;
    }

    // Rate snapshot: use existing record's rate, or current settings rate for new records
    const rate = existing && existing.rate ? existing.rate : state.settings.hourlyRate;

    const record = {
      ...existing,
      date: dateKey,
      hours: roundedHours,
      rate: rate,
      isRest: false,
      createdAt: existing ? existing.createdAt : undefined
    };

    await saveWorkRecord(record);
    state.selectedRecord = await getWorkRecord(dateKey);

    // Update wage display
    const wage = roundedHours * rate;
    $('dayEditWage').textContent = `¥${wage.toFixed(2)}`;

    await renderCalendar();
    await checkReminders();
    await renderWageTab();
    return true;
  }

  /* ===== C1: Toggle Rest ===== */
  async function toggleRest() {
    const restBtn = $('restToggle');
    const isRest = !restBtn.classList.contains('active');
    restBtn.classList.toggle('active', isRest);
    $('restToggleText').textContent = isRest ? '已标记为休息日' : '标记为休息日';
    $('hoursInput').disabled = isRest;
    $('hoursInput').value = isRest ? '' : ($('hoursInput').value);
    updateDayEditWage();
  }

  /* ===== C1: Step Hours ===== */
  function stepHours(delta) {
    const input = $('hoursInput');
    let val = parseFloat(input.value) || 0;
    val = Math.round((val + delta) * 10) / 10;
    val = Math.max(0, Math.min(24, val));
    input.value = val.toFixed(1);
    updateDayEditWage();
  }

  /* ===== C1: Quick Set Hours ===== */
  function quickSetHours(hours) {
    if (hours === 0) {
      $('hoursInput').value = '';
    } else {
      $('hoursInput').value = hours.toFixed(1);
    }
    updateDayEditWage();
  }

  function updateDayEditWage() {
    const hours = $('restToggle').classList.contains('active')
      ? 0
      : parseFloat($('hoursInput').value) || 0;
    const rate = state.selectedRecord && state.selectedRecord.rate
      ? state.selectedRecord.rate
      : state.settings.hourlyRate;
    $('dayEditWage').textContent = `¥${(hours * rate).toFixed(2)}`;
  }

  /* ===== C1: Delete Record ===== */
  async function deleteCurrentRecord() {
    if (!state.selectedDate) return;
    await deleteWorkRecord(state.selectedDate);
    state.selectedRecord = null;
    await renderDayEditCard();
    await renderCalendar();
    await checkReminders();
    await renderWageTab();
    showToast('记录已删除');
    closeDayEditSheet();
  }

  function openDayEditSheet() {
    const sheet = $('dayEditSheet');
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeDayEditSheet() {
    const sheet = $('dayEditSheet');
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }

  async function saveAndCloseDayEditSheet() {
    const saved = await saveCurrentRecord();
    if (saved) {
      closeDayEditSheet();
      showToast('记录已保存');
    }
  }

  /* ============================================================
     C3/C5: Wage Tab
     ============================================================ */
  async function renderWageTab() {
    const list = $('cycleList');
    list.innerHTML = '';

    // Collect all periods from work records + pay cycles
    const allRecords = await getAllWorkRecords();
    const allCycles = await getAllPayCycles();

    const periodsSet = new Set();
    allRecords.forEach((r) => periodsSet.add(r.period || _derivePeriod(r.date)));
    allCycles.forEach((c) => periodsSet.add(c.periodKey));

    // Always include current period
    periodsSet.add(getPeriodKey(new Date()));

    // Sort descending
    const periods = Array.from(periodsSet).sort().reverse();

    if (periods.length === 0) {
      list.innerHTML = '<div class="clay-card" style="text-align:center;color:var(--muted);padding:40px;">暂无工资周期记录</div>';
      return;
    }

    for (const period of periods) {
      const stats = await getPeriodStats(period);
      const cycle = allCycles.find((c) => c.periodKey === period);

      const [y, m] = period.split('-').map(Number);
      const periodLabel = `${y}年${m}月`;

      const expected = stats.expectedWage;
      const actual = cycle ? cycle.actualWage : null;
      const isPaid = cycle ? cycle.isPaid : false;

      let actualText = '—';
      if (actual !== null && actual !== undefined) {
        actualText = `实发 ¥${actual.toFixed(2)}`;
      } else {
        actualText = '未核对';
      }

      const badgeClass = isPaid ? 'paid' : 'unpaid';
      const badgeText = isPaid ? '已发' : '待发';

      const item = document.createElement('div');
      item.className = 'cycle-item';
      item.innerHTML = `
        <div class="cycle-item-info">
          <span class="cycle-period">${periodLabel}</span>
          <span class="cycle-expected-text">应发 ¥${expected.toFixed(2)}</span>
          <span class="cycle-actual-text">${actualText}</span>
        </div>
        <div class="cycle-item-right">
          <span class="cycle-amount">¥${expected.toFixed(2)}</span>
          <span class="cycle-badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
      item.addEventListener('click', () => openCycleDetail(period));
      list.appendChild(item);
    }
  }

  /* ===== C5: Cycle Detail ===== */
  async function openCycleDetail(period) {
    state.cycleDetailPeriod = period;
    await renderCycleDetail();
    $('cycleDetail').classList.remove('hidden');
  }

  function closeCycleDetail() {
    $('cycleDetail').classList.add('hidden');
    state.cycleDetailPeriod = null;
  }

  async function renderCycleDetail() {
    const period = state.cycleDetailPeriod;
    if (!period) return;

    const [y, m] = period.split('-').map(Number);
    $('cycleDetailPeriod').textContent = `${y}年${m}月`;

    const stats = await getPeriodStats(period);
    $('cycleDays').textContent = stats.days;
    $('cycleHours').textContent = `${stats.totalHours.toFixed(1)}h`;
    $('cycleAvg').textContent = `${stats.avgHours.toFixed(1)}h`;
    $('cycleExpected').textContent = `¥${stats.expectedWage.toFixed(2)}`;

    // Load pay cycle
    const cycle = await getPayCycle(period);
    const actualWage = cycle ? cycle.actualWage : null;
    const isPaid = cycle ? cycle.isPaid : false;

    $('actualWageInput').value = (actualWage !== null && actualWage !== undefined) ? actualWage.toFixed(2) : '';

    // Diff box
    const diffBox = $('diffBox');
    if (actualWage !== null && actualWage !== undefined) {
      const diff = stats.expectedWage - actualWage;
      diffBox.classList.remove('hidden', 'positive', 'negative', 'zero');
      if (Math.abs(diff) < 0.01) {
        diffBox.classList.add('zero');
      } else if (diff > 0) {
        diffBox.classList.add('positive');
      } else {
        diffBox.classList.add('negative');
      }
      const sign = diff > 0 ? '+' : '';
      $('diffValue').textContent = `${sign}¥${diff.toFixed(2)}`;
    } else {
      diffBox.classList.add('hidden');
    }

    // Mark paid button
    const markBtn = $('markPaidBtn');
    if (isPaid) {
      markBtn.classList.add('paid');
      $('markPaidText').textContent = '已标记已发（点击取消）';
    } else {
      markBtn.classList.remove('paid');
      $('markPaidText').textContent = '标记已发';
    }
  }

  /* ===== C5: Save Actual Wage ===== */
  async function saveActualWage() {
    const period = state.cycleDetailPeriod;
    if (!period) return;

    const valStr = $('actualWageInput').value.trim();
    const actualWage = valStr === '' ? null : parseFloat(valStr);

    if (actualWage !== null && (isNaN(actualWage) || actualWage < 0)) {
      showToast('请输入有效金额');
      return;
    }

    const existing = await getPayCycle(period);
    const paydayISO = computePaydayISO(period, state.settings.payday);

    const cycle = {
      periodKey: period,
      actualWage: actualWage,
      isPaid: existing ? existing.isPaid : false,
      payday: paydayISO,
      paidAt: existing ? existing.paidAt : null
    };

    await savePayCycle(cycle);
    await renderCycleDetail();
    showToast('实发金额已保存');
  }

  /* ===== C5: Toggle Paid ===== */
  async function togglePaid() {
    const period = state.cycleDetailPeriod;
    if (!period) return;

    const existing = await getPayCycle(period);
    const isPaid = existing ? existing.isPaid : false;
    const paydayISO = computePaydayISO(period, state.settings.payday);

    const valStr = $('actualWageInput').value.trim();
    const actualWage = valStr === '' ? null : parseFloat(valStr);

    const cycle = {
      periodKey: period,
      actualWage: actualWage !== null && !isNaN(actualWage) ? actualWage : (existing ? existing.actualWage : null),
      isPaid: !isPaid,
      payday: paydayISO,
      paidAt: !isPaid ? Date.now() : null
    };

    await savePayCycle(cycle);
    await renderCycleDetail();
    await renderWageTab();
    await checkReminders();
    showToast(isPaid ? '已取消标记' : '已标记为已发');
  }

  /* ============================================================
     C6: Settings Tab
     ============================================================ */
  function renderSettings() {
    $('hourlyRateInput').value = state.settings.hourlyRate;
    $('paydayInput').value = state.settings.payday;
  }

  async function saveHourlyRate() {
    const val = parseFloat($('hourlyRateInput').value);
    if (isNaN(val) || val < 0) {
      showToast('请输入有效时薪');
      return;
    }
    state.settings = await saveSettings({ hourlyRate: val });
    showToast('时薪已保存（仅影响此后新记录）');
    await renderDayEditCard();
  }

  async function savePayday() {
    const val = parseInt($('paydayInput').value, 10);
    if (isNaN(val) || val < 1 || val > 28) {
      showToast('发薪日须在 1–28 之间');
      return;
    }
    state.settings = await saveSettings({ payday: val });
    showToast('发薪日已保存');
    await checkReminders();
  }

  /* ============================================================
     C7: Export / Import
     ============================================================ */
  async function exportJSON() {
    try {
      const data = await exportData();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wage-backup-${formatDateKey(new Date())}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('JSON 备份已导出');
    } catch (err) {
      console.error('Export failed:', err);
      showToast('导出失败');
    }
  }

  function triggerImport() {
    $('importFileInput').click();
  }

  async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const jsonData = JSON.parse(text);
      const parsed = await importData(jsonData);
      state.pendingImportData = parsed;

      // Show preview
      const info = $('importPreviewInfo');
      info.innerHTML = `
        工时记录：<strong>${parsed.affectedDates.length}</strong> 条<br>
        工资周期：<strong>${parsed.affectedPeriods.length}</strong> 个<br>
        <span style="color:var(--danger-dark);font-weight:600;">注意：导入将覆盖本地所有同日期数据</span>
      `;
      $('importPreview').classList.remove('hidden');
    } catch (err) {
      console.error('Import parse failed:', err);
      showToast('文件解析失败，请检查 JSON 格式');
    }

    // Reset input
    e.target.value = '';
  }

  async function confirmImport() {
    if (!state.pendingImportData) return;

    try {
      await applyImport(state.pendingImportData);

      // Reload settings
      state.settings = await getSettings();

      // Re-render everything
      renderSettings();
      const now = new Date();
      state.viewYear = now.getFullYear();
      state.viewMonth = now.getMonth();
      await renderCalendar();
      await renderWageTab();
      await checkReminders();

      $('importPreview').classList.add('hidden');
      state.pendingImportData = null;
      showToast('数据导入成功');
    } catch (err) {
      console.error('Import apply failed:', err);
      showToast('导入失败');
    }
  }

  function cancelImport() {
    $('importPreview').classList.add('hidden');
    state.pendingImportData = null;
  }

  /* ============================================================
     Toast Utility
     ============================================================ */
  let toastTimer = null;
  function showToast(msg) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 2500);
  }

  /* ============================================================
     Event Bindings
     ============================================================ */
  function bindEvents() {
    // Tab navigation
    document.querySelectorAll('.tab-item').forEach((item) => {
      item.addEventListener('click', () => switchTab(item.dataset.tab));
    });

    // Month navigation
    $('prevMonth').addEventListener('click', () => {
      state.viewMonth--;
      if (state.viewMonth < 0) {
        state.viewMonth = 11;
        state.viewYear--;
      }
      renderCalendar();
    });

    $('nextMonth').addEventListener('click', () => {
      state.viewMonth++;
      if (state.viewMonth > 11) {
        state.viewMonth = 0;
        state.viewYear++;
      }
      renderCalendar();
    });

    // Hours stepper
    $('hoursMinus').addEventListener('click', () => stepHours(-0.1));
    $('hoursPlus').addEventListener('click', () => stepHours(0.1));

    // Hours input — validate and save explicitly.
    $('hoursInput').addEventListener('input', updateDayEditWage);
    $('hoursInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        saveAndCloseDayEditSheet();
      }
    });

    // Quick hours
    document.querySelectorAll('.quick-hour-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = parseFloat(btn.dataset.hours);
        quickSetHours(h);
      });
    });

    // Rest toggle
    $('restToggle').addEventListener('click', toggleRest);

    $('saveRecordBtn').addEventListener('click', saveAndCloseDayEditSheet);
    $('dayEditClose').addEventListener('click', closeDayEditSheet);
    $('dayEditBackdrop').addEventListener('click', closeDayEditSheet);

    // Delete record
    $('deleteRecordBtn').addEventListener('click', deleteCurrentRecord);

    // Cycle detail — close on background tap
    $('cycleDetailClose').addEventListener('click', closeCycleDetail);
    // Close on background tap (outside the card)
    $('cycleDetail').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeCycleDetail();
    });
    $('actualWageInput').addEventListener('blur', saveActualWage);
    $('actualWageInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('markPaidBtn').addEventListener('click', togglePaid);

    // Settings
    $('hourlyRateInput').addEventListener('blur', saveHourlyRate);
    $('hourlyRateInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('paydayInput').addEventListener('blur', savePayday);
    $('paydayInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });

    // Export / Import
    $('exportBtn').addEventListener('click', exportJSON);
    $('importBtn').addEventListener('click', triggerImport);
    $('importFileInput').addEventListener('change', handleImportFile);
    $('confirmImportBtn').addEventListener('click', confirmImport);
    $('cancelImportBtn').addEventListener('click', cancelImport);

    // Install banner
    $('installCloseBtn').addEventListener('click', dismissInstallBanner);

    // Reminder banner click
    $('reminderBanner').addEventListener('click', handleReminderClick);

    // Swipe to change months (C2: 左右滑切换月份)
    let touchStartX = 0;
    let touchStartY = 0;
    const calendarGrid = document.querySelector('.calendar-grid');
    if (calendarGrid) {
      calendarGrid.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }, { passive: true });

      calendarGrid.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        // Only horizontal swipe (not vertical scroll)
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx > 0) {
            // Swipe right → previous month
            state.viewMonth--;
            if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
          } else {
            // Swipe left → next month
            state.viewMonth++;
            if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
          }
          renderCalendar();
        }
      }, { passive: true });
    }

    // Prevent double-tap zoom
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    }, { passive: false });

    // Prevent gesture zoom
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());
  }

  /* ===== Reminder banner click handler ===== */
  function handleReminderClick() {
    const banner = $('reminderBanner');
    if (banner.classList.contains('payday')) {
      // Jump to wage tab
      switchTab('wage');
    } else if (banner.classList.contains('missing') && state._missingDates) {
      // Jump to calendar and select the first missing date
      switchTab('calendar');
      const firstMissing = state._missingDates[0];
      const [y, m] = firstMissing.split('-').map(Number);
      state.viewYear = y;
      state.viewMonth = m - 1;
      selectDate(firstMissing).then(() => renderCalendar());
    }
  }

  /* ===== Start ===== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

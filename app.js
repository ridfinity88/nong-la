(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG;
  const state = {
    bridgeReady: false,
    bridgeSeq: 0,
    bridgePending: new Map(),
    bridgePort: null,
    line: null,
    employee: null,
    recipients: [],
    pendingSubmission: null,
    lastReceipt: null,
    pendingEmployeeId: '',
    activeTab: 'form'
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindEvents();
    setStaticValues();

    try {
      validateClientConfig();
      await initBridge();
      const authorized = await initLiffAndAuthorize();
      if (!authorized) return;

      if (state.employee) {
        await enterLeaveApp();
      } else {
        showRegistration();
      }
    } catch (error) {
      console.error(error);
      showGateError(error.userMessage || error.message || 'ไม่สามารถเปิดระบบได้');
    }
  }

  function validateClientConfig() {
    if (!CONFIG || !CONFIG.LIFF_ID || CONFIG.LIFF_ID.startsWith('PUT_')) {
      throw userError('ยังไม่ได้ตั้งค่า LIFF_ID ใน config.js');
    }
    if (!CONFIG.GAS_WEB_APP_URL || CONFIG.GAS_WEB_APP_URL.startsWith('PUT_')) {
      throw userError('ยังไม่ได้ตั้งค่า GAS_WEB_APP_URL ใน config.js');
    }
  }

  function bindEvents() {
    $('registrationForm').addEventListener('submit', registerEmployee);
    $('registrationEmployeeId').addEventListener('input', () => clearFieldError('registrationEmployeeId'));
    $('newEmployeeForm').addEventListener('submit', createNewEmployee);
    $('newEmployeeFullName').addEventListener('input', () => clearFieldError('newEmployeeFullName'));
    $('newEmployeeBackBtn').addEventListener('click', backToEmployeeRegistration);
    $('leaveForm').addEventListener('submit', onReviewSubmit);
    $('reason').addEventListener('input', (e) => $('reasonCount').textContent = e.target.value.length);
    $$('input[name="leaveUnit"]').forEach(el => el.addEventListener('change', updateLeaveUnitUi));
    $$('input[name="leaveType"]').forEach(el => el.addEventListener('change', () => clearFieldError('leaveType')));
    $('leaveAmount').addEventListener('input', () => clearFieldError('leaveAmount'));
    $('leaveFrom').addEventListener('change', () => clearFieldError('leaveFrom'));
    $('leaveTo').addEventListener('change', () => clearFieldError('leaveTo'));
    $('reason').addEventListener('input', () => clearFieldError('reason'));
    $('editBtn').addEventListener('click', () => closeModal('reviewModal'));
    $('confirmSubmitBtn').addEventListener('click', confirmSubmit);
    $('closeLiffBtn').addEventListener('click', closeLiff);
    $('retryFlexBtn').addEventListener('click', retryFlex);
    $$('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $$('input[name="dashboardMode"]').forEach(el => el.addEventListener('change', loadDashboard));
    $('dashboardMonth').addEventListener('change', loadDashboard);
  }

function setStaticValues() {
  const now = new Date();

  $('reportDateBadge').textContent =
    `วันที่แจ้งลา ${formatThaiDate(now)}`;

  $('dashboardMonth').value = toYearMonth(now);
}

  function initBridge() {
    return new Promise((resolve, reject) => {
      const iframe = $('gasBridge');
      let iframeLoaded = false;

      const timeout = setTimeout(() => {
        window.removeEventListener('message', onReady);
        const message = iframeLoaded
          ? 'Google Apps Script เปิดได้ แต่ Bridge ยังเชื่อมต่อไม่ได้ กรุณาตรวจว่าได้ Deploy Bridge.html เวอร์ชันล่าสุดแล้ว'
          : 'ไม่สามารถเปิด Google Apps Script Backend ได้ กรุณาตรวจ GAS_WEB_APP_URL และ Deployment';
        reject(userError(message));
      }, CONFIG.REQUEST_TIMEOUT_MS);

      const onReady = (event) => {
        if (!isTrustedBridgeOrigin(event.origin)) return;
        const data = event.data || {};
        if (data.channel !== 'leave-app-bridge' || data.type !== 'ready') return;

        const port = event.ports && event.ports[0];
        if (!port) return;

        clearTimeout(timeout);
        window.removeEventListener('message', onReady);

        state.bridgePort = port;
        state.bridgePort.onmessage = onBridgePortMessage;
        if (state.bridgePort.start) state.bridgePort.start();
        state.bridgeReady = true;
        resolve();
      };

      window.addEventListener('message', onReady);
      iframe.addEventListener('load', () => { iframeLoaded = true; }, { once: true });
      iframe.src = CONFIG.GAS_WEB_APP_URL;
    });
  }

  function isTrustedBridgeOrigin(origin) {
    try {
      const expected = new URL(CONFIG.GAS_WEB_APP_URL).origin;
      return origin === expected || origin.endsWith('.googleusercontent.com');
    } catch (_) {
      return false;
    }
  }

  function onBridgePortMessage(event) {
    const data = event.data || {};
    if (data.channel !== 'leave-app-bridge' || data.type !== 'response') return;
    const pending = state.bridgePending.get(data.id);
    if (!pending) return;
    state.bridgePending.delete(data.id);
    clearTimeout(pending.timeout);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(apiError(data.error));
  }

  function bridgeCall(action, payload = {}) {
    if (!state.bridgeReady || !state.bridgePort) {
      return Promise.reject(userError('Backend ยังไม่พร้อมใช้งาน'));
    }

    const id = `${Date.now()}-${++state.bridgeSeq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.bridgePending.delete(id);
        reject(userError('คำขอใช้เวลานานเกินไป กรุณาลองใหม่'));
      }, CONFIG.REQUEST_TIMEOUT_MS);

      state.bridgePending.set(id, { resolve, reject, timeout });
      state.bridgePort.postMessage({
        channel: 'leave-app-bridge',
        type: 'request',
        id,
        action,
        payload
      });
    });
  }

  async function initLiffAndAuthorize() {
    await liff.init({ liffId: CONFIG.LIFF_ID });

    if (!liff.isLoggedIn()) {
      liff.login();
      return false;
    }

    if (CONFIG.MOBILE_ONLY && !liff.isInClient()) {
      throw userError('ระบบนี้อนุญาตให้เปิดผ่าน LINE บนโทรศัพท์เท่านั้น');
    }

    const os = liff.getOS();
    if (CONFIG.MOBILE_ONLY && !['ios', 'android'].includes(os)) {
      throw userError('รองรับเฉพาะ iPhone และ Android');
    }

    const context = liff.getContext();
    if (CONFIG.REQUIRE_GROUP_CONTEXT && (!context || context.type !== 'group')) {
      throw userError('กรุณาเปิดระบบจากลิงก์ภายในกลุ่ม LINE ที่กำหนด');
    }

    const idToken = liff.getIDToken();
    if (!idToken) throw userError('ไม่พบ LINE ID Token กรุณาปิดแล้วเปิด LIFF ใหม่');

    const auth = await bridgeCall('authorize', { idToken });
    state.line = {
      userId: auth.userId,
      displayName: auth.displayName || '',
      pictureUrl: auth.pictureUrl || '',
      idToken
    };
    state.employee = auth.employee || null;

    $('registrationLineName').textContent = state.line.displayName || 'LINE User';
    $('registrationLineAvatar').src = state.line.pictureUrl || placeholderAvatar(state.line.displayName || 'U');
    return true;
  }

  async function loadRecipients() {
    const result = await bridgeCall('getRecipients', { idToken: state.line.idToken });
    state.recipients = result.recipients || [];
    $('recipientList').innerHTML = state.recipients.map((name, index) => `
      <label class="person-chip">
        <input type="checkbox" name="recipients" value="${escapeHtml(name)}" data-index="${index}">
        <span>${escapeHtml(name)}</span>
      </label>
    `).join('');
    $$('input[name="recipients"]').forEach(el => el.addEventListener('change', () => clearFieldError('recipients')));
  }

  function showRegistration() {
    $('gateScreen').classList.add('hidden');
    $('appScreen').classList.add('hidden');
    $('newEmployeeScreen').classList.add('hidden');
    $('registrationScreen').classList.remove('hidden');
    $('registrationEmployeeId').focus();
  }

  async function registerEmployee(event) {
    event.preventDefault();
    const employeeId = normalizeEmployeeId($('registrationEmployeeId').value);
    clearFieldError('registrationEmployeeId');

    if (!employeeId) {
      setFieldError('registrationEmployeeId', 'กรุณากรอกรหัสพนักงาน');
      return;
    }

    const btn = $('registrationSubmitBtn');
    setButtonLoading(btn, true, 'กำลังตรวจสอบ...');
    try {
      const result = await bridgeCall('registerEmployee', {
        idToken: state.line.idToken,
        employeeId
      });

      if (result && result.needsCreation) {
        state.pendingEmployeeId = result.employeeId || employeeId;
        showNewEmployeeRegistration(state.pendingEmployeeId);
        return;
      }

      state.employee = result.employee;
      showToast(`ลงทะเบียนสำเร็จ สวัสดีคุณ ${state.employee.fullName}`);
      await enterLeaveApp();
    } catch (error) {
      setFieldError('registrationEmployeeId', error.userMessage || 'ไม่สามารถลงทะเบียนรหัสพนักงานได้');
    } finally {
      setButtonLoading(btn, false, 'บันทึกและเข้าใช้งาน');
    }
  }

function backToEmployeeRegistration() {
  clearFieldError('newEmployeeFullName');

  $('newEmployeeScreen').classList.add('hidden');
  $('registrationScreen').classList.remove('hidden');

  $('registrationEmployeeId').focus();
}
  
  function showNewEmployeeRegistration(employeeId) {
    state.pendingEmployeeId = normalizeEmployeeId(employeeId);
    $('gateScreen').classList.add('hidden');
    $('registrationScreen').classList.add('hidden');
    $('appScreen').classList.add('hidden');
    $('newEmployeeScreen').classList.remove('hidden');

    $('newEmployeeId').value = state.pendingEmployeeId;
    $('newEmployeeFullName').value = '';
    clearFieldError('newEmployeeFullName');

    $('newEmployeeLineName').textContent = state.line?.displayName || 'LINE User';
    $('newEmployeeLineAvatar').src = state.line?.pictureUrl || placeholderAvatar(state.line?.displayName || 'U');
    setTimeout(() => $('newEmployeeFullName').focus(), 80);
  }

  async function createNewEmployee(event) {
    event.preventDefault();
    const employeeId = normalizeEmployeeId(state.pendingEmployeeId || $('newEmployeeId').value);
    const fullName = String($('newEmployeeFullName').value || '').trim().replace(/\s+/g, ' ');
    clearFieldError('newEmployeeFullName');

    if (!employeeId) {
      showToast('ไม่พบรหัสพนักงานจากขั้นตอนก่อนหน้า กรุณากลับเข้า LIFF ใหม่', true);
      return;
    }
    if (!fullName) {
      setFieldError('newEmployeeFullName', 'กรุณากรอกชื่อ-นามสกุล');
      return;
    }

    const btn = $('newEmployeeSubmitBtn');
    setButtonLoading(btn, true, 'กำลังบันทึกข้อมูล...');
    try {
      const result = await bridgeCall('createEmployee', {
        idToken: state.line.idToken,
        employeeId,
        fullName
      });
      state.employee = result.employee;
      state.pendingEmployeeId = '';
      showToast(`เพิ่มข้อมูลสำเร็จ สวัสดีคุณ ${state.employee.fullName}`);
      await enterLeaveApp();
    } catch (error) {
      setFieldError('newEmployeeFullName', error.userMessage || 'ไม่สามารถเพิ่มข้อมูลพนักงานได้');
    } finally {
      setButtonLoading(btn, false, 'บันทึกข้อมูลและเข้าใช้งาน');
    }
  }

  async function enterLeaveApp() {
    if (!state.employee) throw userError('ไม่พบข้อมูลพนักงานที่ผูกกับบัญชี LINE');
    applyEmployeeUi();
    await loadRecipients();
    await loadDashboard();
    showApp();
  }

  function applyEmployeeUi() {
  const employee = state.employee;

  $('greetingName').textContent =
    `สวัสดีคุณ ${employee.fullName}`;

  $('greetingMeta').textContent =
    `รหัส ${employee.employeeId} · ${employee.department || CONFIG.DEPARTMENT}`;

  $('employeeAvatar').src =
    employee.imageUrl || placeholderAvatar(employee.fullName);
}

  function updateLeaveUnitUi() {
    const unit = selectedValue('leaveUnit');
    const amount = $('leaveAmount');
    amount.value = '';
    clearFieldError('leaveAmount');

    if (unit === 'HOUR') {
      $('leaveAmountLabel').innerHTML = 'จำนวนชั่วโมง <b>*</b>';
      $('leaveAmountSuffix').textContent = 'ชั่วโมง';
      $('leaveAmountHint').textContent = 'อนุญาตเฉพาะครั้งละ 0.5 ชั่วโมง เช่น 0.5, 1, 1.5, 2';
      amount.min = '0.5';
      amount.step = '0.5';
      amount.placeholder = 'เช่น 0.5, 1, 1.5, 5.5';
    } else {
      $('leaveAmountLabel').innerHTML = 'จำนวนวัน <b>*</b>';
      $('leaveAmountSuffix').textContent = 'วัน';
      $('leaveAmountHint').textContent = 'รุ่นนี้กำหนดจำนวนวันเป็นจำนวนเต็ม เช่น 1, 2, 3 วัน';
      amount.min = '1';
      amount.step = '1';
      amount.placeholder = 'เช่น 1, 2, 3';
    }
  }

  async function onReviewSubmit(event) {
    event.preventDefault();
    const form = collectForm();
    const errors = validateForm(form);
    renderValidationErrors(errors);
    if (Object.keys(errors).length) {
      focusFirstError(errors);
      return;
    }

    if (!state.employee) {
      showToast('ไม่พบข้อมูลพนักงาน กรุณาปิดและเปิด LIFF ใหม่', true);
      return;
    }

    state.pendingSubmission = form;
    renderReview(form);
    openModal('reviewModal');
  }

  function collectForm() {
    return {
      idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      leaveType: selectedValue('leaveType'),
      leaveUnit: selectedValue('leaveUnit'),
      leaveAmount: $('leaveAmount').value.trim(),
      leaveFrom: $('leaveFrom').value,
      leaveTo: $('leaveTo').value,
      reason: $('reason').value.trim(),
      recipients: $$('input[name="recipients"]:checked').map(el => el.value)
    };
  }

  function validateForm(form) {
    const errors = {};
    if (!form.leaveType) errors.leaveType = 'กรุณาเลือกประเภทการลา';

    const amount = Number(form.leaveAmount);
    if (!form.leaveAmount || !Number.isFinite(amount) || amount <= 0) {
      errors.leaveAmount = 'กรุณาระบุจำนวนการลาให้ถูกต้อง';
    } else if (form.leaveUnit === 'HOUR' && !Number.isInteger(amount * 2)) {
      errors.leaveAmount = 'จำนวนชั่วโมงต้องเพิ่มทีละ 0.5 ชั่วโมงเท่านั้น เช่น 0.5, 1, 1.5, 2, 5.5';
    } else if (form.leaveUnit === 'DAY' && !Number.isInteger(amount)) {
      errors.leaveAmount = 'จำนวนวันในรุ่นนี้ต้องเป็นจำนวนเต็ม เช่น 1, 2, 3 วัน';
    }

    if (!form.leaveFrom) errors.leaveFrom = 'กรุณาเลือกวันที่ต้องการลา';
    if (!form.leaveTo) errors.leaveTo = 'กรุณาเลือกวันที่สิ้นสุด';
    if (form.leaveFrom && form.leaveTo && form.leaveTo < form.leaveFrom) {
      errors.leaveTo = 'วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มลา';
    }
    if (!form.reason) errors.reason = 'กรุณาระบุสาเหตุการลา';
    if (form.reason.length > 500) errors.reason = 'สาเหตุต้องไม่เกิน 500 ตัวอักษร';
    if (!form.recipients.length) errors.recipients = 'กรุณาเลือกผู้รับทราบอย่างน้อย 1 คน';
    return errors;
  }

  function renderValidationErrors(errors) {
    ['leaveType','leaveAmount','leaveFrom','leaveTo','reason','recipients'].forEach(clearFieldError);
    Object.entries(errors).forEach(([key, msg]) => setFieldError(key, msg));
  }

  function renderReview(form) {
    const rows = [
      ['พนักงาน', state.employee.fullName],
      ['รหัส', state.employee.employeeId],
      ['ประเภท', leaveTypeLabel(form.leaveType)],
      ['จำนวนลา', `${formatNumber(form.leaveAmount)} ${form.leaveUnit === 'HOUR' ? 'ชั่วโมง' : 'วัน'}`],
      ['วันที่', `${formatIsoThai(form.leaveFrom)} – ${formatIsoThai(form.leaveTo)}`],
      ['สาเหตุ', form.reason],
      ['ผู้รับทราบ', form.recipients.join(', ')]
    ];
    $('reviewContent').innerHTML = rows.map(([label,value]) => `<div class="review-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  async function confirmSubmit() {
    if (!state.pendingSubmission) return;
    const btn = $('confirmSubmitBtn');
    setButtonLoading(btn, true, 'กำลังบันทึก...');
    try {
      const receipt = await bridgeCall('submitLeave', {
        idToken: state.line.idToken,
        request: state.pendingSubmission
      });
      state.lastReceipt = receipt;

      let flexSent = false;
      let flexError = null;
      try {
        await sendFlex(receipt.flexMessage);
        flexSent = true;
        await bridgeCall('markMessageStatus', {
          idToken: state.line.idToken,
          requestId: receipt.requestId,
          status: 'SENT'
        });
      } catch (error) {
        console.error('Flex send failed', error);
        flexError = error;
        try {
          await bridgeCall('markMessageStatus', {
            idToken: state.line.idToken,
            requestId: receipt.requestId,
            status: 'FAILED'
          });
        } catch (_) {}
      }

      renderSuccess(receipt, flexSent, flexError);
swapModal('reviewModal', 'successModal');
await loadDashboard();
    } catch (error) {
      showToast(error.userMessage || 'บันทึกข้อมูลไม่สำเร็จ', true);
    } finally {
      setButtonLoading(btn, false, 'ยืนยันส่ง');
    }
  }

  async function sendFlex(flexMessage) {
    try {
      await liff.sendMessages([flexMessage]);
    } catch (error) {
      console.error('liff.sendMessages failed', error);
      throw userError('LINE ไม่สามารถส่ง Flex Message ได้ กรุณาเปิด LIFF จากกลุ่ม LINE โดยตรง และตรวจว่าเปิด scope chat_message.write แล้ว');
    }
  }

  async function retryFlex() {
    if (!state.lastReceipt) return;
    const btn = $('retryFlexBtn');
    setButtonLoading(btn, true, 'กำลังส่ง...');
    try {
      const fresh = await bridgeCall('getReceipt', {
        idToken: state.line.idToken,
        requestId: state.lastReceipt.requestId
      });
      await sendFlex(fresh.flexMessage);
      await bridgeCall('markMessageStatus', {
        idToken: state.line.idToken,
        requestId: fresh.requestId,
        status: 'SENT'
      });
      state.lastReceipt = fresh;
      renderSuccess(fresh, true, null);
      showToast('ส่ง Flex Message เรียบร้อยแล้ว');
    } catch (error) {
      showToast(error.userMessage || 'ยังส่ง Flex Message ไม่สำเร็จ', true);
    } finally {
      setButtonLoading(btn, false, 'ลองส่ง Flex Message อีกครั้ง');
    }
  }

  function renderSuccess(receipt, flexSent, flexError) {
    $('successMessage').textContent = flexSent
      ? 'บันทึกข้อมูลและส่งใบลาเข้ากลุ่มลาเรียบร้อยแล้ว'
      : 'บันทึกข้อมูลเรียบร้อยแล้ว แต่ส่งใบลาเข้ากลุ่มลายังส่งไม่สำเร็จ กรุณาแจ้งผู้ดูแลระบบ';
    $('successContent').innerHTML = [
      ['Request ID', receipt.requestId],
      ['ประเภท', leaveTypeLabel(receipt.leave.leaveType)],
      ['จำนวนลา', receipt.leave.amountText],
      ['วันที่', receipt.leave.dateText],
      ['อันดับปัจจุบัน', receipt.summary.rank ? `#${receipt.summary.rank}` : '-']
    ].map(([label,value]) => `<div class="review-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
    $('retryFlexBtn').classList.toggle('hidden', flexSent);
    if (flexError) console.warn(flexError);
  }

  async function loadDashboard() {
    if (!state.line) return;
    const mode = selectedValue('dashboardMode') || CONFIG.DEFAULT_DASHBOARD_MODE;
    const month = $('dashboardMonth').value || toYearMonth(new Date());
    try {
      const data = await bridgeCall('getDashboard', {
        idToken: state.line.idToken,
        mode,
        month
      });
      renderDashboard(data);
    } catch (error) {
      console.error(error);
      if (state.activeTab === 'dashboard') showToast(error.userMessage || 'โหลด Dashboard ไม่สำเร็จ', true);
    }
  }

  function renderDashboard(data) {
    $('statRequests').textContent = data.stats.requestCount;
    $('statEmployees').textContent = data.stats.employeeCount;
    $('statMyRank').textContent = data.mySummary?.rank ? `#${data.mySummary.rank}` : '-';
    $('mySummaryPeriod').textContent = `${data.mode === 'DAILY' ? 'เกณฑ์ 8 ชั่วโมง = 1 วัน' : 'เกณฑ์ 9 ชั่วโมง = 1 วัน'} · ${data.month}`;

    const summary = data.mySummary?.byType || {};
    const order = ['SICK','PERSONAL','VACATION','OTHER'];
    $('mySummaryCards').innerHTML = order.map(type => `
      <div class="summary-row"><span>${leaveTypeLabel(type)}</span><strong>${escapeHtml(summary[type]?.display || '0 วัน 0 ชั่วโมง')}</strong></div>
    `).join('') + `<div class="summary-row"><span>รวมทั้งหมด</span><strong>${escapeHtml(data.mySummary?.totalDisplay || '0 วัน 0 ชั่วโมง')}</strong></div>`;

    $('rankingList').innerHTML = (data.ranking || []).length
      ? data.ranking.map(item => `
        <div class="rank-row">
          <div class="rank-number">${item.rank}</div>
          <img class="rank-avatar" src="${escapeAttr(item.imageUrl || placeholderAvatar(item.fullName))}" alt="">
          <div class="rank-person"><strong>${escapeHtml(item.fullName)}</strong><small>${escapeHtml(item.employeeId)}</small></div>
          <div class="rank-total">${escapeHtml(item.rankDisplay)}</div>
        </div>`).join('')
      : '<p class="muted">ยังไม่มีข้อมูลสำหรับช่วงเวลานี้</p>';
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    $$('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));
    $('formTab').classList.toggle('active', tabName === 'form');
    $('dashboardTab').classList.toggle('active', tabName === 'dashboard');
    if (tabName === 'dashboard') loadDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showApp() {
    $('gateScreen').classList.add('hidden');
    $('registrationScreen').classList.add('hidden');
    $('newEmployeeScreen').classList.add('hidden');
    $('appScreen').classList.remove('hidden');
  }

  function showGateError(message) {
    $('gateScreen').innerHTML = `<div class="success-mark" style="background:#fee2e2;color:#b91c1c">!</div><h2>ไม่สามารถเข้าใช้งานได้</h2><p class="muted">${escapeHtml(message)}</p>`;
  }

  function selectedValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  }

  function setFieldError(key, message) {
    const el = $(`${key}Error`);
    if (el) el.textContent = message || '';
  }

  function clearFieldError(key) { setFieldError(key, ''); }

  function focusFirstError(errors) {
    const map = {
      leaveType: 'leaveTypeError', leaveAmount: 'leaveAmount',
      leaveFrom: 'leaveFrom', leaveTo: 'leaveTo', reason: 'reason', recipients: 'recipientList'
    };
    const first = Object.keys(errors)[0];
    const el = $(map[first]);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openModal(id) { $(id).classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeModal(id) { $(id).classList.add('hidden'); document.body.style.overflow = ''; }

  function swapModal(fromId, toId) {
  const fromModal = $(fromId);
  const toModal = $(toId);

  // เปิด POP UP ใหม่ก่อน
  toModal.classList.remove('hidden');

  // แล้วจึงซ่อน POP UP เดิม
  fromModal.classList.add('hidden');

  // ให้พื้นหลังยังคงล็อกอยู่ตลอด
  document.body.style.overflow = 'hidden';
}

  function closeLiff() {
    if (liff.isInClient()) liff.closeWindow();
    else window.close();
  }

  function showToast(message, isError = false) {
    const toast = $('toast');
    toast.textContent = message;
    toast.style.background = isError ? '#991b1b' : '#0f172a';
    toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
  }

  function setButtonLoading(button, loading, text) {
    if (!button) return;
    button.disabled = loading;
    button.dataset.originalText ||= button.textContent;
    button.textContent = loading ? text : (text || button.dataset.originalText);
  }

  function normalizeEmployeeId(value) { return String(value || '').trim().replace(/\s+/g, ''); }
  function toYearMonth(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
  function formatNumber(value) { const n = Number(value); return Number.isInteger(n) ? String(n) : String(n); }

  function formatThaiDate(date) {
    return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }

  function formatIsoThai(iso) {
    if (!iso) return '-';
    const [y,m,d] = iso.split('-').map(Number);
    return formatThaiDate(new Date(y, m - 1, d));
  }

  function leaveTypeLabel(type) {
    return ({ SICK: 'ลาป่วย', PERSONAL: 'ลากิจ', VACATION: 'ลาพักร้อน', OTHER: 'อื่น ๆ' })[type] || type || '-';
  }

  function placeholderAvatar(name) {
    const letter = encodeURIComponent((name || 'U').trim().charAt(0) || 'U');
    return `https://ui-avatars.com/api/?name=${letter}&background=0f766e&color=ffffff&size=128&bold=true`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }
  function escapeAttr(value) { return escapeHtml(value); }
  function userError(message) { const e = new Error(message); e.userMessage = message; return e; }
  function apiError(error) {
    const e = new Error(error?.message || 'Backend error');
    e.code = error?.code || 'BACKEND_ERROR';
    e.userMessage = error?.userMessage || error?.message || 'เกิดข้อผิดพลาดจากระบบหลังบ้าน';
    return e;
  }
})();

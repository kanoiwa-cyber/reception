/* 加納岩総合病院 職員ポータル 画面ロジック
 *  画面: login / home / notices / detail / culture / learn / tools / mypage / lottery / leave（休暇）/ approve（承認、課長・部長）/ staff（?mode=staff、管理者のみ）
 *  - 画面を開くたび・前面に戻るたびにサーバーから最新を取り直す
 *  - ポイント・くじ・歩数はサーバー側で1日1回の判定をしている
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const state = {
    user: null, status: null, rules: null, notices: [], contents: [], pickupId: 0,
    registration: null, subscription: null, view: 'home', prevView: 'home', filter: 'all',
    staffMode: new URLSearchParams(location.search).get('mode') === 'staff',
    staffTab: 'notices', editing: null,
    leave: null, leaveFy: null, approvals: null, leaveFilter: 'all',
  };
  const STATUS_LABEL = { pending: '承認待ち', approved: '承認済み', cancel_pending: '取消申請中', rejected: '差戻し', cancelled: '取消' };
  const fmtBal = (b) => (b && b.granted ? `${b.days % 1 ? b.days.toFixed(1) : b.days}日${b.hours ? ` ${b.hours}時間` : ''}` : '未付与');
  const fmtReqAmount = (r) => (r.unit === 'hour' ? `${r.hours}時間${r.startTime ? `（${r.startTime}〜${r.endTime || ''}）` : ''}` : r.unit === 'day' ? `${r.days}日` : r.unitLabel);
  const fmtReqDate = (r) => (r.endDate !== r.startDate ? `${fmtDate(r.startDate)}〜${fmtDate(r.endDate).slice(5)}` : fmtDate(r.startDate));
  const LAST_SEEN_KEY = 'lastSeenNoticeId';
  const CAT = { important: '重要', general: '一般', department: '部門別' };
  const TAB_LABEL = { learn: '知る・学ぶ', tools: 'お役立ち', culture: '（旧）カルチャー・非表示' }; // culture タブは廃止。管理モードで旧記事を確認・削除できるよう残す
  const KIND_LABEL = { checkin: '出社ポイント', lottery: 'デイリーくじ', steps: '歩数目標達成', initial: '初期ポイント', admin: '管理者付与' };
  const deptLabel = (n) => (n.category === 'department' ? n.department.replace('/', ' ') : CAT[n.category]);

  // ---- 共通 ---------------------------------------------------------------
  async function api(path, options = {}) {
    const res = await fetch(path, { cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.user) { state.user = null; render('login'); }
    if (res.status === 403 && data.mustChangePassword && state.view !== 'forcePassword') { state.view = 'forcePassword'; forcePassword(); }
    if (!res.ok) throw new Error(data.error || `エラーが発生しました (${res.status})`);
    return data;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('ja-JP');
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const lastSeen = () => Number(localStorage.getItem(LAST_SEEN_KEY) || 0);
  const unreadCount = () => state.notices.filter((n) => n.id > lastSeen()).length;
  const isAdmin = () => !!(state.user && state.user.isAdmin);
  // ポータル内リンク（/?view=leave など）。記事・リンクのURLに書くと画面内で遷移する
  const isInternal = (url) => /^\/\?view=/.test(url || '');
  const INTERNAL_VIEWS = ['leave', 'approve', 'health', 'healthReport', 'messages', 'dept', 'schedule', 'schedGroups', 'alerts', 'training', 'surveys'];
  // ポータル側で固定表示するリンク（seed.js に依存しない。管理モードで登録したリンクと合わせて表示される）
  const FIXED_LINKS = [
    { tab: 'tools', section: 'よく使うシステム', title: '休暇届', icon: '休', note: '年休の残数・休暇の申請', url: '/?view=leave' },
    { tab: 'tools', section: 'よく使うシステム', title: 'e-ラーニング', icon: '学', note: '学研メディカルサポート', url: 'https://gakken-meds.jp/login/' },
    { tab: 'tools', section: 'よく使うシステム', title: '給与明細', icon: '給', note: 'Web給与明細（ログインが必要）', url: 'https://es.prosrv-web.jp/portal/view/ptu/ptuLgiShr000.xhtml' },
    { tab: 'tools', section: 'よく使うシステム', title: '病院サイト', icon: '病', note: 'kanoiwa-hospital.or.jp', url: 'https://kanoiwa-hospital.or.jp/' },
    { tab: 'tools', section: 'よく使うシステム', title: '病院Instagram', icon: 'In', note: '@kanoiwa_hospital', url: 'https://www.instagram.com/kanoiwa_hospital/' },
    { tab: 'tools', section: '病院サイトの情報', title: '休診情報', note: '病院サイトを開きます', url: 'https://kanoiwa-hospital.or.jp/?p=2300' },
    { tab: 'tools', section: '病院サイトの情報', title: '外来担当表', note: '病院サイトを開きます', url: 'https://kanoiwa-hospital.or.jp/?p=4610' },
    { tab: 'tools', section: '職員食堂', title: '職員食堂 週間メニュー', note: '営業時間 11:30〜14:30', url: '/docs/shokudo-menu.pdf' },
  ].map((l, i) => ({ id: -(i + 1), kind: 'link', ...l }));
  // 表示しない旧記事（タイトル一致）
  const HIDDEN_TITLES = ['転倒・転落予防 研修スライド', 'BLS（一次救命処置）復習動画', 'ハラスメント防止研修（全職員必須）'];
  const allContents = () => [...FIXED_LINKS, ...state.contents.filter((c) => !HIDDEN_TITLES.includes(c.title) && !FIXED_LINKS.some((f) => f.title === c.title && f.tab === c.tab))];

  function fmtDate(s, withTime) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || '');
    if (!m) return s || '';
    return `${m[1]}.${m[2]}.${m[3]}${withTime && m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 11) return 'おはようございます！';
    if (h < 18) return 'こんにちは！';
    return 'お疲れさまです！';
  }
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  const svgUser = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#093388" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const chev = `<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

  // ---- 画面切替 -----------------------------------------------------------
  function render(view, params = {}) {
    state.view = view;
    const loggedIn = !!state.user;
    $('nav').classList.toggle('hidden', !loggedIn);
    $('tabbar').classList.toggle('hidden', !loggedIn);
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
    const views = { login, home, notices, detail, culture, learn, tools, mypage, lottery, staff, leave: leavePage, approve: approvePage, health: healthPage, healthReport: healthReportPage, alert: alertPage, alerts: alertsPage, dept: deptPage, messages: messagesPage, chat: chatPage, newChat: newChatPage, schedule: schedulePage, schedGroups: schedGroupsPage, training: trainingPage, surveys: surveysPage, survey: surveyPage, surveyNew: surveyNewPage, surveyResults: surveyResultsPage };
    stopChatPolling();
    main.innerHTML = '';
    (views[view] || home)(params);
    updateBadge();
    window.scrollTo(0, 0);
  }
  function updateBadge() {
    const n = state.user ? unreadCount() : 0;
    $('bellBadge').textContent = n > 99 ? '99+' : String(n);
    $('bellBadge').classList.toggle('hidden', n === 0);
    const m = state.user ? Number(state.user.unreadMessages || 0) : 0;
    $('msgBadge').textContent = m > 99 ? '99+' : String(m);
    $('msgBadge').classList.toggle('hidden', m === 0);
  }

  // ---- ログイン -----------------------------------------------------------
  function login() {
    main.innerHTML = `
      <div class="login-bg"><img class="logo" src="/img/logo_full.png" alt="加納岩総合病院"><img class="wanko" src="/img/wanko/face_circle.png" alt="かのいわんこ"></div>
      <section class="login">
        <div class="bubble">おかえりなさい！　職員ポータル（試験運用）</div>
        <div class="field"><label for="staffId">職員番号</label><input id="staffId" inputmode="numeric" autocomplete="username" placeholder="4531"></div>
        <div class="field"><label for="password">パスワード</label><input id="password" type="password" autocomplete="current-password"></div>
        <div class="msg" id="loginMsg"></div>
        <button class="btn" id="loginBtn">ログインする</button>
        <p class="hint">職員番号は職員証に記載の番号です。初めてログインする方の初期パスワードは職員番号と同じです（例：職員番号 4531 → パスワード 4531）。ログイン後に数字4桁のパスワードを設定してください。先頭の0は不要です。ログインできない場合は事務部へ。</p>
      </section>`;
    $('loginBtn').addEventListener('click', doLogin);
    $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  }
  async function doLogin() {
    $('loginMsg').textContent = '';
    $('loginBtn').disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ staffId: $('staffId').value, password: $('password').value }) });
      await boot();
    } catch (e) {
      $('loginMsg').textContent = e.message;
      $('loginBtn').disabled = false;
    }
  }

  // ---- 初回ログイン時のパスワード変更（完了するまで他の画面は使えない）-------------------------
  function forcePassword() {
    $('nav').classList.add('hidden'); $('tabbar').classList.add('hidden');
    main.innerHTML = `
      <div class="login-bg"><img class="logo" src="/img/logo_full.png" alt="加納岩総合病院"><img class="wanko" src="/img/wanko/makasete.png" alt=""></div>
      <section class="login">
        <div class="bubble">はじめまして、${esc(state.user.name)} さん。<br>まずパスワードを設定してください</div>
        <p class="hint" style="margin:0 0 14px">初期パスワード（職員番号と同じ）のままでは利用できません。新しいパスワードは数字4桁です（職員番号と同じ数字、同じ数字の繰り返し、1234 などは使えません）。</p>
        <div class="field"><label for="fpCur">現在のパスワード（初期は職員番号と同じ）</label><input id="fpCur" type="password" inputmode="numeric" autocomplete="current-password"></div>
        <div class="field"><label for="fpNew">新しいパスワード（数字4桁）</label><input id="fpNew" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></div>
        <div class="field"><label for="fpNew2">新しいパスワード（確認）</label><input id="fpNew2" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></div>
        <div class="msg" id="fpMsg"></div>
        <button class="btn" id="fpBtn">パスワードを設定して始める</button>
        <div style="text-align:center;margin-top:14px"><button class="btn quiet" id="fpLogout">ログアウト</button></div>
      </section>`;
    $('fpBtn').addEventListener('click', async () => {
      const msg = $('fpMsg'); msg.className = 'msg';
      if ($('fpNew').value !== $('fpNew2').value) { msg.textContent = '新しいパスワードが一致しません'; return; }
      $('fpBtn').disabled = true;
      try {
        await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('fpCur').value, newPassword: $('fpNew').value }) });
        toast('パスワードを設定しました'); await boot();
      } catch (e) { msg.textContent = e.message; $('fpBtn').disabled = false; }
    });
    $('fpLogout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); state.user = null; render('login'); });
  }

  // ---- ホーム -------------------------------------------------------------
  function home() {
    const u = state.user, st = state.status, r = state.rules;
    const important = state.notices.find((n) => n.category === 'important');
    const pick = state.contents.find((c) => c.id === state.pickupId);
    const pct = Math.min(100, Math.round((st.stepsToday / r.stepsGoal) * 100));
    main.innerHTML = `
      <div id="homeAlerts"></div>
      ${important ? `<button class="alert-bar" data-notice="${important.id}"><span>【重要】${esc(important.title.replace(/^【重要】/, ''))}</span>${chev}</button>` : ''}
      <div class="greet">
        <div class="avatar" role="img" aria-label="かのいわんこ"></div>
        <div class="text"><div class="who">${esc(u.name)} さん</div><div class="hello">${greeting()}<br>今日もよろしくお願いいたします</div></div>
      </div>

      <div class="card has-mascot">
        <img class="mascot" src="/img/wanko/ganbaru.png" alt="">
        <span class="rank">${esc(st.rank)} ランク</span>
        <div class="points"><span class="label">現在の保有ポイント</span><span class="value">${num(st.points)}<small>pt</small></span></div>
        <div class="two">
          <button class="btn ${st.checkedInToday ? 'done' : ''}" id="checkinBtn" ${st.checkedInToday ? 'disabled' : ''}>${st.checkedInToday ? '出社ポイント <small>取得済み</small>' : `出社ポイント <small>+${r.checkin}pt</small>`}</button>
          <button class="btn ${st.lotteryToday ? 'done' : ''}" data-go="lottery">${st.lotteryToday ? `デイリーくじ <small>${esc(st.lotteryToday.label)}</small>` : 'デイリーくじ'}</button>
        </div>
      </div>

      <div class="card steps">
        <div class="head"><span class="chip">今日の歩数</span><span class="num">${num(st.stepsToday)}<small>steps</small></span>${st.stepsRewardedToday ? '<span class="done">目標達成</span>' : ''}<button class="edit" id="stepsEditBtn">歩数を入力</button></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="scale"><span>0</span><span>${num(r.stepsGoal)}</span></div>
        <div class="goal"><b>目標歩数</b>${num(r.stepsGoal)}歩 / 日　達成で +${r.stepsBonus}pt</div>
        <div class="steps-form hidden" id="stepsForm">
          <input id="stepsInput" type="number" inputmode="numeric" min="0" max="100000" placeholder="スマホの歩数計の値を入力" value="${st.stepsToday || ''}">
          <button class="btn" id="stepsSaveBtn">保存</button>
        </div>
      </div>

      ${u.openSurveys ? `<button class="hl-prompt sv-prompt" data-go="surveys"><img src="/img/wanko/arigatou.png" alt=""><div><b>未回答のアンケートが ${u.openSurveys} 件あります</b>ご協力をお願いします</div>${chev}</button>` : ''}
      ${st.checkedInToday && !st.healthToday ? `<button class="hl-prompt" data-go="healthReport"><img src="/img/wanko/makasete.png" alt=""><div><b>本日の体調報告が未入力です</b>体温と症状の有無を入力してください</div>${chev}</button>` : ''}
      ${st.healthToday ? `<div class="card hl-done"><div class="head"><span class="chip hl">体調報告</span><span class="num">${st.healthToday.temperature.toFixed(1)}℃${st.healthToday.symptoms.length ? `　${esc(st.healthToday.symptoms.join('・'))}` : '　症状なし'}${st.healthToday.other ? `　${esc(st.healthToday.other)}` : ''}</span></div><div class="m">${st.healthToday.confirmed ? `確認済み（${esc(st.healthToday.confirmerName)}）` : '報告済み・所属長の確認待ち'}${st.healthToday.confirmed ? '' : '　<button class="link" data-go="healthReport">修正する</button>'}</div></div>` : ''}

      <div class="two" style="margin:10px 14px 0"><button class="btn outline" data-go="schedule">📅 スケジュール</button><button class="btn outline" data-go="messages">💬 メッセージ${u.unreadMessages ? ` <small>${u.unreadMessages}</small>` : ''}</button></div>
      <div id="homePush"></div>

      <div class="sec-head"><h2>病院からのお知らせ</h2><button class="more" data-go="notices">もっと見る</button></div>
      <div class="carousel">
        ${state.notices.slice(0, 8).map((n) => `
          <button class="ncard" data-notice="${n.id}">
            <div class="thumb ${n.category}"><span>${esc(deptLabel(n))}</span></div>
            <div class="t">${esc(n.title)}</div>
            <div class="d">${fmtDate(n.createdAt)}${n.id > lastSeen() ? ' <span class="new">新着</span>' : ''}</div>
          </button>`).join('') || '<div class="empty"><img src="/img/wanko/tanoshii.png" alt="">お知らせはまだありません</div>'}
      </div>

      ${pick ? `
      <div class="sec-head"><h2>ピックアップ</h2><button class="more" data-go="${pick.tab}">もっと見る</button></div>
      <button class="pick" data-content="${pick.id}">
        <div class="ph"><img src="/img/wanko/mirai.png" alt=""></div>
        <div><div class="lab">${esc(pick.section)}</div><div class="t">${esc(pick.title)}</div><div class="d">${fmtDate(pick.date)}</div></div>
      </button>` : ''}`;
    renderHomePush();
    api('/api/alerts/open').then((r) => {
      const box = $('homeAlerts'); if (!box) return;
      box.innerHTML = r.alerts.map((a) => `<button class="em-bar ${a.kind} ${a.myStatus ? 'done' : ''}" data-go="alert" data-alert="${a.id}"><span class="k">${a.isTest ? '【テスト】' : ''}${esc(a.kindLabel)}</span><span class="t">${esc(a.title)}</span><span class="s">${a.myStatus ? (a.kind === 'emergency' ? '確認済み' : '回答済み') : (a.kind === 'emergency' ? '未確認' : '未回答')}</span>${chev}</button>`).join('');
    }).catch(() => {});

    $('checkinBtn').addEventListener('click', async () => {
      $('checkinBtn').disabled = true;
      try {
        const r2 = await api('/api/points/checkin', { method: 'POST' });
        state.status = r2.status;
        toast(`出社ポイント +${r2.granted}pt を獲得しました`);
        render(state.status.healthToday ? 'home' : 'healthReport'); // 出社後はそのまま体調報告へ
      } catch (e) { toast(e.message); $('checkinBtn').disabled = false; }
    });
    $('stepsEditBtn').addEventListener('click', () => { $('stepsForm').classList.toggle('hidden'); $('stepsInput').focus(); });
    $('stepsSaveBtn').addEventListener('click', saveSteps);
    $('stepsInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSteps(); });
  }
  async function saveSteps() {
    try {
      const r2 = await api('/api/steps', { method: 'POST', body: JSON.stringify({ steps: $('stepsInput').value }) });
      state.status = r2.status;
      render('home');
      toast(r2.granted ? `目標達成！ +${r2.granted}pt を獲得しました` : '歩数を保存しました');
    } catch (e) { toast(e.message); }
  }

  async function renderHomePush() {
    const box = $('homePush');
    if (!box || !pushSupported()) return;
    if (isIOS() && !isStandalone()) {
      box.innerHTML = `<div class="push-banner"><img src="/img/wanko/makasete.png" alt=""><div><b>通知を受け取るには</b>ホーム画面に追加してから開いてください</div><button class="btn outline" data-go="mypage">手順を見る</button></div>`;
      return;
    }
    if (Notification.permission === 'denied') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) return;
    box.innerHTML = `<div class="push-banner"><img src="/img/wanko/arigatou.png" alt=""><div><b>お知らせを通知で受け取れます</b>大事なお知らせを見逃さないように</div><button class="btn" id="homeSubBtn">受け取る</button></div>`;
    $('homeSubBtn').addEventListener('click', async () => {
      $('homeSubBtn').disabled = true;
      try { await subscribe(); box.innerHTML = ''; toast('通知を受け取る設定にしました'); }
      catch (e) { toast(e.message); $('homeSubBtn').disabled = false; }
    });
  }

  // ---- デイリーくじ ---------------------------------------------------------
  function lottery() {
    const st = state.status, r = state.rules;
    const odds = r.lottery.map((t) => `${t.label} ${t.points}pt`).join(' ／ ');
    if (st.lotteryToday) {
      main.innerHTML = `
        <button class="back" data-go="home">‹ ホームへ戻る</button>
        <div class="lot win"><img src="/img/wanko/arigatou.png" alt=""><h2>本日の結果</h2>
          <div class="result">${esc(st.lotteryToday.label)}</div>
          <div class="pts"><b>${st.lotteryToday.points}</b> pt 獲得済み</div>
          <p>くじは1日1回です。また明日お試しください。</p>
          <button class="btn" data-go="home">ホームへ戻る</button>
          <div class="odds">${esc(odds)}</div>
        </div>`;
      return;
    }
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="lot" id="lotBox"><img src="/img/wanko/makasete.png" alt=""><h2>デイリーくじ</h2>
        <p>かのいわんこが今日の運勢を占います！<br>結果に応じてポイントがもらえます。</p>
        <button class="btn" id="drawBtn">くじを引く</button>
        <div class="odds">${esc(odds)}</div>
      </div>`;
    $('drawBtn').addEventListener('click', async () => {
      $('drawBtn').disabled = true;
      $('drawBtn').textContent = '…';
      try {
        const r2 = await api('/api/points/lottery', { method: 'POST' });
        state.status = r2.status;
        const box = $('lotBox');
        box.classList.add('win');
        const face = r2.result.points >= 50 ? 'mirai' : r2.result.points >= 25 ? 'tanoshii' : 'arigatou';
        box.innerHTML = `<img src="/img/wanko/${face}.png" alt=""><h2>結果は…</h2>
          <div class="result">${esc(r2.result.label)}</div>
          <div class="pts"><b>${r2.result.points}</b> pt GET！</div>
          <p>保有ポイント ${num(state.status.points)} pt になりました</p>
          <button class="btn" data-go="home">ホームへ戻る</button>`;
      } catch (e) { toast(e.message); render('home'); }
    });
  }

  // ---- お知らせ一覧 / 詳細 ------------------------------------------------
  function notices() {
    const f = state.filter;
    const list = state.notices.filter((n) => f === 'all' || n.category === f);
    main.innerHTML = `
      <div class="page"><h1 class="page-title">お知らせ</h1><p class="page-lead">配信したお知らせを一覧で確認できます。</p></div>
      <div class="filters">
        ${['all', 'important', 'general', 'department'].map((k) => `<button class="${f === k ? 'on' : ''}" data-filter="${k}">${k === 'all' ? 'すべて' : CAT[k]}</button>`).join('')}
      </div>
      <ul class="nlist">
        ${list.map((n) => `
          <li><button class="row" data-notice="${n.id}">
            <div class="meta"><span class="tag ${n.category}">${esc(deptLabel(n))}</span><span>${fmtDate(n.createdAt, true)}</span>${n.id > lastSeen() ? '<span class="new">新着</span>' : ''}</div>
            <div class="t">${esc(n.title)}</div>
          </button></li>`).join('') || '<li class="empty">該当するお知らせはありません</li>'}
      </ul>`;
    if (state.notices.length) localStorage.setItem(LAST_SEEN_KEY, String(Math.max(lastSeen(), ...state.notices.map((n) => n.id))));
  }

  function detail({ notice, content }) {
    if (notice) {
      main.innerHTML = `
        <button class="back" data-go="${state.prevView}">‹ 戻る</button>
        <article class="detail">
          <div class="meta"><span class="tag ${notice.category}">${esc(deptLabel(notice))}</span><span>${fmtDate(notice.createdAt, true)}</span></div>
          <h2>${esc(notice.title)}</h2>
          <div class="body">${esc(notice.body || '（本文はありません）')}</div>
          ${(notice.attachments || []).length ? `<div class="sec-label" style="padding:14px 0 4px">添付ファイル</div><ul class="clist">${notice.attachments.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener"><span class="dp-ico">${/\.pdf$/i.test(a.name) ? 'PDF' : /\.(png|jpe?g)$/i.test(a.name) ? '画像' : /\.xlsx?$/i.test(a.name) ? 'Excel' : /\.docx?$/i.test(a.name) ? 'Word' : 'ファイル'}</span><span class="t" style="flex:1">${esc(a.name)}</span>${chev}</a></li>`).join('')}</ul>` : ''}
          ${notice.author ? `<div class="author">投稿：${esc(notice.author)}</div>` : ''}
        </article>`;
      if (notice.id > lastSeen()) localStorage.setItem(LAST_SEEN_KEY, String(notice.id));
    } else if (content) {
      main.innerHTML = `
        <button class="back" data-go="${state.prevView}">‹ 戻る</button>
        <article class="detail">
          <div class="meta"><span>${esc(content.section)}</span><span>${fmtDate(content.date)}</span>${content.author ? `<span>${esc(content.author)}</span>` : ''}</div>
          <h2>${esc(content.title)}</h2>
          <div class="body">${esc(content.body || '')}</div>
          ${content.url ? `<p><a class="btn outline" href="${esc(content.url)}" target="_blank" rel="noopener">リンクを開く</a></p>` : ''}
        </article>`;
    }
  }

  // ---- カルチャー / 知る・学ぶ / お役立ち -------------------------------------
  const LEAD = { culture: '病院の想いや、一緒に働く仲間のことを知るページです。', learn: '院内マニュアルや研修資料をまとめています。', tools: '日常業務で使うサイトや連絡先をまとめています。' };
  function contentPage(tab) {
    const items = allContents().filter((c) => c.tab === tab);
    const sections = [...new Set(items.map((c) => c.section))];
    main.innerHTML = `
      <div class="page"><h1 class="page-title">${TAB_LABEL[tab]}</h1><p class="page-lead">${LEAD[tab]}</p></div>
      ${tab === 'learn' ? `<div id="learnLinks"></div><button class="pick dp-home" data-go="training" style="margin-bottom:14px"><div class="ph"><img src="/img/wanko/ganbaru.png" alt=""></div><div><div class="lab">研修</div><div class="t">研修資料・受講記録</div><div class="d">医療安全・感染症対策 ほか</div></div>${chev}</button>` : ''}
      ${tab === 'tools' ? `
      <div class="card lv-home" style="margin:0 14px 10px">
        <div class="head"><span class="chip lv">休暇届</span><span class="num" id="lvHomeBal">…</span></div>
        <div class="two"><button class="btn outline" data-go="leave">休暇を申請・確認</button>${state.user.isApprover ? `<button class="btn ${state.user.pendingApprovals ? '' : 'done'}" data-go="approve">承認待ち <small>${state.user.pendingApprovals ? `${state.user.pendingApprovals}件` : 'なし'}</small></button>` : ''}</div>
      </div>` : ''}
      ${tab === 'tools' ? `<button class="pick dp-home" data-go="surveys" style="margin-bottom:14px"><div class="ph"><img src="/img/wanko/arigatou.png" alt=""></div><div><div class="lab">アンケート</div><div class="t">アンケートに回答する${state.user.openSurveys ? `（未回答 ${state.user.openSurveys}件）` : ''}</div><div class="d">${state.user.canCreateSurveys ? '作成・集計もこちら' : '病院・部門からのアンケート'}</div></div>${chev}</button>` : ''}
      ${sections.map((sec) => `
        <section class="sec"><h3>${esc(sec)}</h3>
          <ul class="clist">
            ${items.filter((c) => c.section === sec).map((c) => c.kind === 'link'
              ? `<li><a href="${c.url ? esc(c.url) : '#'}" ${c.url ? (c.url.startsWith('tel:') || isInternal(c.url) ? '' : 'target="_blank" rel="noopener"') : 'data-todo="このリンク先"'}><span><span class="t">${esc(c.title)}</span><br><span class="n">${esc(c.note)}</span></span>${chev}</a></li>`
              : `<li><button data-content="${c.id}"><span><span class="t">${esc(c.title)}</span><br><span class="n">${fmtDate(c.date)}${c.author ? `　${esc(c.author)}` : ''}</span></span>${chev}</button></li>`).join('')}
          </ul>
        </section>`).join('') || '<div class="empty"><img src="/img/wanko/tanoshii.png" alt="">掲載内容はまだありません</div>'}`;
    if (tab === 'learn') api('/api/training/links').then((r) => { const box = $('learnLinks'); if (!box || !r.links.length) return; box.innerHTML = `<section class="sec"><h3>研修・提出のリンク</h3><ul class="clist">${r.links.map((l) => `<li><a href="${esc(l.url)}" ${isInternal(l.url) ? '' : 'target="_blank" rel="noopener"'}><span><span class="t">${esc(l.title)}</span><br><span class="n">${l.deadline ? `<span class="${l.expired ? '' : 'rej'}">期日：${esc(l.deadline)}${l.expired ? '（終了）' : ''}</span>${l.note ? '　' : ''}` : ''}${esc(l.note)}</span></span>${chev}</a></li>`).join('')}</ul></section>`; }).catch(() => {});
    if (tab === 'tools') api('/api/leave/me').then((lv) => { const el = $('lvHomeBal'); if (el) el.innerHTML = lv.balance.granted ? `残り <b>${esc(fmtBal(lv.balance))}</b>` : '<small>年休は未付与です</small>'; }).catch(() => {});
  }
  const culture = () => contentPage('culture');
  const learn = () => contentPage('learn');
  const tools = () => contentPage('tools');

  // ---- 研修ページ -------------------------------------------------------------------
  async function trainingPage() {
    main.innerHTML = `<div class="page"><h1 class="page-title">研修</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api('/api/training'); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    state.trLinks = d.links;
    const cat = '研修';
    const items = d.items; // 分類で分けず1つの一覧に表示
    const required = d.items.filter((t) => t.required && !t.myDoneAt);
    main.innerHTML = `
      <button class="back" data-go="learn">‹ 知る・学ぶへ戻る</button>
      <div class="page"><h1 class="page-title">研修</h1><p class="page-lead">研修資料・動画を確認したら「受講しました」を押してください。受講記録として保存されます。</p></div>
      <div class="sec-label">研修・提出のリンク</div>
      <ul class="clist" style="margin:0 14px 12px">${d.links.filter((l) => l.active).map((l) => `
        <li><a href="${esc(l.url)}" ${isInternal(l.url) ? '' : 'target="_blank" rel="noopener"'} class="${l.expired ? 'tr-expired' : ''}"><span><span class="t">${esc(l.title)}</span><br><span class="n">${l.deadline ? `<span class="${l.expired ? '' : 'rej'}">期日：${esc(l.deadline)}${l.expired ? '（終了）' : ''}</span>${l.note ? '　' : ''}` : ''}${esc(l.note)}</span></span>${chev}</a></li>`).join('') || '<li class="empty">リンクはまだありません</li>'}</ul>
      ${d.canEdit ? `<details class="dp-hist" id="trLinkEditor"><summary>リンクを登録・編集する（権限者のみ）</summary>
        <ul class="alist" style="margin:8px 0">${d.links.map((l) => `<li class="${l.active ? '' : 'unpub'}"><span><span class="t">${esc(l.title)}</span>${l.active ? '' : ' <span class="tag st-cancelled">非表示</span>'}<br><span class="m">${l.deadline ? `期日：${esc(l.deadline)}${l.dueDate ? `（${l.dueDate}）` : ''}　` : ''}${esc(l.url).slice(0, 50)}</span></span><span class="ops"><button data-trledit="${l.id}">編集</button><button data-trltoggle="${l.id}" data-active="${l.active ? 0 : 1}">${l.active ? '非表示' : '表示'}</button><button class="del" data-trldel="${l.id}" data-name="${esc(l.title)}">削除</button></span></li>`).join('')}</ul>
        <div class="form" style="margin:0" id="trLinkForm"><h3 id="trlTitleH">リンクを追加</h3><input type="hidden" id="trlId">
          <label>タイトル</label><input id="trlTitle" maxlength="100" placeholder="例：医療安全研修">
          <label>URL</label><input id="trlUrl" placeholder="https://…">
          <div class="grid2"><div><label>期日の表示（任意）</label><input id="trlDeadline" maxlength="60" placeholder="例：11/27（金）12時まで"></div><div><label>期日の日付（任意・期限切れ判定用）</label><input id="trlDue" type="date"></div></div>
          <div class="grid2"><div><label>補足（任意）</label><input id="trlNote" maxlength="200" placeholder="例：e-ラーニング"></div><div><label>並び順（小さいほど上）</label><input id="trlOrder" type="number" value="0"></div></div>
          <div class="row"><button class="btn" id="trlSave">追加する</button><button class="btn quiet" id="trlCancel">クリア</button></div><div class="msg" id="trlMsg"></div>
        </div></details>` : ''}
      ${required.length ? `<div class="hl-prompt" style="cursor:default"><img src="/img/wanko/ganbaru.png" alt=""><div><b>未受講の必須研修が ${required.length} 件あります</b>${required.map((t) => esc(t.title)).join('、')}</div></div>` : ''}
      ${d.canEdit ? `
      <div class="form"><h3>研修資料を登録する</h3>
        <div class="grid2">
          <div><label>分類（任意のラベル）</label><input id="trCat" list="trCats" value="" maxlength="30" placeholder="例：医療安全"><datalist id="trCats">${d.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
          <div><label>実施日・公開日</label><input id="trDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        </div>
        <label>タイトル</label><input id="trTitle" maxlength="100" placeholder="例：2026年度 医療安全研修（第1回）">
        <label>説明（任意）</label><textarea id="trDesc" style="min-height:70px" placeholder="例：全職員対象。資料を確認後、受講ボタンを押してください"></textarea>
        <div class="grid2">
          <div><label>ファイル（PDF・Excel・Word・画像、10MBまで）</label><input id="trFile" type="file" accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg"></div>
          <div><label>またはURL（動画・e-ラーニングなど）</label><input id="trUrl" placeholder="https://…"></div>
        </div>
        <div class="row"><label class="check"><input type="checkbox" id="trReq">全職員必須の研修にする</label><button class="btn" id="trUpload">登録する</button></div><div class="msg" id="trMsg"></div>
      </div>` : ''}
      <ul class="alist tr-list">${items.map((t) => `
        <li class="${t.myDoneAt ? 'done' : ''}"><span>
          <span class="t">${t.required ? '<span class="tag important">必須</span> ' : ''}${t.category && t.category !== '研修' ? `<span class="tag general">${esc(t.category)}</span> ` : ''}${esc(t.title)}</span><br>
          <span class="m">${t.heldOn ? fmtDate(t.heldOn) + '　' : ''}${t.fileUrl ? `<a href="${t.fileUrl}" target="_blank" rel="noopener">${fileIcon(t.mime)} ${esc(t.origName)}（${fmtSize(t.size)}）</a>` : ''}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">リンクを開く</a>` : ''}${t.description ? `<br>${esc(t.description)}` : ''}<br>
          <span style="opacity:.7">登録 ${esc(t.uploaderName)}　受講 ${t.doneCount}名${t.myDoneAt ? `　<b>受講済み ${fmtDate(t.myDoneAt)}</b>` : ''}</span></span></span>
          <span class="ops">${t.myDoneAt ? `<button data-trdone="${t.id}" data-undo="1">取消</button>` : `<button class="on" data-trdone="${t.id}">受講しました</button>`}${d.canEdit ? `<button data-trstatus="${t.id}">受講状況</button><button class="del" data-trdel="${t.id}" data-name="${esc(t.title)}">削除</button>` : ''}</span></li>`).join('') || '<li class="empty">研修資料はまだありません</li>'}</ul>
      <div id="trStatus"></div>`;
    if (d.canEdit) {
      const fill = (l) => { $('trlId').value = l ? l.id : ''; $('trlTitle').value = l ? l.title : ''; $('trlUrl').value = l ? l.url : ''; $('trlDeadline').value = l ? l.deadline : ''; $('trlDue').value = l ? l.dueDate : ''; $('trlNote').value = l ? l.note : ''; $('trlOrder').value = l ? l.sortOrder : 0; $('trlTitleH').textContent = l ? `「${l.title}」を編集` : 'リンクを追加'; $('trlSave').textContent = l ? '更新する' : '追加する'; };
      state.trlFill = fill;
      $('trlCancel').addEventListener('click', () => fill(null));
      $('trlSave').addEventListener('click', async () => {
        const msg = $('trlMsg'); msg.className = 'msg';
        const id = $('trlId').value;
        const payload = { title: $('trlTitle').value, url: $('trlUrl').value, deadline: $('trlDeadline').value, dueDate: $('trlDue').value, note: $('trlNote').value, sortOrder: $('trlOrder').value };
        try { await api(id ? `/api/training/links/${id}` : '/api/training/links', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); toast(id ? '更新しました' : '追加しました'); render('training'); }
        catch (e) { msg.textContent = e.message; }
      });
    }
    if (d.canEdit) $('trUpload').addEventListener('click', async () => {
      const msg = $('trMsg'); msg.className = 'msg'; $('trUpload').disabled = true;
      const fd = new FormData();
      fd.append('category', $('trCat').value); fd.append('title', $('trTitle').value); fd.append('description', $('trDesc').value); fd.append('heldOn', $('trDate').value); fd.append('url', $('trUrl').value); fd.append('required', $('trReq').checked ? '1' : '0');
      if ($('trFile').files[0]) fd.append('file', $('trFile').files[0]);
      try {
        const res = await fetch('/api/training', { method: 'POST', body: fd }); const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '登録に失敗しました');
        toast('登録しました'); render('training');
      } catch (e) { msg.textContent = e.message; $('trUpload').disabled = false; }
    });
  }

  // ---- アンケート -------------------------------------------------------------------
  async function surveysPage() {
    main.innerHTML = `<div class="page"><h1 class="page-title">アンケート</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api('/api/surveys'); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const row = (s, mine) => `<li><span><span class="tag ${s.open ? 'st-approved' : 'st-cancelled'}">${s.open ? '受付中' : '終了'}</span> <span class="t">${esc(s.title)}</span><br>
      <span class="m">${esc(s.targetLabel)}${s.anonymous ? '・匿名' : ''}${s.deadline ? `　締切 ${fmtDate(s.deadline)}` : ''}　${mine ? `回答 ${s.answerCount}/${s.targetCount}` : (s.myAnsweredAt ? `回答済み ${fmtDate(s.myAnsweredAt)}` : '未回答')}　作成：${esc(s.creatorName)}</span></span>
      <span class="ops">${mine ? `<button data-svres="${s.id}">集計</button>` : `<button class="${s.open && !s.myAnsweredAt ? 'on' : ''}" data-go="survey" data-survey="${s.id}">${s.myAnsweredAt ? (s.open ? '修正' : '確認') : '回答'}</button>`}</span></li>`;
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">アンケート</h1>${d.canCreate ? '<div class="row" style="margin:0 0 8px"><button class="btn" data-go="surveyNew">＋ アンケートを作る</button></div>' : ''}</div>
      <div class="sec-label">回答するアンケート</div>
      <ul class="alist">${d.surveys.map((s) => row(s, false)).join('') || '<li class="empty">アンケートはありません</li>'}</ul>
      ${d.canCreate ? `<div class="sec-label">${state.user.isAdmin ? '作成されたアンケート（全件）' : '自分が作成したアンケート'}</div><ul class="alist">${d.mine.map((s) => row(s, true)).join('') || '<li class="empty">なし</li>'}</ul>` : ''}`;
  }

  async function surveyPage({ id } = {}) {
    const sid = id || state.surveyId; state.surveyId = sid;
    main.innerHTML = `<button class="back" data-go="surveys">‹ アンケート一覧へ</button><div class="empty">読み込み中…</div>`;
    let d;
    try { d = await api(`/api/surveys/${sid}`); } catch (e) { main.innerHTML = `<button class="back" data-go="surveys">‹ アンケート一覧へ</button><div class="empty">${esc(e.message)}</div>`; return; }
    const s = d.survey, my = d.myAnswer ? d.myAnswer.answers : {};
    const locked = !s.open;
    main.innerHTML = `
      <button class="back" data-go="surveys">‹ アンケート一覧へ</button>
      <article class="detail"><div class="meta"><span class="tag ${s.open ? 'st-approved' : 'st-cancelled'}">${s.open ? '受付中' : '終了'}</span><span>${esc(s.targetLabel)}${s.anonymous ? '・匿名' : ''}</span>${s.deadline ? `<span>締切 ${fmtDate(s.deadline)}</span>` : ''}</div>
        <h2>${esc(s.title)}</h2>${s.description ? `<div class="body">${esc(s.description)}</div>` : ''}<div class="author">作成：${esc(s.creatorName)}${s.anonymous ? '　※匿名アンケートのため、誰が回答したかは記録されません' : ''}</div></article>
      <div class="form sv-form">
        ${d.myAnswer ? `<p class="hl-locked">回答済み（${fmtDate(d.myAnswer.answeredAt, true)}）${locked ? '' : '。締切まで修正できます'}</p>` : ''}
        ${s.questions.map((q) => `
          <div class="sv-q"><label>${q.id}. ${esc(q.text)}${q.required ? ' <span class="rej">*</span>' : ''}<span class="m">　${q.type === 'single' ? '1つ選択' : q.type === 'multi' ? '複数選択可' : '自由記述'}</span></label>
            ${q.type === 'text' ? `<textarea data-q="${q.id}" style="min-height:70px" ${locked ? 'disabled' : ''}>${esc(my[q.id] || '')}</textarea>`
            : q.options.map((o) => `<label class="sv-opt"><input type="${q.type === 'single' ? 'radio' : 'checkbox'}" name="q${q.id}" value="${esc(o)}" data-q="${q.id}" ${q.type === 'single' ? (my[q.id] === o ? 'checked' : '') : (Array.isArray(my[q.id]) && my[q.id].includes(o) ? 'checked' : '')} ${locked ? 'disabled' : ''}><span>${esc(o)}</span></label>`).join('')}
          </div>`).join('')}
        ${locked ? '' : `<div class="row"><button class="btn" id="svSend">${d.myAnswer ? '回答を更新する' : '回答を送信する'}</button></div>`}
        <div class="msg" id="svMsg"></div>
      </div>
      ${d.canManage ? `<div class="page"><button class="btn outline" data-svres="${s.id}">集計を見る（作成者用）</button></div>` : ''}`;
    if ($('svSend')) $('svSend').addEventListener('click', async () => {
      const msg = $('svMsg'); msg.className = 'msg';
      const answers = {};
      s.questions.forEach((q) => {
        if (q.type === 'text') answers[q.id] = main.querySelector(`textarea[data-q="${q.id}"]`).value;
        else if (q.type === 'single') { const c = main.querySelector(`input[name="q${q.id}"]:checked`); answers[q.id] = c ? c.value : ''; }
        else answers[q.id] = [...main.querySelectorAll(`input[name="q${q.id}"]:checked`)].map((c) => c.value);
      });
      try { await api(`/api/surveys/${s.id}/answer`, { method: 'POST', body: JSON.stringify({ answers }) }); toast('回答を送信しました。ご協力ありがとうございます'); render('surveys'); }
      catch (e) { msg.textContent = e.message; }
    });
  }

  async function surveyNewPage() {
    if (!state.user.canCreateSurveys) { render('surveys'); return; }
    const d = await api('/api/surveys');
    state.svQuestions = state.svQuestions && state.svQuestions.length ? state.svQuestions : [{ type: 'single', text: '', options: '', required: true }];
    const draw = () => {
      main.innerHTML = `
        <button class="back" data-go="surveys">‹ アンケート一覧へ</button>
        <div class="page"><h1 class="page-title">アンケートを作る</h1></div>
        <div class="form">
          <label>タイトル</label><input id="svTitle" maxlength="100" value="${esc(state.svTitle || '')}" placeholder="例：職員食堂に関するアンケート">
          <label>説明（任意）</label><textarea id="svDesc" style="min-height:60px">${esc(state.svDesc || '')}</textarea>
          <div class="grid2">
            <div><label>宛先</label><select id="svTarget">${d.canTargetAll ? '<option value="all">全職員</option>' : ''}${d.departments.filter((n) => d.canTargetAll || n === d.myDepartment).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></div>
            <div><label>締切（任意）</label><input id="svDeadline" type="date" value="${esc(state.svDeadline || '')}"></div>
          </div>
          <div class="row"><label class="check"><input type="checkbox" id="svAnon" ${state.svAnon ? 'checked' : ''}>匿名にする（誰が回答したか記録しない）</label><label class="check"><input type="checkbox" id="svNotify" checked>対象者に通知する</label></div>
        </div>
        ${state.svQuestions.map((q, i) => `
        <div class="form sv-edit"><h3>設問 ${i + 1}</h3>
          <div class="grid2">
            <div><label>形式</label><select data-qtype="${i}"><option value="single" ${q.type === 'single' ? 'selected' : ''}>単一選択</option><option value="multi" ${q.type === 'multi' ? 'selected' : ''}>複数選択</option><option value="text" ${q.type === 'text' ? 'selected' : ''}>自由記述</option></select></div>
            <div><label>&nbsp;</label><label class="check"><input type="checkbox" data-qreq="${i}" ${q.required ? 'checked' : ''}>必須</label></div>
          </div>
          <label>設問文</label><input data-qtext="${i}" maxlength="300" value="${esc(q.text)}" placeholder="例：食堂を利用する頻度は？">
          <div class="${q.type === 'text' ? 'hidden' : ''}"><label>選択肢（1行に1つ）</label><textarea data-qopts="${i}" style="min-height:80px" placeholder="毎日\n週に数回\nほとんど利用しない">${esc(q.options)}</textarea></div>
          <div class="row"><button class="btn quiet" data-qdel="${i}" ${state.svQuestions.length <= 1 ? 'disabled' : ''}>この設問を削除</button></div>
        </div>`).join('')}
        <div class="page"><div class="row"><button class="btn outline" id="svAddQ">＋ 設問を追加</button><button class="btn" id="svCreate">作成して公開する</button></div><div class="msg" id="svMsg"></div></div>`;
      const sync = () => {
        state.svTitle = $('svTitle').value; state.svDesc = $('svDesc').value; state.svDeadline = $('svDeadline').value; state.svAnon = $('svAnon').checked;
        state.svQuestions = state.svQuestions.map((q, i) => ({ type: main.querySelector(`[data-qtype="${i}"]`).value, text: main.querySelector(`[data-qtext="${i}"]`).value, options: main.querySelector(`[data-qopts="${i}"]`).value, required: main.querySelector(`[data-qreq="${i}"]`).checked }));
      };
      main.querySelectorAll('[data-qtype]').forEach((sel) => sel.addEventListener('change', () => { sync(); draw(); }));
      main.querySelectorAll('[data-qdel]').forEach((b) => b.addEventListener('click', () => { sync(); state.svQuestions.splice(Number(b.dataset.qdel), 1); draw(); }));
      $('svAddQ').addEventListener('click', () => { sync(); state.svQuestions.push({ type: 'single', text: '', options: '', required: true }); draw(); window.scrollTo(0, document.body.scrollHeight); });
      $('svCreate').addEventListener('click', async () => {
        sync(); const msg = $('svMsg'); msg.className = 'msg'; $('svCreate').disabled = true;
        try {
          const r = await api('/api/surveys', { method: 'POST', body: JSON.stringify({ title: state.svTitle, description: state.svDesc, target: $('svTarget').value, deadline: state.svDeadline, anonymous: state.svAnon, notify: $('svNotify').checked, questions: state.svQuestions }) });
          state.svQuestions = null; state.svTitle = ''; state.svDesc = ''; state.svDeadline = ''; state.svAnon = false;
          toast(r.push ? `公開しました（通知 ${r.push.sent} 端末）` : '公開しました'); render('surveyResults', { id: r.survey.id });
        } catch (e) { msg.textContent = e.message; $('svCreate').disabled = false; }
      });
    };
    draw();
  }

  async function surveyResultsPage({ id } = {}) {
    const sid = id || state.surveyId; state.surveyId = sid;
    main.innerHTML = `<button class="back" data-go="surveys">‹ アンケート一覧へ</button><div class="empty">読み込み中…</div>`;
    let r;
    try { r = await api(`/api/surveys/${sid}/results`); } catch (e) { main.innerHTML = `<button class="back" data-go="surveys">‹ アンケート一覧へ</button><div class="empty">${esc(e.message)}</div>`; return; }
    const s = r.survey;
    main.innerHTML = `
      <button class="back" data-go="surveys">‹ アンケート一覧へ</button>
      <div class="page"><h1 class="page-title">${esc(s.title)}</h1><p class="page-lead">${esc(s.targetLabel)}${s.anonymous ? '・匿名' : ''}　回答 ${s.answerCount} / ${s.targetCount} 名${s.deadline ? `　締切 ${fmtDate(s.deadline)}` : ''}　<span class="tag ${s.open ? 'st-approved' : 'st-cancelled'}">${s.open ? '受付中' : '終了'}</span></p>
        <div class="row" style="margin:0 0 10px"><button class="btn outline" data-svstatus="${s.id}" data-to="${s.status === 'open' ? 'closed' : 'open'}">${s.status === 'open' ? '締め切る' : '再開する'}</button><a class="btn quiet" href="/api/surveys/${s.id}/export.csv" download>CSV</a><button class="btn quiet" data-svdel="${s.id}">削除</button></div></div>
      ${r.summary.map((q) => `
        <div class="card sv-res"><div class="t">${q.id}. ${esc(q.text)}</div>
          ${q.type === 'text' ? `<ul class="clist" style="margin-top:8px">${q.texts.map((t) => `<li style="padding:8px 12px;display:block;font-size:13px">${esc(t.text)}${t.who ? `<span class="m">　— ${esc(t.who)}</span>` : ''}</li>`).join('') || '<li class="empty" style="padding:8px">回答なし</li>'}</ul>`
          : Object.entries(q.counts).map(([o, n]) => `<div class="sv-barrow"><span class="l">${esc(o)}</span><div class="bar"><i style="width:${q.total ? Math.round((n / q.total) * 100) : 0}%"></i></div><span class="n">${n}<small>（${q.total ? Math.round((n / q.total) * 100) : 0}%）</small></span></div>`).join('')}
        </div>`).join('')}
      ${!s.anonymous && r.respondents.length ? `<details class="dp-hist"><summary>回答者一覧（${r.respondents.length}名）</summary><ul class="alist">${r.respondents.map((a) => `<li><span><span class="t">${esc(a.name)}</span><span class="m">　${esc(a.department)} ${esc(a.section)}　${fmtDate(a.answeredAt, true)}</span></span></li>`).join('')}</ul></details>` : ''}`;
  }

  // ---- スケジュール -------------------------------------------------------------------
  const sched = { ym: '', day: '', hidden: new Set(), groups: [], events: [], pick: null, editing: null, showForm: false };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayYmd = () => ymd(new Date());
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  const fmtMD = (s) => { const [, m, d] = s.split('-'); const w = WEEK[new Date(`${s}T00:00:00`).getDay()]; return `${Number(m)}/${Number(d)}(${w})`; };

  async function schedulePage({ date } = {}) {
    if (date) { sched.day = date; sched.ym = date.slice(0, 7); }
    if (!sched.ym) sched.ym = todayYmd().slice(0, 7);
    if (!sched.day) sched.day = todayYmd();
    const [y, m] = sched.ym.split('-').map(Number);
    const first = new Date(y, m - 1, 1), last = new Date(y, m, 0);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
    const gridEnd = new Date(last); gridEnd.setDate(last.getDate() + (6 - last.getDay()));
    main.innerHTML = `<div class="page"><h1 class="page-title">スケジュール</h1><p class="page-lead">読み込み中…</p></div>`;
    try {
      const [g, e] = await Promise.all([api('/api/sched/groups'), api(`/api/sched/events?from=${ymd(gridStart)}&to=${ymd(gridEnd)}`)]);
      sched.groups = g.groups; sched.events = e.events; sched.colors = g.colors;
    } catch (err) { main.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    const visible = (ev) => !sched.hidden.has(String(ev.groupId || 0));
    const onDay = (d) => sched.events.filter((ev) => visible(ev) && ev.date <= d && ev.endDate >= d);
    const cells = [];
    for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) cells.push(ymd(d));
    const t = todayYmd();
    const chip = (ev) => `<div class="sc-ev" draggable="true" data-ev="${ev.id}" style="--c:${ev.color}" title="${esc(ev.title)}">${ev.allDay ? '' : `<small>${ev.startTime}</small>`}${esc(ev.title)}</div>`;
    const dayEvents = onDay(sched.day);
    const groupOpts = (sel) => `<option value="" ${!sel ? 'selected' : ''}>自分の予定（非公開）</option>${sched.groups.map((gr) => `<option value="${gr.id}" ${sel === gr.id ? 'selected' : ''}>${esc(gr.name)}</option>`).join('')}`;
    const ed = sched.editing;
    const form = (sched.showForm || ed) ? `
      <div class="form sc-form"><h3>${ed ? '予定を編集' : '予定を追加'}</h3>
        <label>予定の名前</label><input id="scTitle" maxlength="100" value="${esc(ed ? ed.title : '')}" placeholder="例：部内ミーティング">
        <div class="grid2">
          <div><label>カレンダー</label><select id="scGroup">${groupOpts(ed ? ed.groupId : (sched.lastGroup || null))}</select></div>
          <div><label>&nbsp;</label><label class="check"><input type="checkbox" id="scAllDay" ${!ed || ed.allDay ? 'checked' : ''}>終日</label></div>
          <div><label>開始日</label><input id="scDate" type="date" value="${ed ? ed.date : sched.day}"></div>
          <div><label>終了日</label><input id="scEnd" type="date" value="${ed ? ed.endDate : sched.day}"></div>
          <div id="scTimeWrap" class="${!ed || ed.allDay ? 'hidden' : ''}" style="grid-column:1/3"><label>時刻</label><div class="lv-time"><input id="scStart" type="time" value="${ed ? ed.startTime : '09:00'}"><span>〜</span><input id="scEndT" type="time" value="${ed ? ed.endTime : ''}"></div></div>
        </div>
        <label>メモ</label><textarea id="scMemo" style="min-height:70px">${esc(ed ? ed.memo : '')}</textarea>
        ${!ed ? '<label class="check" style="margin-top:8px"><input type="checkbox" id="scNotify">グループのメンバーに通知する</label>' : ''}
        <div class="row"><button class="btn" id="scSave">${ed ? '更新する' : '追加する'}</button><button class="btn quiet" id="scCancel">キャンセル</button></div><div class="msg" id="scMsg"></div>
      </div>` : '';
    main.innerHTML = `
      <div class="page"><h1 class="page-title">スケジュール</h1></div>
      ${sched.pick ? `<div class="sc-pick"><span>${sched.pick.mode === 'copy' ? 'コピー先' : '移動先'}の日をタップしてください：${esc(sched.pick.title)}</span><button class="btn quiet" id="scPickCancel">やめる</button></div>` : ''}
      <div class="sc-head">
        <button class="sc-nav" data-scym="${addMonths(sched.ym, -1)}">‹</button>
        <b>${y}年${m}月</b>
        <button class="sc-nav" data-scym="${addMonths(sched.ym, 1)}">›</button>
        <button class="more" data-scday="${t}">今日</button>
      </div>
      <div class="filters sc-filters">
        <button class="${sched.hidden.has('0') ? '' : 'on'}" data-sctoggle="0" style="--c:#5C6B69">自分の予定</button>
        ${sched.groups.map((gr) => `<button class="${sched.hidden.has(String(gr.id)) ? '' : 'on'}" data-sctoggle="${gr.id}" style="--c:${gr.color}">${esc(gr.name)}</button>`).join('')}
        <button data-go="schedGroups">⚙ グループ</button>
      </div>
      <div class="sc-grid">
        ${WEEK.map((w, i) => `<div class="sc-w ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
        ${cells.map((d) => { const evs = onDay(d); const dow = new Date(`${d}T00:00:00`).getDay(); return `
          <div class="sc-cell ${d.slice(0, 7) !== sched.ym ? 'other' : ''} ${d === t ? 'today' : ''} ${d === sched.day ? 'sel' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" data-scday="${d}">
            <div class="sc-d">${Number(d.slice(8))}</div>
            ${evs.slice(0, 3).map(chip).join('')}${evs.length > 3 ? `<div class="sc-more">+${evs.length - 3}</div>` : ''}
          </div>`; }).join('')}
      </div>
      <p class="lv-note" style="margin:6px 14px 0">PC：予定をドラッグして別の日へ移動、Ctrl（Mac は ⌥）を押しながらドロップでコピー。スマホ：予定の「コピー」「移動」ボタンから日付をタップ。</p>

      <div class="sec-head"><h2>${fmtMD(sched.day)} の予定</h2>${!sched.showForm && !ed ? '<button class="more" id="scAddBtn">＋ 追加</button>' : ''}</div>
      ${form}
      <ul class="alist sc-list">${dayEvents.map((ev) => `
        <li style="--c:${ev.color}"><span class="sc-bar"></span><span><span class="t">${esc(ev.title)}</span><br>
          <span class="m">${ev.allDay ? '終日' : `${ev.startTime}${ev.endTime ? `〜${ev.endTime}` : ''}`}${ev.endDate !== ev.date ? `　${fmtMD(ev.date)}〜${fmtMD(ev.endDate)}` : ''}　${esc(ev.groupName)}${ev.memo ? `<br>${esc(ev.memo)}` : ''}<br><span style="opacity:.7">登録 ${esc(ev.creatorName)}${ev.updaterName && ev.updaterName !== ev.creatorName ? `／更新 ${esc(ev.updaterName)}` : ''}</span></span></span>
          <span class="ops"><button data-scedit="${ev.id}">編集</button><button data-scpick="copy" data-id="${ev.id}">コピー</button><button data-scpick="move" data-id="${ev.id}">移動</button><button class="del" data-scdel="${ev.id}">削除</button></span></li>`).join('') || '<li class="empty">予定はありません</li>'}</ul>`;

    if ($('scAddBtn')) $('scAddBtn').addEventListener('click', () => { sched.showForm = true; render('schedule'); });
    if ($('scPickCancel')) $('scPickCancel').addEventListener('click', () => { sched.pick = null; render('schedule'); });
    if ($('scSave')) {
      $('scAllDay').addEventListener('change', () => $('scTimeWrap').classList.toggle('hidden', $('scAllDay').checked));
      $('scDate').addEventListener('change', () => { if ($('scEnd').value < $('scDate').value) $('scEnd').value = $('scDate').value; });
      $('scCancel').addEventListener('click', () => { sched.showForm = false; sched.editing = null; render('schedule'); });
      $('scSave').addEventListener('click', async () => {
        const msg = $('scMsg'); msg.className = 'msg'; $('scSave').disabled = true;
        const payload = { title: $('scTitle').value, groupId: $('scGroup').value ? Number($('scGroup').value) : null, date: $('scDate').value, endDate: $('scEnd').value, allDay: $('scAllDay').checked, startTime: $('scStart').value, endTime: $('scEndT').value, memo: $('scMemo').value, notify: $('scNotify') ? $('scNotify').checked : false };
        try {
          await api(ed ? `/api/sched/events/${ed.id}` : '/api/sched/events', { method: ed ? 'PUT' : 'POST', body: JSON.stringify(payload) });
          sched.lastGroup = payload.groupId; sched.showForm = false; sched.editing = null; sched.day = payload.date; sched.ym = payload.date.slice(0, 7);
          toast(ed ? '更新しました' : '追加しました'); render('schedule');
        } catch (e) { msg.textContent = e.message; $('scSave').disabled = false; }
      });
      $('scTitle').focus();
    }
    // ドラッグ＆ドロップ（PC）
    document.querySelectorAll('.sc-ev').forEach((el) => {
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', el.dataset.ev); e.dataTransfer.effectAllowed = 'copyMove'; el.classList.add('dragging'); e.stopPropagation(); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    document.querySelectorAll('.sc-cell').forEach((cell) => {
      cell.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = (e.ctrlKey || e.altKey) ? 'copy' : 'move'; cell.classList.add('over'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('over'));
      cell.addEventListener('drop', async (e) => {
        e.preventDefault(); cell.classList.remove('over');
        const id = Number(e.dataTransfer.getData('text/plain')); if (!id) return;
        await moveOrCopy(id, cell.dataset.scday, (e.ctrlKey || e.altKey) ? 'copy' : 'move');
      });
    });
  }
  async function moveOrCopy(id, date, mode) {
    try {
      if (mode === 'copy') await api(`/api/sched/events/${id}/copy`, { method: 'POST', body: JSON.stringify({ date }) });
      else await api(`/api/sched/events/${id}`, { method: 'PUT', body: JSON.stringify({ date }) });
      toast(mode === 'copy' ? `${fmtMD(date)} にコピーしました` : `${fmtMD(date)} に移動しました`);
      sched.pick = null; sched.day = date; sched.ym = date.slice(0, 7); render('schedule');
    } catch (e) { toast(e.message); }
  }

  async function schedGroupsPage() {
    main.innerHTML = `<button class="back" data-go="schedule">‹ スケジュールへ戻る</button><div class="empty">読み込み中…</div>`;
    let g, dir;
    try { [g, dir] = await Promise.all([api('/api/sched/groups'), api('/api/msg/directory')]); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const ed = sched.groupEditing ? await api(`/api/sched/groups/${sched.groupEditing}`).then((r) => r.group).catch(() => null) : null;
    const have = new Set(ed ? ed.members.map((u) => u.id) : []);
    const depts = [...new Set(dir.users.map((u) => u.department))];
    main.innerHTML = `
      <button class="back" data-go="schedule">‹ スケジュールへ戻る</button>
      <div class="page"><h1 class="page-title">スケジュールのグループ</h1><p class="page-lead">グループを作ると、メンバー全員が同じカレンダーに予定を登録・変更できます。</p></div>
      <ul class="alist">${g.groups.map((gr) => `<li style="--c:${gr.color}"><span class="sc-bar"></span><span><span class="t">${esc(gr.name)}</span><br><span class="m">${gr.memberCount}名　作成：${esc(gr.creatorName)}</span></span>
        <span class="ops"><button data-sgedit="${gr.id}">${gr.isOwner ? '編集' : 'メンバー'}</button>${gr.isOwner ? `<button class="del" data-sgdel="${gr.id}" data-name="${esc(gr.name)}">削除</button>` : `<button class="del" data-sgleave="${gr.id}">退出</button>`}</span></li>`).join('') || '<li class="empty">まだグループはありません</li>'}</ul>
      <div class="form"><h3>${ed ? `「${esc(ed.name)}」を編集` : '新しいグループを作る'}</h3>
        <div class="grid2">
          <div><label>グループ名</label><input id="sgName" maxlength="50" value="${esc(ed ? ed.name : '')}" placeholder="例：事務部 行事" ${ed && !ed.isOwner ? 'disabled' : ''}></div>
          <div><label>色</label><div class="sc-colors" id="sgColors">${g.colors.map((c) => `<label><input type="radio" name="sgColor" value="${c}" ${(ed ? ed.color : g.colors[0]) === c ? 'checked' : ''} ${ed && !ed.isOwner ? 'disabled' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
        </div>
        <label>メンバー（${ed && !ed.isOwner ? '追加のみ可能' : 'チェックした人が参加'}）</label>
        <input id="sgSearch" placeholder="名前・部門で絞り込み" style="margin-bottom:8px">
        <div id="sgList" class="sg-list">${depts.map((dep) => `<div class="sec-label" style="padding-left:0">${esc(dep)}</div>${dir.users.filter((u) => u.department === dep).map((u) => `<label class="dir-row" data-search="${esc(u.name + ' ' + u.kana + ' ' + u.department + ' ' + u.section)}"><input type="checkbox" class="sgMember" value="${u.id}" ${have.has(u.id) ? 'checked' : ''} ${ed && !ed.isOwner && have.has(u.id) ? 'disabled' : ''}><span><span class="t">${esc(u.name)}</span><span class="m">　${esc(u.section)}</span></span></label>`).join('')}`).join('')}</div>
        <div class="row"><button class="btn" id="sgSave">${ed ? '保存する' : '作成する'}</button>${ed ? '<button class="btn quiet" id="sgCancel">キャンセル</button>' : ''}</div><div class="msg" id="sgMsg"></div>
      </div>`;
    $('sgSearch').addEventListener('input', () => { const q = $('sgSearch').value.trim(); document.querySelectorAll('#sgList .dir-row').forEach((li) => li.classList.toggle('hidden', !!q && !li.dataset.search.includes(q))); });
    if ($('sgCancel')) $('sgCancel').addEventListener('click', () => { sched.groupEditing = null; render('schedGroups'); });
    $('sgSave').addEventListener('click', async () => {
      const msg = $('sgMsg'); msg.className = 'msg';
      const ids = [...document.querySelectorAll('.sgMember:checked')].map((cb) => Number(cb.value));
      const color = (document.querySelector('input[name=sgColor]:checked') || {}).value;
      try {
        if (ed) {
          const addIds = ids.filter((id) => !have.has(id)), removeIds = [...have].filter((id) => !ids.includes(id));
          await api(`/api/sched/groups/${ed.id}`, { method: 'PUT', body: JSON.stringify(ed.isOwner ? { name: $('sgName').value, color, addIds, removeIds } : { addIds }) });
          toast('保存しました');
        } else {
          await api('/api/sched/groups', { method: 'POST', body: JSON.stringify({ name: $('sgName').value, color, memberIds: ids }) });
          toast('グループを作成しました');
        }
        sched.groupEditing = null; render('schedGroups');
      } catch (e) { msg.textContent = e.message; }
    });
  }

  // ---- メッセージ ------------------------------------------------------------------
  let chatTimer = null;
  function stopChatPolling() { if (chatTimer) { clearInterval(chatTimer); chatTimer = null; } }
  const fmtWhen = (s) => { const t = fmtDate(s, true); const today = new Date(); const d = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`; return t.startsWith(d) ? t.slice(11) : t.slice(5); };

  async function messagesPage() {
    main.innerHTML = `<div class="page"><h1 class="page-title">メッセージ</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api('/api/msg/conversations'); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    state.user.unreadMessages = d.conversations.reduce((s, c) => s + c.unread, 0); updateBadge();
    const icon = { direct: '👤', department: '🏥', section: '📋', group: '👥' };
    main.innerHTML = `
      <div class="page"><h1 class="page-title">メッセージ</h1><p class="page-lead">部署・課の連絡、個人へのメッセージ、任意のグループでやり取りできます。</p></div>
      <div class="two" style="margin:0 14px 12px"><button class="btn" data-go="newChat" data-mode="direct">個人にメッセージ</button><button class="btn outline" data-go="newChat" data-mode="group">グループを作る</button></div>
      <ul class="nlist">${d.conversations.map((c) => `
        <li><button class="row ms-row ${c.unread ? 'unread' : ''}" data-chat="${c.id}">
          <span class="ms-ico">${icon[c.type] || '💬'}</span>
          <span class="ms-main"><span class="ms-head"><span class="t">${esc(c.name)}</span><span class="ms-time">${c.lastMessage ? fmtWhen(c.lastMessage.createdAt) : ''}</span></span>
            <span class="ms-sub">${c.lastMessage ? `${c.lastMessage.mine ? '自分' : esc(c.lastMessage.userName)}：${esc(c.lastMessage.body.replace(/\n/g, ' ').slice(0, 40))}` : `<span class="m">${esc(c.typeLabel)}　${c.memberCount}名</span>`}</span></span>
          ${c.unread ? `<span class="ms-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </button></li>`).join('') || '<li class="empty">まだ会話はありません</li>'}</ul>`;
  }

  async function newChatPage({ mode } = {}) {
    const m = mode || state.newChatMode || 'direct';
    state.newChatMode = m;
    main.innerHTML = `<button class="back" data-go="messages">‹ メッセージへ戻る</button><div class="empty">読み込み中…</div>`;
    let d;
    try { d = await api('/api/msg/directory'); } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const depts = [...new Set(d.users.map((u) => u.department))];
    main.innerHTML = `
      <button class="back" data-go="messages">‹ メッセージへ戻る</button>
      <div class="page"><h1 class="page-title">${m === 'group' ? 'グループを作る' : '相手を選ぶ'}</h1>
        ${m === 'group' ? `<div class="field"><label for="gName">グループ名</label><input id="gName" maxlength="50" placeholder="例：忘年会 幹事"></div>` : ''}
        <div class="field"><input id="dirSearch" placeholder="名前・部門で絞り込み"></div>
      </div>
      <div id="dirList">${depts.map((dep) => `<div class="sec-label">${esc(dep)}</div><ul class="nlist dir-list">${d.users.filter((u) => u.department === dep).map((u) => m === 'group'
        ? `<li data-search="${esc(u.name + ' ' + u.kana + ' ' + u.department + ' ' + u.section)}"><label class="row dir-row"><input type="checkbox" class="gMember" value="${u.id}"><span><span class="t">${esc(u.name)}</span><br><span class="m">${esc(u.section)}　${esc(u.job)}</span></span></label></li>`
        : `<li data-search="${esc(u.name + ' ' + u.kana + ' ' + u.department + ' ' + u.section)}"><button class="row dir-row" data-direct="${u.id}"><span><span class="t">${esc(u.name)}</span><br><span class="m">${esc(u.section)}　${esc(u.job)}</span></span>${chev}</button></li>`).join('')}</ul>`).join('')}</div>
      ${m === 'group' ? `<div class="page" style="margin-top:12px"><button class="btn" id="gCreate" style="width:100%">グループを作成する（<span id="gCount">0</span>名）</button><div class="msg" id="gMsg"></div></div>` : ''}`;
    $('dirSearch').addEventListener('input', () => {
      const q = $('dirSearch').value.trim();
      document.querySelectorAll('#dirList li').forEach((li) => li.classList.toggle('hidden', !!q && !li.dataset.search.includes(q)));
    });
    if (m === 'group') {
      document.querySelectorAll('.gMember').forEach((cb) => cb.addEventListener('change', () => { $('gCount').textContent = document.querySelectorAll('.gMember:checked').length; }));
      $('gCreate').addEventListener('click', async () => {
        const msg = $('gMsg'); msg.className = 'msg';
        const ids = [...document.querySelectorAll('.gMember:checked')].map((cb) => Number(cb.value));
        try { const r = await api('/api/msg/conversations', { method: 'POST', body: JSON.stringify({ type: 'group', name: $('gName').value, memberIds: ids }) }); render('chat', { id: r.conversation.id }); }
        catch (e) { msg.textContent = e.message; }
      });
    }
  }

  async function chatPage({ id } = {}) {
    const convId = id || state.chatId;
    state.chatId = convId;
    main.innerHTML = `<button class="back" data-go="messages">‹ メッセージへ戻る</button><div class="empty">読み込み中…</div>`;
    let d;
    try { d = await api(`/api/msg/conversations/${convId}`); } catch (e) { main.innerHTML = `<button class="back" data-go="messages">‹ メッセージへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const c = d.conversation;
    let lastId = d.messages.length ? d.messages[d.messages.length - 1].id : 0;
    const bubble = (m) => `<div class="ch-msg ${m.mine ? 'mine' : ''}" data-mid="${m.id}">${m.mine ? '' : `<div class="ch-name">${esc(m.userName)}</div>`}<div class="ch-bubble">${esc(m.body)}</div><div class="ch-time">${fmtWhen(m.createdAt)}</div></div>`;
    main.innerHTML = `
      <div class="ch-head"><button class="back" data-go="messages" style="padding:0">‹</button><div class="ch-title"><b>${esc(c.name)}</b><span class="m">${esc(c.typeLabel)}　${c.memberCount}名</span></div><button class="icon-btn" id="chInfoBtn" aria-label="メンバー">${svgUser(20)}</button></div>
      <div class="ch-info hidden" id="chInfo">
        <div class="sec-label">メンバー（${c.members.length}名）</div>
        <ul class="alist">${c.members.map((u) => `<li><span><span class="t">${esc(u.name)}</span><span class="m">　${esc(u.department)} ${esc(u.section)}</span></span>${c.canEdit && u.id !== c.createdBy ? `<span class="ops"><button class="del" data-gremove="${u.id}">外す</button></span>` : ''}</li>`).join('')}</ul>
        ${c.type === 'group' ? `<div class="row" style="padding:8px 14px;display:flex;gap:8px;flex-wrap:wrap">${c.canEdit ? `<button class="btn outline" id="gAddBtn">メンバーを追加</button><button class="btn outline" id="gRenameBtn">名前を変更</button>` : ''}<button class="btn quiet" data-gleave="${c.id}">このグループから退出</button></div>` : ''}
      </div>
      <div class="ch-log" id="chLog">${d.messages.length >= 60 ? `<button class="btn quiet" id="chMore" style="width:100%">前のメッセージを読む</button>` : ''}${d.messages.map(bubble).join('') || '<div class="empty">最初のメッセージを送ってみましょう</div>'}</div>
      <div class="ch-input"><textarea id="chText" rows="1" placeholder="メッセージを入力"></textarea><button class="btn" id="chSend">送信</button></div>`;
    const log = $('chLog');
    const scrollBottom = () => { window.scrollTo(0, document.body.scrollHeight); };
    scrollBottom();
    $('chInfoBtn').addEventListener('click', () => $('chInfo').classList.toggle('hidden'));
    const ta = $('chText');
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(120, ta.scrollHeight)}px`; });
    const send = async () => {
      const body = ta.value.trim(); if (!body) return;
      $('chSend').disabled = true;
      try {
        const r = await api(`/api/msg/conversations/${c.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
        ta.value = ''; ta.style.height = 'auto';
        log.querySelector('.empty')?.remove();
        log.insertAdjacentHTML('beforeend', bubble(r.message)); lastId = r.message.id; scrollBottom();
      } catch (e) { toast(e.message); } finally { $('chSend').disabled = false; ta.focus(); }
    };
    $('chSend').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    if ($('chMore')) $('chMore').addEventListener('click', async () => {
      const first = log.querySelector('.ch-msg'); if (!first) return;
      const r = await api(`/api/msg/conversations/${c.id}?before=${first.dataset.mid}`);
      $('chMore').insertAdjacentHTML('afterend', r.messages.map(bubble).join(''));
      if (r.messages.length < 60) $('chMore').remove();
    });
    if ($('gAddBtn')) $('gAddBtn').addEventListener('click', async () => {
      const dir = await api('/api/msg/directory');
      const have = new Set(c.members.map((u) => u.id));
      const cands = dir.users.filter((u) => !have.has(u.id));
      const pick = prompt(`追加する人の名前を入力してください（候補：${cands.slice(0, 30).map((u) => u.name).join('、')}${cands.length > 30 ? '…' : ''}）`);
      if (!pick) return;
      const hit = cands.filter((u) => u.name.includes(pick.trim()));
      if (hit.length !== 1) { toast(hit.length ? '候補が複数あります。フルネームで入力してください' : '該当する職員がいません'); return; }
      await api(`/api/msg/conversations/${c.id}`, { method: 'PUT', body: JSON.stringify({ addIds: [hit[0].id] }) }); toast(`${hit[0].name} を追加しました`); render('chat', { id: c.id });
    });
    if ($('gRenameBtn')) $('gRenameBtn').addEventListener('click', async () => {
      const n = prompt('新しいグループ名', c.name); if (!n || !n.trim()) return;
      await api(`/api/msg/conversations/${c.id}`, { method: 'PUT', body: JSON.stringify({ name: n }) }); render('chat', { id: c.id });
    });
    // 8秒ごとに新着を取りに行く（画面を開いている間だけ）
    chatTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || state.view !== 'chat') return;
      try {
        const r = await api(`/api/msg/conversations/${c.id}?after=${lastId}`);
        if (r.messages.length) { log.querySelector('.empty')?.remove(); log.insertAdjacentHTML('beforeend', r.messages.map(bubble).join('')); lastId = r.messages[r.messages.length - 1].id; scrollBottom(); }
      } catch (_) { /* 圏外 */ }
    }, 8000);
  }

  // ---- 部署ページ（朝礼・シフト表・担当表・資料）-------------------------------------------------
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fileIcon = (m) => (m === 'application/pdf' ? 'PDF' : /spreadsheet|excel/.test(m) ? 'Excel' : /word/.test(m) ? 'Word' : /image/.test(m) ? '画像' : 'ファイル');
  // 部署一覧（ボタンのグリッド）。自分の所属は先頭に表示
  async function deptPickPage() {
    let pages;
    try { pages = (await api('/api/departments')).departments; } catch (e) { main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const mine = state.user.department;
    const list = [...pages].sort((a, b) => (a.name === mine ? -1 : b.name === mine ? 1 : 0));
    main.innerHTML = `
      <div class="page"><h1 class="page-title">部署ごと</h1><p class="page-lead">部署を選ぶと、朝礼・シフト表・掃除/日誌担当表のページが開きます。</p></div>
      <div class="dp-grid">${list.map((p) => `<button class="dp-tile ${p.name === mine ? 'mine' : ''}" data-dpsel="${esc(p.name)}"><span class="t">${esc(p.name)}</span>${p.name === mine ? '<span class="m">自分の部署</span>' : p.sections.length ? `<span class="m">${p.sections.length}病棟・課</span>` : ''}</button>`).join('')}</div>`;
  }
  async function deptPage() {
    if (!state.deptName) { await deptPickPage(); return; }
    const dname = state.deptName;
    main.innerHTML = `<button class="back" data-dpback="1">‹ 部署一覧へ</button><div class="empty">読み込み中…</div>`;
    let d;
    try { d = await api(`/api/dept?department=${encodeURIComponent(dname)}`); state.deptName = d.department; }
    catch (e) { state.deptName = null; await deptPickPage(); toast(e.message); return; }
    const subs = d.pages.filter((p) => p.department === d.baseDepartment && p.section);
    const ym = d.today.slice(0, 7);
    const nextYm = (() => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
    const byCat = (c) => d.files.filter((f) => f.category === c);
    const fileRow = (f) => `<li><a href="${f.url}" target="_blank" rel="noopener" class="dp-file"><span class="dp-ico">${fileIcon(f.mime)}</span><span><span class="t">${esc(f.title)}</span><br><span class="m">${f.month ? `${f.month.replace('-', '年')}月分　` : ''}${esc(f.origName)}　${fmtSize(f.size)}　${fmtDate(f.createdAt)} ${esc(f.uploaderName)}</span></span></a>${d.canEdit ? `<span class="ops"><a href="${f.url}?dl=1" download>保存</a><button class="del" data-dpdel="${f.id}" data-name="${esc(f.title)}">削除</button></span>` : ''}</li>`;
    const monthFiles = (c) => {
      const list = byCat(c);
      const months = [...new Set(list.map((f) => f.month))];
      return months.map((m) => `<div class="sec-label">${m ? `${m.replace('-', '年')}月分` : '月指定なし'}${m === nextYm ? '　<span class="tag general">来月</span>' : m === ym ? '　<span class="tag department">今月</span>' : ''}</div><ul class="alist dp-list">${list.filter((f) => f.month === m).map(fileRow).join('')}</ul>`).join('') || '<ul class="alist"><li class="empty">まだ登録されていません</li></ul>';
    };
    main.innerHTML = `
      <button class="back" data-dpback="1">‹ 部署一覧へ</button>
      <div class="page">
        <h1 class="page-title">${esc(d.label)}のページ</h1>
        ${subs.length ? `<div class="dp-subgrid"><button class="${!d.section ? 'on' : ''}" data-dpsel="${esc(d.baseDepartment)}">${esc(d.baseDepartment)}全体</button>${subs.map((p) => `<button class="${p.section === d.section ? 'on' : ''}" data-dpsel="${esc(p.key)}">${esc(p.section)}</button>`).join('')}</div>` : ''}
      </div>

      <div class="card dp-note">
        <div class="head"><span class="chip lv">本日の朝礼</span><span class="m">${fmtDate(d.today)}${d.note ? `　最終更新 ${fmtDate(d.note.updatedAt, true)} ${esc(d.note.editorName)}` : ''}</span></div>
        <div id="dpNoteView" class="${d.note && d.note.body ? '' : 'empty'}" style="white-space:pre-wrap;font-size:14px;margin-top:8px">${d.note && d.note.body ? esc(d.note.body) : 'まだ入力されていません'}</div>
        ${d.canEditNote ? `<div id="dpNoteEdit" class="hidden"><textarea id="dpNoteBody" placeholder="例：\n・本日の来客：14時 ○○社\n・連絡事項：…\n・担当：受付 A、電話 B">${esc(d.note ? d.note.body : '')}</textarea>
          <div class="row"><button class="btn" id="dpNoteSave">保存する</button><button class="btn quiet" id="dpNoteCancel">キャンセル</button></div><div class="msg" id="dpNoteMsg"></div></div>
        <div class="row" id="dpNoteBtns"><button class="btn outline" id="dpNoteEditBtn">${d.note && d.note.body ? '編集する' : '入力する'}</button></div>` : ''}
      </div>
      ${d.recentNotes.length ? `<details class="dp-hist"><summary>過去の朝礼（${d.recentNotes.length}件）</summary><ul class="alist">${d.recentNotes.map((n) => `<li><span><span class="t">${fmtDate(n.day)}</span><br><span class="m" style="white-space:pre-wrap">${esc(n.body)}</span></span></li>`).join('')}</ul></details>` : ''}

      ${d.canEdit ? `
      <div class="form"><h3>ファイルを登録する</h3>
        <div class="grid2">
          <div><label>種類</label><select id="dpCat">${Object.entries(d.categories).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
          <div id="dpMonthWrap"><label>対象月</label><input id="dpMonth" type="month" value="${nextYm}"></div>
        </div>
        <label>表示名（空欄ならファイル名）</label><input id="dpTitle" maxlength="100" placeholder="例：11月シフト表">
        <label>ファイル（PDF・Excel・Word・画像、10MBまで）</label><input id="dpFile" type="file" accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg">
        <div class="row"><button class="btn" id="dpUpload">アップロード</button></div><div class="msg" id="dpMsg"></div>
      </div>` : ''}

      <div class="sec-head"><h2>シフト表</h2></div>${monthFiles('shift')}
      <div class="sec-head"><h2>掃除・日誌担当表</h2></div>${monthFiles('duty')}
      <div class="sec-head"><h2>その他の資料</h2></div><ul class="alist dp-list">${byCat('other').map(fileRow).join('') || '<li class="empty">なし</li>'}</ul>

      <details class="dp-hist"><summary>${esc(d.label)}のメンバー（${d.members.length}名）</summary><ul class="alist">${d.members.map((m) => `<li><span><span class="t">${esc(m.name)}</span><span class="m">　${esc(m.section)}　${esc(m.job)}${m.role ? `　${{ shunin: '主任', kacho: '課長', bucho: '部長' }[m.role] || ''}` : ''}</span></span></li>`).join('')}</ul></details>`;

    if (d.canEditNote) {
      $('dpNoteEditBtn').addEventListener('click', () => { $('dpNoteView').classList.add('hidden'); $('dpNoteBtns').classList.add('hidden'); $('dpNoteEdit').classList.remove('hidden'); $('dpNoteBody').focus(); });
      $('dpNoteCancel').addEventListener('click', () => render('dept'));
      $('dpNoteSave').addEventListener('click', async () => {
        const msg = $('dpNoteMsg'); msg.className = 'msg';
        try { await api('/api/dept/note', { method: 'PUT', body: JSON.stringify({ department: d.department, day: d.today, body: $('dpNoteBody').value }) }); toast('朝礼の内容を保存しました'); render('dept'); }
        catch (e) { msg.textContent = e.message; }
      });
    }
    if (d.canEdit) {
      const syncCat = () => $('dpMonthWrap').classList.toggle('hidden', $('dpCat').value === 'other');
      $('dpCat').addEventListener('change', syncCat); syncCat();
      $('dpUpload').addEventListener('click', async () => {
        const msg = $('dpMsg'); msg.className = 'msg';
        const file = $('dpFile').files[0];
        if (!file) { msg.textContent = 'ファイルを選択してください'; return; }
        $('dpUpload').disabled = true; $('dpUpload').textContent = '送信中…';
        const fd = new FormData();
        fd.append('department', d.department); fd.append('category', $('dpCat').value); fd.append('month', $('dpMonth').value); fd.append('title', $('dpTitle').value); fd.append('file', file);
        try {
          const res = await fetch('/api/dept/files', { method: 'POST', body: fd });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');
          toast('登録しました'); render('dept');
        } catch (e) { msg.textContent = e.message; $('dpUpload').disabled = false; $('dpUpload').textContent = 'アップロード'; }
      });
    }
  }

  // ---- 緊急連絡・安否確認（職員の回答画面）------------------------------------------------
  async function alertPage({ id } = {}) {
    const alertId = id || state.alertId;
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">読み込み中…</div>`;
    let d;
    try { d = await api(`/api/alerts/${alertId}`); } catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const a = d.alert, my = d.myResponse;
    const closed = !!a.closedAt;
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <article class="detail em-detail ${a.kind}">
        <div class="meta"><span class="tag ${a.kind === 'emergency' ? 'important' : 'department'}">${a.isTest ? '【テスト】' : ''}${esc(a.kindLabel)}</span><span>${fmtDate(a.createdAt, true)}</span><span>宛先：${esc(a.targetLabel)}</span></div>
        <h2>${esc(a.title)}</h2>
        <div class="body">${esc(a.body || '')}</div>
        ${a.senderName ? `<div class="author">送信：${esc(a.senderName)}</div>` : ''}
      </article>
      <div class="form em-form">
        ${a.isTest ? '<p class="hl-locked">これはテスト送信です。実際の災害・緊急事態ではありません。操作の練習として回答してください。</p>' : ''}
        ${closed ? '<p class="hl-locked">この連絡は締め切られています。</p>' : ''}
        ${my ? `<p class="em-done">${a.kind === 'emergency' ? '確認済み' : `回答済み：${esc(d.safetyStatus[my.status])}／${esc(d.canWork[my.canWork])}`}　${fmtDate(my.respondedAt, true)}${my.comment ? `<br>${esc(my.comment)}` : ''}</p>` : ''}
        ${closed ? '' : a.kind === 'emergency' ? `
          <h3>内容を確認したら押してください</h3>
          <div class="row"><button class="btn em-btn" id="emConfirm" ${my ? 'disabled' : ''}>${my ? '確認済み' : '確認しました'}</button></div>`
        : `
          <h3>${my ? '回答を修正する' : 'あなたの状況を教えてください'}</h3>
          <label>状況</label>
          <div class="em-choices">${Object.entries(d.safetyStatus).map(([k, l]) => `<label class="em-choice ${k}"><input type="radio" name="emStatus" value="${k}" ${my && my.status === k ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
          <label>出勤できますか</label>
          <div class="em-choices">${Object.entries(d.canWork).map(([k, l]) => `<label class="em-choice"><input type="radio" name="emWork" value="${k}" ${my && my.canWork === k ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
          <label>コメント（現在地、家族の状況、必要な支援など）</label>
          <input id="emComment" maxlength="300" value="${esc(my ? my.comment : '')}" placeholder="例：自宅にいます。家族も無事です">
          <div class="row"><button class="btn em-btn" id="emSend">${my ? '回答を更新する' : '回答を送信する'}</button></div>`}
        <div class="msg" id="emMsg"></div>
      </div>
      ${d.canManage ? `<div class="page"><button class="btn outline" data-go="alerts" data-alert="${a.id}">集計を見る（送信者用）</button></div>` : ''}`;
    const send = async (payload) => {
      const msg = $('emMsg'); msg.className = 'msg';
      try { await api(`/api/alerts/${a.id}/respond`, { method: 'POST', body: JSON.stringify(payload) }); toast(a.kind === 'emergency' ? '確認を送信しました' : '回答を送信しました。ありがとうございます'); render('alert', { id: a.id }); }
      catch (e) { msg.textContent = e.message; }
    };
    if ($('emConfirm')) $('emConfirm').addEventListener('click', () => { $('emConfirm').disabled = true; send({}); });
    if ($('emSend')) $('emSend').addEventListener('click', () => {
      const st = document.querySelector('input[name=emStatus]:checked'), wk = document.querySelector('input[name=emWork]:checked');
      send({ status: st ? st.value : '', canWork: wk ? wk.value : '', comment: $('emComment').value });
    });
  }

  // ---- 緊急連絡・安否確認（送信者：管理者・部長）----------------------------------------------
  async function alertsPage({ id } = {}) {
    if (!state.user.canSendAlerts) { render('home'); return; }
    const alertId = id || state.alertsFocus;
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">読み込み中…</div>`;
    let d, s = null;
    try { d = await api('/api/alerts'); if (alertId) s = await api(`/api/alerts/${alertId}/summary`); }
    catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">緊急連絡・安否確認</h1><p class="page-lead">送信すると対象者全員に通知が届きます。実際に送る前に「テスト送信」で動作を確認してください。</p></div>
      ${s ? `
      <div class="card em-sum"><div class="head"><span class="tag ${s.alert.kind === 'emergency' ? 'important' : 'department'}">${s.alert.isTest ? '【テスト】' : ''}${esc(s.alert.kindLabel)}</span><b>${esc(s.alert.title)}</b><span class="m">${fmtDate(s.alert.createdAt, true)}　宛先：${esc(s.alert.targetLabel)}${s.alert.closedAt ? '　締切済み' : ''}</span></div>
        <div class="lv-grid" style="grid-template-columns:repeat(${s.alert.kind === 'safety' ? 4 : 3},1fr)">
          <div><span class="k">対象</span><b>${s.total}</b></div><div class="hi"><span class="k">${s.alert.kind === 'emergency' ? '確認済み' : '回答'}</span><b>${s.responded}</b></div><div class="${s.unanswered ? 'warn' : ''}"><span class="k">未回答</span><b>${s.unanswered}</b></div>
          ${s.alert.kind === 'safety' ? `<div class="${s.severe ? 'warn' : ''}"><span class="k">重傷・要支援</span><b>${s.severe}</b></div>` : ''}
        </div>
        ${s.alert.kind === 'safety' ? `<div class="lv-note">無事 ${s.safe}　軽傷 ${s.minor}　重傷・要支援 ${s.severe}　／　出勤できる ${s.canWorkYes}　できない ${s.canWorkNo}</div>` : ''}
        <div class="row" style="margin-top:10px">
          ${s.alert.closedAt ? `<button class="btn outline" data-emclose="${s.alert.id}" data-reopen="1">締切を解除</button>` : `<button class="btn" data-emremind="${s.alert.id}" ${s.unanswered ? '' : 'disabled'}>未回答者に再通知（${s.unanswered}名）</button><button class="btn outline" data-emclose="${s.alert.id}">締め切る</button>`}
          <a class="btn quiet" href="/api/alerts/${s.alert.id}/export.csv" download>CSV</a><button class="btn quiet" data-emrefresh="${s.alert.id}">更新</button>
        </div>
        ${s.alert.remindedAt ? `<div class="lv-note">最終再通知 ${fmtDate(s.alert.remindedAt, true)}</div>` : ''}
      </div>
      <div class="sec-label">回答状況（未回答・要支援が上）</div>
      <ul class="alist lv-list">${s.rows.map((r) => `<li class="${r.status === 'severe' ? 'hl-alert' : ''}"><span><span class="t">${esc(r.name)}<span class="m">　${esc(r.department)}${r.section ? ` ${esc(r.section)}` : ''}</span></span><br>
        <span class="m"><span class="tag ${r.responded ? (r.status === 'severe' ? 'st-rejected' : 'st-approved') : 'st-pending'}">${esc(r.statusLabel)}</span>${r.canWorkLabel ? `　${esc(r.canWorkLabel)}` : ''}${r.respondedAt ? `　${fmtDate(r.respondedAt, true)}` : ''}${r.comment ? `<br>${esc(r.comment)}` : ''}</span></span></li>`).join('')}</ul>` : ''}

      <div class="form"><h3>新しく送信する</h3>
        <div class="grid2">
          <div><label>種類</label><select id="emKind"><option value="safety">安否確認（無事・軽傷・重傷／出勤可否）</option><option value="emergency">緊急連絡（確認ボタンのみ）</option></select></div>
          <div><label>宛先</label><select id="emTarget">${d.canTargetAll ? '<option value="all">全職員</option>' : ''}${d.departments.filter((n) => d.canTargetAll || n === d.myDepartment).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></div>
        </div>
        <label>件名</label><input id="emTitle" maxlength="80" placeholder="例：地震発生に伴う安否確認">
        <label>本文</label><textarea id="emBody" placeholder="例：本日 14:30 頃の地震について、安否と出勤可否を回答してください。けがをした方は無理せず、まず安全を確保してください。"></textarea>
        <div class="row">
          <label class="check"><input type="checkbox" id="emTest" checked>テスト送信（件名に【テスト】が付きます）</label>
        </div>
        <div class="row"><button class="btn em-btn" id="emCreate">送信する</button></div>
        <div class="msg" id="emMsg"></div>
      </div>
      <div class="sec-label">送信履歴</div>
      <ul class="alist">${d.alerts.map((a) => `<li><span><span class="tag ${a.kind === 'emergency' ? 'important' : 'department'}">${a.isTest ? 'テスト' : esc(a.kindLabel)}</span> <span class="t">${esc(a.title)}</span><br><span class="m">${fmtDate(a.createdAt, true)}　${esc(a.targetLabel)}　回答 ${a.responded}/${a.total}${a.severe ? `　<span class="rej">要支援 ${a.severe}</span>` : ''}${a.closedAt ? '　締切' : ''}</span></span><span class="ops"><button data-emopen="${a.id}">集計</button></span></li>`).join('') || '<li class="empty">まだ送信していません</li>'}</ul>`;
    $('emCreate').addEventListener('click', async () => {
      const msg = $('emMsg'); msg.className = 'msg';
      const isTest = $('emTest').checked;
      const kindLabel = $('emKind').value === 'safety' ? '安否確認' : '緊急連絡';
      if (!confirm(isTest ? `テストとして${kindLabel}を送信します。よろしいですか？` : `【本番送信】${kindLabel}を「${$('emTarget').selectedOptions[0].textContent}」に送信します。対象者全員に通知が届きます。よろしいですか？`)) return;
      $('emCreate').disabled = true;
      try {
        const r = await api('/api/alerts', { method: 'POST', body: JSON.stringify({ kind: $('emKind').value, target: $('emTarget').value, title: $('emTitle').value, body: $('emBody').value, isTest }) });
        toast(`送信しました（対象 ${r.targets}名、通知 ${r.push.sent} 端末）`);
        state.alertsFocus = r.alert.id; render('alerts', { id: r.alert.id });
      } catch (e) { msg.textContent = e.message; $('emCreate').disabled = false; }
    });
  }

  // ---- 体調管理報告（本人）-----------------------------------------------------------
  async function healthReportPage() {
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="page"><h1 class="page-title">体調報告</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api('/api/health/me'); } catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const r = d.report;
    const locked = !!(r && r.confirmed);
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">本日の体調報告</h1><p class="page-lead">${fmtDate(d.today)}　出社時に体温と症状の有無をお知らせください。所属長・主任が確認します。</p></div>
      <div class="form hl-form">
        ${locked ? `<p class="hl-locked">本日の報告は ${esc(r.confirmerName)} が確認済みです。変更がある場合は所属長に直接お伝えください。</p>` : ''}
        <label>体温（℃）</label>
        <div class="hl-temp"><input id="hTemp" type="number" inputmode="decimal" step="0.1" min="34" max="42" placeholder="36.5" value="${r && r.temperature != null ? r.temperature.toFixed(1) : ''}" ${locked ? 'disabled' : ''}><span>℃</span></div>
        <label>症状（あるものにチェック）</label>
        <div class="hl-checks">
          ${d.symptoms.map((s) => `<label class="hl-check"><input type="checkbox" id="h_${s.key}" ${r && r.flags[s.key] ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(s.label)}</span></label>`).join('')}
        </div>
        <label>その他（気になることがあれば自由に）</label>
        <input id="hOther" maxlength="200" placeholder="例：頭痛あり、昨夜から倦怠感" value="${esc(r ? r.other : '')}" ${locked ? 'disabled' : ''}>
        ${locked ? '' : `<div class="row"><button class="btn" id="hSubmit">${r ? '修正して報告する' : '報告する'}</button></div>`}
        <div class="msg" id="hMsg"></div>
      </div>
      <div class="sec-head"><h2>直近2か月の報告</h2><span class="more">${d.history.length}件　要注意 ${d.history.filter((h) => h.alert).length}件</span></div>
      ${[...new Set(d.history.map((h) => h.day.slice(0, 7)))].map((ym) => `
        <div class="sec-label">${ym.replace('-', '年')}月</div>
        <ul class="alist hl-list">${d.history.filter((h) => h.day.slice(0, 7) === ym).map((h) => `<li class="${h.alert ? 'hl-alert' : ''}"><span><span class="t">${fmtDate(h.day)}　${h.temperature.toFixed(1)}℃${h.alert ? ' <span class="tag st-rejected">要注意</span>' : ''}</span><br><span class="m">${h.symptoms.length ? esc(h.symptoms.join('・')) : '症状なし'}${h.other ? `　${esc(h.other)}` : ''}　${h.confirmed ? `確認：${esc(h.confirmerName)}` : '未確認'}</span></span></li>`).join('')}</ul>`).join('') || '<ul class="alist"><li class="empty">まだ報告はありません</li></ul>'}`;
    if (locked) return;
    $('hSubmit').addEventListener('click', async () => {
      const msg = $('hMsg'); msg.className = 'msg'; $('hSubmit').disabled = true;
      const payload = { temperature: $('hTemp').value, other: $('hOther').value };
      d.symptoms.forEach((s) => { payload[s.key] = $(`h_${s.key}`).checked; });
      try {
        const res = await api('/api/health/report', { method: 'POST', body: JSON.stringify(payload) });
        state.status.healthToday = res.report;
        toast(res.report.alert ? '報告しました。お大事にしてください' : '報告しました。今日もよろしくお願いします');
        render('home');
      } catch (e) { msg.textContent = e.message; $('hSubmit').disabled = false; }
    });
    $('hTemp').focus();
  }

  // ---- 体調管理報告の一覧（所属長・主任）------------------------------------------------
  async function healthPage() {
    if (!state.user.isHealthViewer) { render('home'); return; }
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="page"><h1 class="page-title">体調報告の確認</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api(`/api/health/list${state.healthDay ? `?day=${state.healthDay}` : ''}`); }
    catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const unconfirmed = d.reports.filter((r) => !r.confirmed), confirmed = d.reports.filter((r) => r.confirmed);
    const row = (r) => `
      <li class="${r.alert ? 'hl-alert' : ''}"><span><span class="t">${esc(r.userName)}<span class="m">　${esc(r.section || r.department)}${r.job ? ` ${esc(r.job)}` : ''}</span></span><br>
        <span class="t hl-val">${r.temperature.toFixed(1)}℃${r.alert ? ' <span class="tag st-rejected">要注意</span>' : ''}　${r.symptoms.length ? esc(r.symptoms.join('・')) : '<span class="m">症状なし</span>'}</span>${r.other ? `<br><span class="m">その他：${esc(r.other)}</span>` : ''}<br>
        <span class="m">報告 ${r.updatedAt.slice(11, 16)}${r.confirmed ? `　確認：${esc(r.confirmerName)} ${r.confirmedAt.slice(11, 16)}` : ''}</span></span>
        <span class="ops">${r.confirmed ? `<button data-hconfirm="${r.id}" data-undo="1">取消</button>` : `<button class="on" data-hconfirm="${r.id}">確認済み</button>`}</span></li>`;
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">体調報告の確認</h1><p class="page-lead">${esc(d.scope)}の報告です。内容を見て「確認済み」を押してください。</p></div>
      <div class="card lv-bal"><div class="head"><span class="chip hl">${fmtDate(d.day)}${d.day === d.today ? '（本日）' : ''}</span><span class="fy-nav"><button data-hday="${shiftDay(d.day, -1)}">‹ 前日</button><button data-hday="${shiftDay(d.day, 1)}" ${d.day >= d.today ? 'disabled' : ''}>翌日 ›</button>${d.day !== d.today ? `<button data-hday="${d.today}">本日</button>` : ''}</span></div>
        <div class="lv-grid" style="grid-template-columns:repeat(3,1fr)"><div><span class="k">報告</span><b>${d.reports.length}件</b></div><div class="${unconfirmed.length ? 'hi' : ''}"><span class="k">未確認</span><b>${unconfirmed.length}件</b></div><div class="${d.reports.filter((r) => r.alert).length ? 'warn' : ''}"><span class="k">要注意</span><b>${d.reports.filter((r) => r.alert).length}件</b></div></div></div>
      ${unconfirmed.length ? `<div class="sec-label">未確認（${unconfirmed.length}件）</div><ul class="alist lv-list">${unconfirmed.map(row).join('')}</ul>` : ''}
      ${d.missing.length ? `<div class="sec-label">出社済みで未報告（${d.missing.length}名）</div><ul class="alist"><li><span class="m">${d.missing.map((m) => esc(m.userName)).join('、')}</span></li></ul>` : ''}
      <div class="sec-label">確認済み（${confirmed.length}件）</div>
      <ul class="alist lv-list">${confirmed.map(row).join('') || '<li class="empty">なし</li>'}</ul>`;
  }
  function shiftDay(s, n) { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // ---- 休暇（職員用）-------------------------------------------------------------
  async function leavePage() {
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="page"><h1 class="page-title">休暇</h1><p class="page-lead">読み込み中…</p></div>`;
    let lv;
    try { lv = await api(`/api/leave/me${state.leaveFy ? `?fy=${state.leaveFy}` : ''}`); state.leave = lv; }
    catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const b = lv.balance, fy = lv.fiscalYear;
    const five = Math.min(5, lv.fiveDays);
    const f = state.leaveFilter;
    const list = lv.requests.filter((r) => f === 'all' || r.status === f);
    const todayStr = lv.today;
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">休暇</h1><p class="page-lead">年次有給休暇の残数の確認と、休暇の申請ができます。</p></div>

      <div class="card lv-bal">
        <div class="head"><span class="chip lv">${fy}年度の年休</span><span class="fy-nav"><button data-lvfy="${fy - 1}">‹ 前年度</button><button data-lvfy="${fy + 1}" ${fy >= Number(todayStr.slice(0, 4)) ? 'disabled' : ''}>翌年度 ›</button></span></div>
        ${b.granted ? `
        <div class="lv-grid">
          <div><span class="k">前年度繰越</span><b>${b.carriedDays}日${b.carriedHours ? ` ${b.carriedHours}h` : ''}</b></div>
          <div><span class="k">当年度付与</span><b>${b.grantedDays}日</b></div>
          <div><span class="k">当年度合計</span><b>${b.totalDays}日</b></div>
          <div class="hi"><span class="k">残り</span><b>${esc(fmtBal(b))}</b></div>
        </div>
        <div class="lv-five"><span>年5日の取得状況</span><div class="bar"><i style="width:${(five / 5) * 100}%"></i></div><span>${lv.fiveDays}日 / 5日${lv.fiveDays >= 5 ? '　達成' : ''}</span></div>
        <div class="lv-note">付与日 ${fmtDate(b.grantDate)}　・　時間年休は1日＝${lv.hoursPerDay}時間　・　承認待ち分を除いた申請可能量 ${Math.floor(b.availableHours / lv.hoursPerDay)}日 ${b.availableHours % lv.hoursPerDay}時間</div>`
        : `<div class="empty" style="padding:14px">${fy}年度の年休はまだ付与されていません。${b.planned ? `（予定：${fmtDate(b.planned.grantDate)} に ${b.planned.days}日）` : '入職日の登録について事務部にご確認ください。'}</div>`}
      </div>

      <div class="form"><h3>休暇を申請する</h3>
        <div class="grid2">
          <div><label>休暇種別</label><select id="lvType">
            <optgroup label="有給">${lv.types.filter((t) => t.paid).map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</optgroup>
            <optgroup label="無給">${lv.types.filter((t) => !t.paid).map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</optgroup>
          </select></div>
          <div><label>単位</label><select id="lvUnit"></select></div>
          <div><label>開始日</label><input id="lvStart" type="date" value="${todayStr}"></div>
          <div id="lvEndWrap"><label>終了日（連続する場合）</label><input id="lvEnd" type="date" value="${todayStr}"></div>
          <div id="lvDaysWrap"><label>申請日数（0.5日単位）</label><input id="lvDays" type="number" step="0.5" min="0.5" value="1"></div>
          <div id="lvHoursWrap" class="hidden"><label>申請時間（1〜${lv.hoursPerDay - 1}時間）</label><input id="lvHours" type="number" min="1" max="${lv.hoursPerDay - 1}" value="1"></div>
          <div id="lvTimeWrap" class="hidden"><label>時刻（任意）</label><div class="lv-time"><input id="lvTimeS" type="time"><span>〜</span><input id="lvTimeE" type="time"></div></div>
          <div><label>休憩</label><select id="lvBreak"><option value="">該当なし</option><option value="1">有</option><option value="0">無</option></select></div>
        </div>
        <label>理由（病名等は書かず「私用」「子の発熱」などで可）</label><input id="lvReason" maxlength="200" placeholder="私用">
        <div class="row"><button class="btn" id="lvSubmit">申請する</button></div>
        <div class="msg" id="lvMsg"></div>
      </div>

      <div class="sec-head"><h2>申請の履歴</h2></div>
      <div class="filters">${['all', 'pending', 'approved', 'cancel_pending', 'rejected', 'cancelled'].map((k) => `<button class="${f === k ? 'on' : ''}" data-lvfilter="${k}">${k === 'all' ? 'すべて' : STATUS_LABEL[k]}</button>`).join('')}</div>
      <ul class="alist lv-list">${list.map((r) => `
        <li><span><span class="tag st-${r.status}">${STATUS_LABEL[r.status]}</span> <span class="t">${fmtReqDate(r)}　${esc(r.typeLabel)} ${esc(fmtReqAmount(r))}</span><br>
          <span class="m">届出 ${fmtDate(r.createdAt)}${r.reason ? `　${esc(r.reason)}` : ''}${r.approverName ? `　${r.status === 'rejected' ? '差戻し' : '承認'}：${esc(r.approverName)}` : ''}${r.rejectReason ? `<br><span class="rej">理由：${esc(r.rejectReason)}</span>` : ''}
          ${r.status === 'cancel_pending' ? `<br>取消申請 ${fmtDate(r.cancelRequestedAt)}　${esc(r.cancelReason)}（課長の承認待ち）` : ''}${r.status === 'cancelled' && r.cancelDeciderName ? `<br>取消承認：${esc(r.cancelDeciderName)}　${esc(r.cancelReason)}` : ''}${r.status === 'approved' && r.cancelRejectReason ? `<br><span class="rej">取消は認められませんでした：${esc(r.cancelRejectReason)}</span>` : ''}</span></span>
          <span class="ops">${r.status === 'pending' ? `<button class="del" data-lvcancel="${r.id}">取消</button>` : r.status === 'approved' && r.startDate >= todayStr ? `<button class="del" data-lvcancel="${r.id}" data-approved="1">取消を申請</button>` : ''}</span></li>`).join('') || '<li class="empty">申請はまだありません</li>'}</ul>
      <p class="lv-note" style="margin:8px 28px 0">承認済みの休暇は、休暇当日中までご本人から取消を申請できます（課長の承認で確定）。翌日以降は事務部にご連絡ください。</p>`;

    const typeOf = () => lv.types.find((t) => t.key === $('lvType').value);
    const syncUnits = () => {
      const t = typeOf();
      $('lvUnit').innerHTML = t.units.map((u) => `<option value="${u}">${esc(lv.units[u])}</option>`).join('');
      syncUnit();
    };
    const syncUnit = () => {
      const u = $('lvUnit').value;
      $('lvEndWrap').classList.toggle('hidden', u !== 'day');
      $('lvDaysWrap').classList.toggle('hidden', u !== 'day');
      $('lvHoursWrap').classList.toggle('hidden', u !== 'hour');
      $('lvTimeWrap').classList.toggle('hidden', u !== 'hour');
      if (u === 'day') syncDays();
    };
    const syncDays = () => {
      const s = $('lvStart').value, e = $('lvEnd').value;
      if (s && e && e >= s) { const n = Math.round((Date.parse(e) - Date.parse(s)) / 86400000) + 1; $('lvDays').value = n; }
    };
    $('lvType').addEventListener('change', syncUnits);
    $('lvUnit').addEventListener('change', syncUnit);
    $('lvStart').addEventListener('change', () => { if ($('lvEnd').value < $('lvStart').value) $('lvEnd').value = $('lvStart').value; syncDays(); });
    $('lvEnd').addEventListener('change', syncDays);
    syncUnits();
    $('lvSubmit').addEventListener('click', async () => {
      const msg = $('lvMsg'); msg.className = 'msg'; $('lvSubmit').disabled = true;
      const unit = $('lvUnit').value;
      const payload = {
        type: $('lvType').value, unit, startDate: $('lvStart').value, endDate: unit === 'day' ? $('lvEnd').value : $('lvStart').value,
        days: unit === 'day' ? Number($('lvDays').value) : undefined, hours: unit === 'hour' ? Number($('lvHours').value) : undefined,
        startTime: $('lvTimeS').value, endTime: $('lvTimeE').value,
        breakTaken: $('lvBreak').value === '' ? null : Number($('lvBreak').value), reason: $('lvReason').value,
      };
      try {
        const r = await api('/api/leave/requests', { method: 'POST', body: JSON.stringify(payload) });
        toast(r.approvers.length ? `申請しました（${r.approvers.join('・')} に通知）` : '申請しました');
        state.leaveFilter = 'all'; render('leave');
      } catch (e) { msg.textContent = e.message; $('lvSubmit').disabled = false; }
    });
  }

  // ---- 休暇の承認（課長・部長）------------------------------------------------------
  async function approvePage() {
    if (!state.user.isApprover) { render('home'); return; }
    main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="page"><h1 class="page-title">休暇の承認</h1><p class="page-lead">読み込み中…</p></div>`;
    let d;
    try { d = await api('/api/leave/approvals'); state.approvals = d; }
    catch (e) { main.innerHTML = `<button class="back" data-go="home">‹ ホームへ戻る</button><div class="empty">${esc(e.message)}</div>`; return; }
    const row = (r, ops) => `
      <li><span>${r.status === 'cancel_pending' ? '<span class="tag st-cancel_pending">取消申請</span> ' : ''}<span class="t">${esc(r.userName)}<span class="m">　${esc(r.department)}${r.section ? ` ${esc(r.section)}` : ''}</span></span><br>
        <span class="t">${fmtReqDate(r)}　${esc(r.typeLabel)} ${esc(fmtReqAmount(r))}</span><br>
        <span class="m">届出 ${fmtDate(r.createdAt)}${r.breakTaken === 1 ? '　休憩有' : r.breakTaken === 0 ? '　休憩無' : ''}${r.reason ? `　${esc(r.reason)}` : ''}${ops ? '' : `　<span class="tag st-${r.status}">${STATUS_LABEL[r.status]}</span> ${esc(r.cancelDeciderName || r.approverName)}${r.rejectReason ? `　理由：${esc(r.rejectReason)}` : ''}${r.cancelRejectReason ? `　取消却下：${esc(r.cancelRejectReason)}` : ''}`}
        ${r.status === 'cancel_pending' ? `<br><span class="rej">取消理由：${esc(r.cancelReason)}</span>（承認者：${esc(r.approverName)}）` : ''}</span></span>
        ${ops ? (r.status === 'cancel_pending'
          ? `<span class="ops"><button class="on" data-lvapprove="${r.id}" data-cancel="1">取消を承認</button><button class="del" data-lvreject="${r.id}" data-cancel="1">取消を却下</button></span>`
          : `<span class="ops"><button class="on" data-lvapprove="${r.id}">承認</button><button class="del" data-lvreject="${r.id}">差戻し</button></span>`) : ''}</li>`;
    main.innerHTML = `
      <button class="back" data-go="home">‹ ホームへ戻る</button>
      <div class="page"><h1 class="page-title">休暇の承認</h1><p class="page-lead">${state.user.isAdmin ? '全部門' : esc(state.user.department)}の申請を承認・差戻しできます。課長・部長のどちらか1人の承認で確定します。</p></div>
      <div class="sec-label">承認待ち（${d.pending.length}件）</div>
      <ul class="alist lv-list">${d.pending.map((r) => row(r, true)).join('') || '<li class="empty">承認待ちの申請はありません</li>'}</ul>
      <div class="sec-label">最近の処理</div>
      <ul class="alist lv-list">${d.recent.map((r) => row(r, false)).join('') || '<li class="empty">なし</li>'}</ul>`;
  }

  // ---- マイページ ---------------------------------------------------------
  async function mypage() {
    const u = state.user, st = state.status;
    main.innerHTML = `
      <div class="page">
        <h1 class="page-title">マイページ</h1>
        <div class="profile"><div class="avatar" role="img" aria-label="かのいわんこ"></div><div><div class="n">${esc(u.name)}</div><div class="s">職員番号 ${esc(u.staffId)}　${esc(st.rank)} ランク　${num(st.points)} pt</div></div></div>
        <dl class="kv"><dt>部門</dt><dd>${esc(u.department || '未設定')}${u.section ? `　${esc(u.section)}` : ''}</dd><dt>職種</dt><dd>${esc(u.job || '未設定')}</dd><dt>役職</dt><dd>${esc(u.roleLabel)}</dd><dt>入職日</dt><dd>${u.hireDate ? fmtDate(u.hireDate) : '未登録（事務部へ）'}</dd><dt>権限</dt><dd>${u.isAdmin ? '管理者' : '一般'}</dd></dl>
        <section class="sec" style="margin:8px 0 18px"><h3>休暇・体調</h3><ul class="clist">
          <li><button data-go="leave"><span class="t">年休の残数・休暇の申請</span>${chev}</button></li>
          ${u.isApprover ? `<li><button data-go="approve"><span class="t">休暇の承認（承認待ち ${u.pendingApprovals}件）</span>${chev}</button></li>` : ''}
          <li><button data-go="healthReport"><span class="t">本日の体調報告・履歴（直近2か月）</span>${chev}</button></li>
          ${u.isHealthViewer ? `<li><button data-go="health"><span class="t">体調報告の確認（未確認 ${u.healthUnconfirmed}件）</span>${chev}</button></li>` : ''}
          ${u.canSendAlerts ? `<li><button data-go="alerts"><span class="t">緊急連絡・安否確認の送信と集計</span>${chev}</button></li>` : ''}
          <li><button data-go="dept"><span class="t">部署ごとのページ（朝礼・シフト・担当表）</span>${chev}</button></li>
          <li><button data-go="training"><span class="t">研修資料・受講記録</span>${chev}</button></li>
          <li><button data-go="surveys"><span class="t">アンケート${u.openSurveys ? `（未回答 ${u.openSurveys}件）` : ''}${u.canCreateSurveys ? '・作成' : ''}</span>${chev}</button></li>
          <li><button data-go="schedule"><span class="t">スケジュール</span>${chev}</button></li>
          <li><button data-go="schedGroups"><span class="t">スケジュールのグループ管理</span>${chev}</button></li>
        </ul></section>
        <div class="push" id="pushPanel"></div>

        <section class="sec" style="margin:18px 0"><h3>今週の歩数</h3><div class="week" id="week"></div></section>
        <section class="sec" style="margin:26px 0 18px"><h3>ポイント履歴</h3><ul class="hist" id="hist"><li class="empty">読み込み中…</li></ul></section>

        <section class="sec" style="margin:18px 0"><h3>パスワードの変更</h3>
          <ul class="clist"><li style="padding:12px 14px">
            <div class="field"><label for="curPw">現在のパスワード</label><input id="curPw" type="password" autocomplete="current-password"></div>
            <div class="field"><label for="newPw">新しいパスワード（数字4桁）</label><input id="newPw" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></div>
            ${u.passwordChangedAt ? `<p class="hint" style="margin:0 0 10px">最終変更：${fmtDate(u.passwordChangedAt, true)}</p>` : ''}
            <button class="btn outline" id="pwBtn">変更する</button><div class="msg" id="pwMsg"></div>
          </li></ul>
        </section>
        ${u.isAdmin ? `<section class="sec" style="margin:0 0 18px"><h3>管理者メニュー</h3><ul class="clist"><li><a href="/?mode=staff"><span class="t">管理モードを開く（お知らせ・記事の投稿、職員管理）</span>${chev}</a></li></ul></section>` : ''}
        <div style="text-align:center;margin-top:8px"><button class="btn quiet" id="logoutBtn">ログアウト</button></div>
      </div>`;
    renderPushPanel();
    $('pwBtn').addEventListener('click', async () => {
      const msg = $('pwMsg'); msg.className = 'msg';
      try {
        await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $('curPw').value, newPassword: $('newPw').value }) });
        msg.className = 'msg ok'; msg.textContent = '変更しました。'; $('curPw').value = ''; $('newPw').value = '';
      } catch (e) { msg.textContent = e.message; }
    });
    $('logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); state.user = null; state.notices = []; render('login'); });

    try {
      const { history, week } = await api('/api/points/history');
      const hist = $('hist'), wk = $('week');
      if (!hist) return;
      hist.innerHTML = history.map((h) => `<li><span><span>${esc(KIND_LABEL[h.kind] || h.kind)}${h.note ? `（${esc(h.note)}）` : ''}</span><br><span class="d">${fmtDate(h.createdAt, true)}</span></span><span class="p">+${num(h.points)} pt</span></li>`).join('') || '<li class="empty">まだ履歴はありません</li>';
      const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return d; });
      const map = Object.fromEntries(week.map((w) => [w.day, w.steps]));
      const max = Math.max(state.rules.stepsGoal, ...week.map((w) => w.steps), 1);
      wk.innerHTML = days.map((d) => {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const v = map[key] || 0;
        return `<div class="${v >= state.rules.stepsGoal ? 'goal' : ''}" style="height:${Math.max(3, Math.round((v / max) * 60))}px" title="${num(v)}歩"><span>${d.getMonth() + 1}/${d.getDate()}</span></div>`;
      }).join('');
    } catch (_) { /* 履歴はなくても画面は使える */ }
  }

  async function renderPushPanel() {
    const panel = $('pushPanel');
    if (!panel) return;
    if (!pushSupported() || (isIOS() && !isStandalone())) {
      panel.innerHTML = isIOS()
        ? `<strong>通知を受け取るには、ホーム画面に追加してください</strong>
           <ol><li>Safari 下部の <b>共有ボタン</b>（四角から矢印が出ているマーク）をタップ</li><li>「<b>ホーム画面に追加</b>」を選ぶ</li><li>ホーム画面のアイコンから開き直し、ここで「通知を受け取る」をタップ</li></ol>
           <p>iOS 16.4 以降が必要です。</p>`
        : `<strong>この環境では通知を利用できません</strong><p>Chrome / Edge / Safari（最新版）でお試しください。</p>`;
      return;
    }
    if (Notification.permission === 'denied') {
      panel.innerHTML = `<strong>通知がブロックされています</strong><p>端末の設定 → 通知 から、このアプリの通知を許可してください。</p>`;
      return;
    }
    state.registration = await navigator.serviceWorker.ready;
    state.subscription = await state.registration.pushManager.getSubscription();
    if (state.subscription) {
      api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: state.subscription }) }).catch(() => {});
      panel.innerHTML = `<strong>この端末で通知を受け取ります</strong><p>新しいお知らせが投稿されると通知が届きます。部門別のお知らせは ${esc(state.user.department || '所属部門')}${state.user.section ? `（${esc(state.user.section)}）` : ''} 宛てのものだけ届きます。</p>
        <div class="row"><button class="btn outline" id="testPushBtn">テスト通知を送る</button><button class="btn quiet" id="unsubBtn">通知を止める</button></div><div class="msg" id="pushMsg"></div>`;
      $('testPushBtn').addEventListener('click', async () => {
        const msg = $('pushMsg'); msg.className = 'msg'; msg.textContent = '送信中…';
        try { const r = await api('/api/push/test', { method: 'POST' }); msg.className = 'msg ok'; msg.textContent = r.sent > 0 ? '送信しました。数秒以内に通知が届きます。' : '送信できませんでした。通知を止めてから、もう一度受け取る設定をしてください。'; }
        catch (e) { msg.textContent = e.message; }
      });
      $('unsubBtn').addEventListener('click', async () => {
        try { const endpoint = state.subscription.endpoint; await state.subscription.unsubscribe(); await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }); }
        finally { renderPushPanel(); }
      });
      return;
    }
    panel.innerHTML = `<strong>新しいお知らせを通知で受け取れます</strong><p>ボタンを押すと、端末の許可画面が表示されます。</p>
      <div class="row"><button class="btn" id="subBtn">通知を受け取る</button></div><div class="msg" id="pushMsg"></div>`;
    $('subBtn').addEventListener('click', async () => {
      $('subBtn').disabled = true;
      try { await subscribe(); renderPushPanel(); }
      catch (e) { $('pushMsg').textContent = e.message; $('subBtn').disabled = false; }
    });
  }

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('通知が許可されませんでした');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/public-key');
    const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
    state.subscription = subscription;
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  // ---- 管理モード（/?mode=staff）-------------------------------------------------
  const staffData = { departments: [], summary: null, users: [], contents: [], pickupId: 0, notices: [] };

  async function staff() {
    if (!isAdmin()) { render('home'); return; }
    const tab = state.staffTab;
    main.innerHTML = `
      <div class="staff-bar"><span>管理モード　${esc(state.user.name)}</span><a href="/">職員画面に戻る</a></div>
      <div class="stabs">
        ${[['notices', 'お知らせ'], ['contents', '記事・トピックス'], ['users', '職員'], ['leave', '休暇'], ['summary', '状況']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-stab="${k}">${l}</button>`).join('')}
      </div>
      <div id="staffBody"><div class="empty">読み込み中…</div></div>`;
    try {
      if (!staffData.departments.length) staffData.departments = (await api('/api/departments')).departments;
      if (tab === 'leave') { staffData.leave = await api(`/api/admin/leave/overview${staffData.leaveFy ? `?fy=${staffData.leaveFy}` : ''}`); staffData.leaveFy = staffData.leave.fiscalYear; staffLeave(); }
      if (tab === 'notices') { staffData.notices = (await api('/api/notices')).notices; staffNotices(); }
      if (tab === 'contents') { const r = await api('/api/admin/contents'); staffData.contents = r.contents; staffData.pickupId = r.pickupId; staffContents(); }
      if (tab === 'users') { staffData.users = (await api('/api/admin/users')).users; staffUsers(); }
      if (tab === 'summary') { staffData.summary = await api('/api/admin/summary'); staffSummary(); }
    } catch (e) { $('staffBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function staffSummary() {
    const s = staffData.summary;
    $('staffBody').innerHTML = `
      <div class="stats">
        <div><b>${s.users}</b>登録職員</div><div><b>${s.subscribedUsers}</b>通知ONの職員</div><div><b>${s.subscriptions}</b>通知ONの端末</div>
        <div><b>${s.checkinsToday}</b>本日の出社ポイント</div><div><b>${num(s.pointsTotal)}</b>発行ポイント合計</div>
      </div>
      <div class="form" style="margin-top:14px"><h3>体調報告のCSV出力（期間指定）</h3>
        <div class="row" style="margin-top:0"><input id="hcFrom" type="date" value="${new Date().toISOString().slice(0, 8)}01" style="width:auto"><span>〜</span><input id="hcTo" type="date" value="${new Date().toISOString().slice(0, 10)}" style="width:auto"><a class="btn outline" id="hcBtn" href="#" download>CSVを出力</a></div>
        <p class="page-lead" style="margin:8px 0 0">全部門の報告（体温・症状・その他・確認者）を出力します。本日の一覧確認は <button class="link" data-go="health">体調報告の確認</button> から。</p>
      </div>
      <div class="form" style="margin-top:14px"><h3>ポイントのルール（seed.js の POINT_RULES）</h3>
        <ul class="clist"><li style="padding:10px 14px;font-size:13px;display:block">
          出社ポイント +${state.rules.checkin}pt／日　・　目標歩数 ${num(state.rules.stepsGoal)} 歩で +${state.rules.stepsBonus}pt／日<br>
          くじ：${state.rules.lottery.map((t) => `${t.label} ${t.points}pt`).join('、')}<br>
          ランク：${state.rules.ranks.map((r) => `${r.name} ${num(r.min)}pt〜`).join('、')}
        </li></ul>
      </div>`;
    const syncCsv = () => { $('hcBtn').href = `/api/admin/health/export.csv?from=${$('hcFrom').value}&to=${$('hcTo').value}`; };
    $('hcFrom').addEventListener('change', syncCsv); $('hcTo').addEventListener('change', syncCsv); syncCsv();
  }

  function staffNotices() {
    const targets = staffData.departments.flatMap((d) => [{ v: d.name, l: `${d.name}${d.sections.length ? '（全体）' : ''}` }, ...d.sections.map((s) => ({ v: `${d.name}/${s}`, l: `　${d.name} ${s}` }))]);
    $('staffBody').innerHTML = `
      <div class="form"><h3>お知らせを投稿する</h3>
        <div class="grid2">
          <div><label>区分</label><select id="nCategory"><option value="general">一般（全職員）</option><option value="important">重要（全職員・赤バナー）</option><option value="department">部門別</option></select></div>
          <div id="nTargetWrap" class="hidden"><label>対象</label><select id="nTarget">${targets.map((t) => `<option value="${esc(t.v)}">${esc(t.l)}</option>`).join('')}</select></div>
        </div>
        <label>タイトル</label><input id="nTitle" maxlength="80" placeholder="例：10月の職員研修のご案内">
        <label>本文</label><textarea id="nBody" placeholder="通知には本文の1行目（80文字まで）が表示されます"></textarea>
        <label>添付ファイル（PDF・Excel・Word・画像、1ファイル10MBまで、5つまで）</label><input id="nFiles" type="file" multiple accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg">
        <div class="row"><label class="check"><input type="checkbox" id="nPush" checked>プッシュ通知も送る</label><button class="btn" id="nPost">投稿する</button></div>
        <div class="msg" id="nMsg"></div>
      </div>
      <div class="sec-label">配信済み（${staffData.notices.length}件）</div>
      <ul class="alist">${staffData.notices.map((n) => `<li><span><span class="tag ${n.category}">${esc(deptLabel(n))}</span> <span class="t">${esc(n.title)}</span><br><span class="m">${fmtDate(n.createdAt, true)}${(n.attachments || []).length ? `　📎${n.attachments.length}` : ''}</span></span><span class="ops"><button class="del" data-del-notice="${n.id}">削除</button></span></li>`).join('')}</ul>`;
    $('nCategory').addEventListener('change', () => $('nTargetWrap').classList.toggle('hidden', $('nCategory').value !== 'department'));
    $('nPost').addEventListener('click', async () => {
      const msg = $('nMsg'); msg.className = 'msg'; $('nPost').disabled = true;
      try {
        const fd = new FormData();
        fd.append('title', $('nTitle').value); fd.append('body', $('nBody').value); fd.append('push', $('nPush').checked ? '1' : '0'); fd.append('category', $('nCategory').value); fd.append('department', $('nTarget').value);
        [...$('nFiles').files].slice(0, 5).forEach((f) => fd.append('files', f));
        const res = await fetch('/api/admin/notices', { method: 'POST', body: fd }); const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r.error || '投稿に失敗しました');
        toast(r.push ? `投稿しました（通知 ${r.push.sent}/${r.push.total} 端末）` : '投稿しました');
        staff();
      } catch (e) { msg.textContent = e.message; $('nPost').disabled = false; }
    });
  }

  function staffContents() {
    const e = state.editing || { tab: 'culture', kind: 'article', section: '', title: '', body: '', note: '', url: '', author: '', date: new Date().toISOString().slice(0, 10), sortOrder: 0, published: true };
    const sections = [...new Set(staffData.contents.map((c) => c.section))];
    const isLink = e.kind === 'link';
    $('staffBody').innerHTML = `
      <div class="form"><h3>${e.id ? '記事を編集する' : '記事・トピックスを追加する'}</h3>
        <div class="grid2">
          <div><label>掲載タブ</label><select id="cTab">${Object.entries(TAB_LABEL).map(([k, l]) => `<option value="${k}" ${e.tab === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label>種類</label><select id="cKind"><option value="article" ${!isLink ? 'selected' : ''}>記事（本文あり）</option><option value="link" ${isLink ? 'selected' : ''}>リンク・連絡先</option></select></div>
        </div>
        <label>見出し（同じ見出しでまとまって表示されます）</label>
        <input id="cSection" list="sectionList" value="${esc(e.section)}" placeholder="例：院長メッセージ"><datalist id="sectionList">${sections.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        <label>タイトル</label><input id="cTitle" value="${esc(e.title)}" maxlength="120">
        <div id="cArticle" class="${isLink ? 'hidden' : ''}">
          <label>本文</label><textarea id="cBody">${esc(e.body)}</textarea>
          <div class="grid2"><div><label>投稿者・署名</label><input id="cAuthor" value="${esc(e.author)}" placeholder="例：院長"></div><div><label>日付</label><input id="cDate" type="date" value="${esc(e.date)}"></div></div>
        </div>
        <div id="cLink" class="${isLink ? '' : 'hidden'}">
          <div class="grid2"><div><label>補足（内線番号など）</label><input id="cNote" value="${esc(e.note)}" placeholder="例：内線 2101"></div><div><label>URL（電話は tel:2101 の形式）</label><input id="cUrl" value="${esc(e.url)}" placeholder="https://… または tel:…"></div></div>
        </div>
        <div class="grid2"><div><label>並び順（小さいほど上）</label><input id="cOrder" type="number" value="${Number(e.sortOrder || 0)}"></div><div><label>&nbsp;</label><label class="check"><input type="checkbox" id="cPub" ${e.published !== false ? 'checked' : ''}>公開する</label></div></div>
        <div class="row"><button class="btn" id="cSave">${e.id ? '更新する' : '追加する'}</button>${e.id ? '<button class="btn quiet" id="cCancel">キャンセル</button>' : ''}</div>
        <div class="msg" id="cMsg"></div>
      </div>
      ${Object.keys(TAB_LABEL).map((tab) => {
        const items = staffData.contents.filter((c) => c.tab === tab);
        return `<div class="sec-label">${TAB_LABEL[tab]}（${items.length}件）</div>
        <ul class="alist">${items.map((c) => `<li class="${c.published ? '' : 'unpub'}"><span><span class="t">${esc(c.title)}</span><br><span class="m">${esc(c.section)}　${c.kind === 'link' ? 'リンク' : fmtDate(c.date)}${c.published ? '' : '　非公開'}</span></span>
          <span class="ops">${c.kind === 'article' ? `<button class="${staffData.pickupId === c.id ? 'on' : ''}" data-pickup="${c.id}">${staffData.pickupId === c.id ? 'ピックアップ中' : 'ピックアップ'}</button>` : ''}<button data-edit-content="${c.id}">編集</button><button class="del" data-del-content="${c.id}">削除</button></span></li>`).join('') || '<li class="empty">なし</li>'}</ul>`;
      }).join('')}`;
    $('cKind').addEventListener('change', () => { const l = $('cKind').value === 'link'; $('cArticle').classList.toggle('hidden', l); $('cLink').classList.toggle('hidden', !l); });
    $('cSave').addEventListener('click', async () => {
      const msg = $('cMsg'); msg.className = 'msg'; $('cSave').disabled = true;
      const payload = { tab: $('cTab').value, kind: $('cKind').value, section: $('cSection').value, title: $('cTitle').value, body: $('cBody').value, author: $('cAuthor').value, date: $('cDate').value, note: $('cNote').value, url: $('cUrl').value, sortOrder: $('cOrder').value, published: $('cPub').checked };
      try {
        await api(e.id ? `/api/admin/contents/${e.id}` : '/api/admin/contents', { method: e.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        state.editing = null; toast(e.id ? '更新しました' : '追加しました'); staff();
      } catch (err) { msg.textContent = err.message; $('cSave').disabled = false; }
    });
    if ($('cCancel')) $('cCancel').addEventListener('click', () => { state.editing = null; staff(); });
  }

  function staffLeave() {
    const d = staffData.leave, fy = d.fiscalYear;
    const roles = Object.entries(d.roles);
    const ym = d.today.slice(0, 7);
    const ungranted = d.users.filter((u) => !u.balance.granted).length;
    $('staffBody').innerHTML = `
      <div class="form"><h3>${fy}年度の年休</h3>
        <div class="row" style="margin-top:0">
          <span class="fy-nav"><button data-slvfy="${fy - 1}">‹ ${fy - 1}年度</button><button data-slvfy="${fy + 1}">${fy + 1}年度 ›</button></span>
          <button class="btn" id="lvGrantRun">${fy}年度の付与を実行する</button>
        </div>
        <p class="page-lead" style="margin:8px 0 0">未付与 ${ungranted}名。付与は「入職日」と「週所定日数」から自動計算し、前年度の残りを繰越（上限40日）します。すでに付与済みの職員には影響しません。4/1 以降と、中途入職者の入職6か月後に実行してください。</p>
        <div class="msg" id="lvGrantMsg"></div>
      </div>
      <div class="form"><h3>月次の取得一覧（CSV・給与計算用）</h3>
        <div class="row" style="margin-top:0"><input id="lvCsvMonth" type="month" value="${ym}" style="width:auto"><a class="btn outline" id="lvCsvBtn" href="/api/admin/leave/export.csv?month=${ym}" download>CSVを出力</a></div>
      </div>
      ${d.pending.length ? `<div class="sec-label">承認待ち（全部門 ${d.pending.length}件）</div><ul class="alist lv-list">${d.pending.map((r) => `<li><span><span class="t">${esc(r.userName)}　${esc(r.department)}</span><br><span class="m">${fmtReqDate(r)}　${esc(r.typeLabel)} ${esc(fmtReqAmount(r))}　届出 ${fmtDate(r.createdAt)}${r.status === 'cancel_pending' ? `　<span class="rej">取消申請：${esc(r.cancelReason)}</span>` : ''}</span></span><span class="ops">${r.status === 'cancel_pending' ? `<button class="on" data-lvapprove="${r.id}" data-admin="1" data-cancel="1">取消承認</button><button class="del" data-lvreject="${r.id}" data-admin="1" data-cancel="1">取消却下</button>` : `<button class="on" data-lvapprove="${r.id}" data-admin="1">承認</button><button class="del" data-lvreject="${r.id}" data-admin="1">差戻し</button>`}</span></li>`).join('')}</ul>` : ''}
      <div class="sec-label">職員ごとの状況（${d.users.length}名）</div>
      <ul class="alist lv-list">${d.users.map((u) => `
        <li><span><span class="t">${esc(u.staffId)}　${esc(u.name)}</span>${u.role ? ` <span class="tag general">${esc(u.roleLabel)}</span>` : ''}<br>
          <span class="m">${esc(u.department)}${u.section ? ` ${esc(u.section)}` : ''}　入職 ${u.hireDate ? fmtDate(u.hireDate) : '<span class="rej">未設定</span>'}　週${u.weeklyDays}日</span><br>
          <span class="m">${u.balance.granted ? `繰越 ${u.balance.carriedDays}日${u.balance.carriedHours ? `${u.balance.carriedHours}h` : ''} ＋ 付与 ${u.balance.grantedDays}日 ＝ ${u.balance.totalDays}日　<b>残り ${esc(fmtBal(u.balance))}</b>　年5日: ${u.fiveDays}日` : `<span class="rej">未付与</span>${u.balance.planned ? `（予定 ${fmtDate(u.balance.planned.grantDate)} に ${u.balance.planned.days}日）` : ''}`}</span></span>
          <span class="ops"><button data-lvprofile="${u.id}">設定</button><button data-lvadjust="${u.id}">残数修正</button></span></li>`).join('')}</ul>
      <div id="lvEditor"></div>`;
    $('lvCsvMonth').addEventListener('change', () => { $('lvCsvBtn').href = `/api/admin/leave/export.csv?month=${$('lvCsvMonth').value}`; });
    $('lvGrantRun').addEventListener('click', async () => {
      if (!confirm(`${fy}年度の年休を、未付与の職員に付与します。よろしいですか？`)) return;
      const msg = $('lvGrantMsg'); msg.className = 'msg';
      try {
        const r = await api('/api/admin/leave/grant', { method: 'POST', body: JSON.stringify({ fy }) });
        toast(`${r.created.length}名に付与しました`);
        msg.className = 'msg ok';
        msg.innerHTML = `付与：${r.created.map((c) => `${esc(c.name)} ${c.grantedDays}日（繰越 ${c.carriedDays}日）`).join('、') || 'なし'}<br>対象外：${r.skipped.map((s) => `${esc(s.name)}（${esc(s.reason)}）`).join('、') || 'なし'}`;
        staffData.leave = await api(`/api/admin/leave/overview?fy=${fy}`);
        const keep = msg.innerHTML; staffLeave(); $('lvGrantMsg').className = 'msg ok'; $('lvGrantMsg').innerHTML = keep;
      } catch (e) { msg.textContent = e.message; }
    });
  }
  // 職員の休暇設定（入職日・週所定日数・役職）
  function staffLeaveProfile(u) {
    const d = staffData.leave;
    $('lvEditor').innerHTML = `
      <div class="form" id="lvProfileForm"><h3>${esc(u.name)} の休暇設定</h3>
        <div class="grid2">
          <div><label>入職日</label><input id="lpHire" type="date" value="${esc(u.hireDate)}"></div>
          <div><label>週所定日数</label><select id="lpWeek">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${u.weeklyDays === n ? 'selected' : ''}>${n}日${n === 5 ? '（常勤）' : ''}</option>`).join('')}</select></div>
          <div><label>役職（承認権限）</label><select id="lpRole">${Object.entries(d.roles).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <h3 style="margin-top:14px">${d.fiscalYear}年度の付与内容（手入力で上書き）</h3>
        <div class="grid2">
          <div><label>前年度繰越（日）</label><input id="lpCarryD" type="number" step="0.5" min="0" max="40" value="${u.balance.granted ? u.balance.carriedDays : 0}"></div>
          <div><label>前年度繰越（時間）</label><input id="lpCarryH" type="number" min="0" max="7" value="${u.balance.granted ? u.balance.carriedHours : 0}"></div>
          <div><label>当年度付与（日）</label><input id="lpGrant" type="number" step="0.5" min="0" max="20" value="${u.balance.granted ? u.balance.grantedDays : (u.balance.planned ? u.balance.planned.days : 0)}"></div>
          <div><label>メモ</label><input id="lpNote" value="${esc(u.balance.note || '')}" placeholder="例：前職場からの引継ぎ"></div>
        </div>
        <div class="row"><button class="btn" id="lpSave">保存する</button><button class="btn quiet" id="lpCancel">閉じる</button></div>
        <div class="msg" id="lpMsg"></div>
      </div>`;
    $('lvProfileForm').scrollIntoView({ behavior: 'smooth' });
    $('lpCancel').addEventListener('click', () => { $('lvEditor').innerHTML = ''; });
    $('lpSave').addEventListener('click', async () => {
      const msg = $('lpMsg'); msg.className = 'msg';
      try {
        await api(`/api/admin/users/${u.id}/leave-profile`, { method: 'PUT', body: JSON.stringify({ hireDate: $('lpHire').value, weeklyDays: $('lpWeek').value, role: $('lpRole').value }) });
        const g = Number($('lpGrant').value), cd = Number($('lpCarryD').value), ch = Number($('lpCarryH').value);
        if (u.balance.granted || g > 0 || cd > 0 || ch > 0) {
          await api(`/api/admin/leave/grant/${u.id}`, { method: 'PUT', body: JSON.stringify({ fy: d.fiscalYear, carriedDays: cd, carriedHours: ch, grantedDays: g, note: $('lpNote').value }) });
        }
        toast('保存しました'); staff();
      } catch (e) { msg.textContent = e.message; }
    });
  }
  // 残数の修正（履歴が残る）
  async function staffLeaveAdjust(u) {
    const d = staffData.leave;
    let detail = null;
    try { detail = await api(`/api/admin/leave/users/${u.id}?fy=${d.fiscalYear}`); } catch (_) { /* 表示のみ */ }
    $('lvEditor').innerHTML = `
      <div class="form" id="lvAdjForm"><h3>${esc(u.name)} の残数を修正する（${d.fiscalYear}年度）</h3>
        <p class="page-lead" style="margin:0">現在の残り：<b>${esc(fmtBal(u.balance))}</b>。増やすときは＋、減らすときは－で入力します。修正は履歴に残ります。</p>
        <div class="grid2">
          <div><label>日数（±）</label><input id="laDays" type="number" step="0.5" value="0"></div>
          <div><label>時間（±）</label><input id="laHours" type="number" step="1" value="0"></div>
        </div>
        <label>修正の理由（必須）</label><input id="laNote" maxlength="200" placeholder="例：紙の休暇届 9/3 分を反映">
        <div class="row"><button class="btn" id="laSave">修正を登録する</button><button class="btn quiet" id="laCancel">閉じる</button></div>
        <div class="msg" id="laMsg"></div>
        ${detail ? `
        <div class="sec-label" style="padding-left:0">修正履歴</div>
        <ul class="clist">${detail.adjustments.map((a) => `<li style="padding:8px 12px;display:block;font-size:12px">${fmtDate(a.created_at, true)}　${a.days > 0 ? '+' : ''}${a.days}日 ${a.hours > 0 ? '+' : ''}${a.hours}時間　${esc(a.note)}</li>`).join('') || '<li class="empty" style="padding:8px">なし</li>'}</ul>
        <div class="sec-label" style="padding-left:0">${d.fiscalYear}年度の申請</div>
        <ul class="clist">${detail.requests.map((r) => `<li style="padding:8px 12px;display:block;font-size:12px"><span class="tag st-${r.status}">${STATUS_LABEL[r.status]}</span> ${fmtReqDate(r)}　${esc(r.typeLabel)} ${esc(fmtReqAmount(r))}${r.reason ? `　${esc(r.reason)}` : ''}</li>`).join('') || '<li class="empty" style="padding:8px">なし</li>'}</ul>` : ''}
      </div>`;
    $('lvAdjForm').scrollIntoView({ behavior: 'smooth' });
    $('laCancel').addEventListener('click', () => { $('lvEditor').innerHTML = ''; });
    $('laSave').addEventListener('click', async () => {
      const msg = $('laMsg'); msg.className = 'msg';
      try {
        await api('/api/admin/leave/adjust', { method: 'POST', body: JSON.stringify({ userId: u.id, fy: d.fiscalYear, days: $('laDays').value, hours: $('laHours').value, note: $('laNote').value }) });
        toast('修正しました'); staff();
      } catch (e) { msg.textContent = e.message; }
    });
  }

  function staffUsers() {
    const d0 = staffData.departments[0];
    $('staffBody').innerHTML = `
      <div class="form"><h3>職員を登録する</h3>
        <p class="page-lead" style="margin:0">初期パスワードは職員番号と同じです（例：4531 → 4531）。先頭の0は付けません。本人は初回ログイン時に数字4桁のパスワードを設定します。退職時は削除すると通知も止まります。</p>
        <div class="grid2">
          <div><label>職員番号（先頭の0なし）</label><input id="uStaffId" inputmode="numeric" placeholder="173"></div>
          <div><label>部門</label><select id="uDept">${staffData.departments.map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('')}</select></div>
          <div id="uSecWrap" class="${d0 && d0.sections.length ? '' : 'hidden'}"><label>課・病棟</label><select id="uSec"></select></div>
          <div><label>氏名</label><input id="uName" placeholder="山田 花子"></div>
          <div><label>ふりがな</label><input id="uKana" placeholder="やまだ はなこ"></div>
          <div><label>職種</label><input id="uJob" placeholder="看護師"></div>
          <div><label>初期パスワード（通常は空欄＝職員番号と同じ）</label><input id="uPw" placeholder="空欄で自動設定"></div>
          <div><label>入職日（年休の付与に使用）</label><input id="uHire" type="date"></div>
          <div><label>週所定日数</label><select id="uWeek">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n}日${n === 5 ? '（常勤）' : ''}</option>`).join('')}</select></div>
          <div><label>役職</label><select id="uRole"><option value="">一般</option><option value="shunin">主任（体調報告の確認）</option><option value="kacho">課長（休暇承認・体調確認）</option><option value="bucho">部長（休暇承認・体調確認）</option></select></div>
        </div>
        <div class="row"><label class="check"><input type="checkbox" id="uAdmin">管理者にする</label><button class="btn" id="uAdd">登録する</button></div>
        <div class="msg" id="uMsg"></div>
      </div>
      <div class="form"><h3>CSVで一括登録する</h3>
        <p class="page-lead" style="margin:0 0 6px">1行目は見出し：<code>職員番号,氏名,ふりがな,部門,課・病棟,職種,役職,入職日,週所定日数,管理者</code>。氏名・ふりがなのカタカナは自動でひらがなになり、職員番号の先頭の0は取り除かれます。役職は「部長／副部長／施設長」「課長／副課長」「主任」の語で判定。既存の職員番号は内容を更新します（パスワードは変わりません）。</p>
        <input id="uCsvFile" type="file" accept=".csv,text/csv">
        <label>またはここに貼り付け（Excelからコピーした表でも可）</label>
        <textarea id="uCsv" style="min-height:120px;font-family:monospace;font-size:12px" placeholder="職員番号,氏名,ふりがな,部門,課・病棟,職種,役職,入職日,週所定日数,管理者&#10;173,まもる,まもる,事務部,,事務,,,5,"></textarea>
        <div class="row"><button class="btn" id="uImport">一括登録する</button></div>
        <div class="msg" id="uImportMsg" style="white-space:pre-wrap"></div>
      </div>
      <div class="sec-label">登録職員（${staffData.users.length}名）</div>
      <ul class="alist">${staffData.users.map((u) => `<li><span><span class="t">${esc(u.staffId)}　${esc(u.name)}</span>${u.isAdmin ? ' <span class="tag general">管理者</span>' : ''}${u.role ? ` <span class="tag department">${{ bucho: '部長', kacho: '課長', shunin: '主任' }[u.role] || u.role}</span>` : ''}<br><span class="m">${esc(u.department)}${u.section ? ` ${esc(u.section)}` : ''}　${esc(u.job)}　入職 ${u.hireDate ? fmtDate(u.hireDate) : '未設定'}　通知端末 ${u.devices}${u.mustChangePassword ? '　<span class="rej">初期PWのまま</span>' : ''}</span></span>
        <span class="ops"><button data-reset-pw="${u.id}" data-name="${esc(u.name)}">PW初期化</button>${u.id !== state.user.id ? `<button class="del" data-del-user="${u.id}" data-name="${esc(u.name)}">削除</button>` : ''}</span></li>`).join('')}</ul>`;
    const syncSec = () => {
      const d = staffData.departments.find((x) => x.name === $('uDept').value);
      $('uSecWrap').classList.toggle('hidden', !d || !d.sections.length);
      $('uSec').innerHTML = (d ? d.sections : []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    };
    $('uDept').addEventListener('change', syncSec); syncSec();
    $('uCsvFile').addEventListener('change', async () => {
      const f = $('uCsvFile').files[0]; if (!f) return;
      const buf = new Uint8Array(await f.arrayBuffer());
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { text = new TextDecoder('shift_jis').decode(buf); } // Excel保存のCSV（Shift_JIS）にも対応
      $('uCsv').value = text;
    });
    $('uImport').addEventListener('click', async () => {
      const msg = $('uImportMsg'); msg.className = 'msg';
      const csv = $('uCsv').value.trim();
      if (!csv) { msg.textContent = 'CSVを選択するか貼り付けてください'; return; }
      if (!confirm('CSVの内容で職員を一括登録・更新します。よろしいですか？')) return;
      $('uImport').disabled = true;
      try {
        const r = await api('/api/admin/users/import', { method: 'POST', body: JSON.stringify({ csv }) });
        msg.className = r.errors.length ? 'msg' : 'msg ok';
        msg.textContent = `新規 ${r.created.length}名、更新 ${r.updated.length}名${r.errors.length ? `、エラー ${r.errors.length}件\n${r.errors.join('\n')}` : ''}\n初期パスワードは職員番号と同じです。`;
        staffData.users = (await api('/api/admin/users')).users;
        const keep = msg.textContent, cls = msg.className; staffUsers(); $('uImportMsg').textContent = keep; $('uImportMsg').className = cls;
      } catch (e) { msg.textContent = e.message; } finally { if ($('uImport')) $('uImport').disabled = false; }
    });
    $('uAdd').addEventListener('click', async () => {
      const msg = $('uMsg'); msg.className = 'msg';
      try {
        await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ staffId: $('uStaffId').value, name: $('uName').value, kana: $('uKana').value, department: $('uDept').value, section: $('uSec').value, job: $('uJob').value, password: $('uPw').value, isAdmin: $('uAdmin').checked, hireDate: $('uHire').value, weeklyDays: $('uWeek').value, role: $('uRole').value }) });
        toast('登録しました'); staff();
      } catch (e) { msg.textContent = e.message; }
    });
  }

  // ---- クリック処理（イベント委譲） ---------------------------------------------
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('a[href^="/?view="]');
    if (a) { const v = new URL(a.href).searchParams.get('view'); if (INTERNAL_VIEWS.includes(v)) { e.preventDefault(); render(v); return; } }
    const el = e.target.closest('[data-go],[data-notice],[data-content],[data-filter],[data-todo],[data-tab],[data-stab],[data-del-notice],[data-del-content],[data-edit-content],[data-pickup],[data-del-user],[data-reset-pw],[data-lvfy],[data-lvfilter],[data-lvcancel],[data-lvapprove],[data-lvreject],[data-slvfy],[data-lvprofile],[data-lvadjust],[data-hday],[data-hconfirm],[data-emopen],[data-emremind],[data-emclose],[data-emrefresh],[data-dpsel],[data-dpback],[data-dpdel],[data-chat],[data-direct],[data-gremove],[data-gleave],[data-scym],[data-scday],[data-sctoggle],[data-scedit],[data-scpick],[data-scdel],[data-ev],[data-sgedit],[data-sgdel],[data-sgleave],[data-trcat],[data-trdone],[data-trstatus],[data-trdel],[data-trledit],[data-trltoggle],[data-trldel],[data-svres],[data-svstatus],[data-svdel]');
    if (!el) return;
    const d = el.dataset;
    if (d.tab) { if (d.tab === 'dept') state.deptName = null; render(d.tab); return; }
    // 研修
    if (d.trcat) { state.trainingCat = d.trcat; render('training'); return; }
    if (d.trledit) { const l = (state.trLinks || []).find((x) => x.id === Number(d.trledit)); if (l && state.trlFill) { $('trLinkEditor').open = true; state.trlFill(l); $('trLinkForm').scrollIntoView({ behavior: 'smooth' }); } return; }
    if (d.trltoggle) { try { await api(`/api/training/links/${d.trltoggle}`, { method: 'PUT', body: JSON.stringify({ active: d.active === '1' }) }); render('training'); } catch (err) { toast(err.message); } return; }
    if (d.trldel) { if (!confirm(`「${d.name}」を削除しますか？`)) return; try { await api(`/api/training/links/${d.trldel}`, { method: 'DELETE' }); toast('削除しました'); render('training'); } catch (err) { toast(err.message); } return; }
    if (d.trdone) { try { await api(`/api/training/${d.trdone}/done`, { method: 'POST', body: JSON.stringify({ undo: !!d.undo }) }); toast(d.undo ? '受講記録を取り消しました' : '受講を記録しました'); render('training'); } catch (err) { toast(err.message); } return; }
    if (d.trstatus) {
      try {
        const r = await api(`/api/training/${d.trstatus}/status`);
        $('trStatus').innerHTML = `<div class="form"><h3>「${esc(r.item.title)}」の受講状況　${r.done.length} / ${r.total} 名</h3>
          <div class="sec-label" style="padding-left:0">未受講（${r.notDone.length}名）</div><p style="font-size:13px;margin:0">${r.notDone.map((u) => `${esc(u.name)}（${esc(u.department)}${u.section ? ' ' + esc(u.section) : ''}）`).join('、') || 'なし'}</p>
          <div class="sec-label" style="padding-left:0">受講済み（${r.done.length}名）</div><p style="font-size:13px;margin:0">${r.done.map((u) => `${esc(u.name)} ${fmtDate(u.done_at)}`).join('、') || 'なし'}</p></div>`;
        $('trStatus').scrollIntoView({ behavior: 'smooth' });
      } catch (err) { toast(err.message); }
      return;
    }
    if (d.trdel) { if (!confirm(`「${d.name}」を削除しますか？ 受講記録も消えます。`)) return; try { await api(`/api/training/${d.trdel}`, { method: 'DELETE' }); toast('削除しました'); render('training'); } catch (err) { toast(err.message); } return; }
    // アンケート
    if (d.go === 'survey' && d.survey) { render('survey', { id: Number(d.survey) }); return; }
    if (d.svres) { render('surveyResults', { id: Number(d.svres) }); return; }
    if (d.svstatus) { try { await api(`/api/surveys/${d.svstatus}/status`, { method: 'POST', body: JSON.stringify({ status: d.to }) }); toast(d.to === 'open' ? '再開しました' : '締め切りました'); render('surveyResults', { id: Number(d.svstatus) }); } catch (err) { toast(err.message); } return; }
    if (d.svdel) { if (!confirm('このアンケートを削除しますか？ 回答もすべて消えます。')) return; try { await api(`/api/surveys/${d.svdel}`, { method: 'DELETE' }); toast('削除しました'); render('surveys'); } catch (err) { toast(err.message); } return; }
    // スケジュール
    if (d.scym) { sched.ym = d.scym; sched.showForm = false; sched.editing = null; render('schedule'); return; }
    if (d.ev && !d.scday) { // カレンダー内の予定チップ → その日を選択
      const ev = sched.events.find((x) => x.id === Number(d.ev));
      const cell = el.closest('.sc-cell');
      if (sched.pick && cell) { await moveOrCopy(sched.pick.id, cell.dataset.scday, sched.pick.mode); return; }
      if (cell) { sched.day = cell.dataset.scday; sched.showForm = false; sched.editing = null; render('schedule'); }
      return;
    }
    if (d.scday) {
      if (sched.pick) { await moveOrCopy(sched.pick.id, d.scday, sched.pick.mode); return; }
      sched.day = d.scday; sched.ym = d.scday.slice(0, 7); sched.showForm = false; sched.editing = null; render('schedule'); return;
    }
    if (d.sctoggle !== undefined) { if (sched.hidden.has(d.sctoggle)) sched.hidden.delete(d.sctoggle); else sched.hidden.add(d.sctoggle); render('schedule'); return; }
    if (d.scedit) { sched.editing = sched.events.find((x) => x.id === Number(d.scedit)) || null; sched.showForm = false; render('schedule'); window.scrollTo(0, document.body.scrollHeight); return; }
    if (d.scpick) { const ev = sched.events.find((x) => x.id === Number(d.id)); if (ev) { sched.pick = { id: ev.id, mode: d.scpick, title: ev.title }; render('schedule'); window.scrollTo(0, 0); } return; }
    if (d.scdel) { if (!confirm('この予定を削除しますか？')) return; try { await api(`/api/sched/events/${d.scdel}`, { method: 'DELETE' }); toast('削除しました'); render('schedule'); } catch (err) { toast(err.message); } return; }
    if (d.sgedit) { sched.groupEditing = Number(d.sgedit); render('schedGroups'); return; }
    if (d.sgdel) { if (!confirm(`グループ「${d.name}」を削除しますか？ 登録した予定もすべて消えます。`)) return; try { await api(`/api/sched/groups/${d.sgdel}`, { method: 'DELETE' }); toast('削除しました'); render('schedGroups'); } catch (err) { toast(err.message); } return; }
    if (d.sgleave) { if (!confirm('このグループから退出しますか？')) return; try { await api(`/api/sched/groups/${d.sgleave}/leave`, { method: 'POST' }); toast('退出しました'); render('schedGroups'); } catch (err) { toast(err.message); } return; }
    // メッセージ
    if (d.chat) { render('chat', { id: Number(d.chat) }); return; }
    if (d.direct) { try { const r = await api('/api/msg/conversations', { method: 'POST', body: JSON.stringify({ type: 'direct', userId: Number(d.direct) }) }); render('chat', { id: r.conversation.id }); } catch (err) { toast(err.message); } return; }
    if (d.gremove) { if (!confirm('このメンバーをグループから外しますか？')) return; try { await api(`/api/msg/conversations/${state.chatId}`, { method: 'PUT', body: JSON.stringify({ removeIds: [Number(d.gremove)] }) }); render('chat', { id: state.chatId }); } catch (err) { toast(err.message); } return; }
    if (d.gleave) { if (!confirm('このグループから退出しますか？')) return; try { await api(`/api/msg/conversations/${d.gleave}/leave`, { method: 'POST' }); render('messages'); } catch (err) { toast(err.message); } return; }
    if (d.go === 'newChat') { render('newChat', { mode: d.mode }); return; }
    // 部署ページ
    if (d.dpsel) { state.deptName = d.dpsel; render('dept'); return; }
    if (d.dpback) { state.deptName = null; render('dept'); return; }
    if (d.dpdel) {
      if (!confirm(`「${d.name}」を削除しますか？`)) return;
      try { await api(`/api/dept/files/${d.dpdel}`, { method: 'DELETE' }); toast('削除しました'); render('dept'); } catch (err) { toast(err.message); }
      return;
    }
    if (d.go) { if (d.alert) { state.alertId = Number(d.alert); state.alertsFocus = Number(d.alert); } render(d.go, d.alert ? { id: Number(d.alert) } : {}); return; }
    // 緊急連絡（送信者）
    if (d.emopen || d.emrefresh) { state.alertsFocus = Number(d.emopen || d.emrefresh); render('alerts', { id: state.alertsFocus }); return; }
    if (d.emremind) {
      if (!confirm('未回答者にもう一度通知を送ります。よろしいですか？')) return;
      try { const r = await api(`/api/alerts/${d.emremind}/remind`, { method: 'POST' }); toast(`再通知しました（未回答 ${r.unanswered}名、通知 ${r.push.sent} 端末）`); render('alerts', { id: Number(d.emremind) }); } catch (err) { toast(err.message); }
      return;
    }
    if (d.emclose) {
      if (!d.reopen && !confirm('この連絡を締め切ります。以後は回答できなくなります。よろしいですか？')) return;
      try { await api(`/api/alerts/${d.emclose}/close`, { method: 'POST', body: JSON.stringify({ reopen: !!d.reopen }) }); toast(d.reopen ? '締切を解除しました' : '締め切りました'); render('alerts', { id: Number(d.emclose) }); } catch (err) { toast(err.message); }
      return;
    }
    // 体調報告
    if (d.hday) { state.healthDay = d.hday; render('health'); return; }
    if (d.hconfirm) {
      try { await api(`/api/health/${d.hconfirm}/confirm`, { method: 'POST', body: JSON.stringify({ undo: !!d.undo }) }); toast(d.undo ? '確認を取り消しました' : '確認済みにしました'); render('health'); }
      catch (err) { toast(err.message); }
      return;
    }
    // 休暇
    if (d.lvfy) { state.leaveFy = Number(d.lvfy); render('leave'); return; }
    if (d.lvfilter) { state.leaveFilter = d.lvfilter; render('leave'); return; }
    if (d.lvcancel) {
      let reason = '';
      if (d.approved) { reason = prompt('取消の理由を入力してください（課長に通知され、承認されると取消が確定します）'); if (!reason || !reason.trim()) return; }
      else if (!confirm('この申請を取り消しますか？')) return;
      try {
        const r = await api(`/api/leave/requests/${d.lvcancel}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
        toast(r.immediate ? '取り消しました' : `取消を申請しました（${r.approvers.join('・')} に通知）`); render('leave');
      } catch (err) { toast(err.message); }
      return;
    }
    if (d.lvapprove || d.lvreject) {
      const id = d.lvapprove || d.lvreject;
      const isCancel = !!d.cancel;
      let reason = '';
      if (d.lvreject) { reason = prompt(isCancel ? '取消を却下する理由を入力してください（本人に通知され、休暇は有効のままになります）' : '差戻しの理由を入力してください（本人に通知されます）'); if (!reason || !reason.trim()) return; }
      else if (!confirm(isCancel ? 'この休暇の取消を承認しますか？（残数が戻ります）' : 'この申請を承認しますか？')) return;
      try {
        await api(`/api/leave/approvals/${id}`, { method: 'POST', body: JSON.stringify({ action: (d.lvapprove ? 'approve' : 'reject') + (isCancel ? '_cancel' : ''), reason }) });
        toast(d.lvapprove ? (isCancel ? '取消を承認しました' : '承認しました') : (isCancel ? '取消を却下しました' : '差し戻しました'));
        if (d.admin) staff(); else render('approve');
      } catch (err) { toast(err.message); }
      return;
    }
    if (d.slvfy) { staffData.leaveFy = Number(d.slvfy); staff(); return; }
    if (d.lvprofile) { const u = staffData.leave.users.find((x) => x.id === Number(d.lvprofile)); if (u) staffLeaveProfile(u); return; }
    if (d.lvadjust) { const u = staffData.leave.users.find((x) => x.id === Number(d.lvadjust)); if (u) staffLeaveAdjust(u); return; }
    if (d.filter) { state.filter = d.filter; render('notices'); return; }
    if (d.notice) {
      const n = state.notices.find((x) => x.id === Number(d.notice));
      if (n) { state.prevView = state.view === 'detail' ? 'notices' : state.view; render('detail', { notice: n }); }
      return;
    }
    if (d.content) {
      const c = state.contents.find((x) => x.id === Number(d.content));
      if (c) { state.prevView = state.view === 'detail' ? c.tab : state.view; render('detail', { content: c }); }
      return;
    }
    if (d.todo !== undefined) { e.preventDefault(); toast(`${d.todo}は次の段階で設定します`); return; }
    // 管理モード
    if (d.stab) { state.staffTab = d.stab; state.editing = null; staff(); return; }
    if (d.delNotice) { if (confirm('このお知らせを削除しますか？')) { await api(`/api/admin/notices/${d.delNotice}`, { method: 'DELETE' }); staff(); } return; }
    if (d.delContent) { if (confirm('この記事を削除しますか？')) { await api(`/api/admin/contents/${d.delContent}`, { method: 'DELETE' }); staff(); } return; }
    if (d.editContent) { const c = staffData.contents.find((x) => x.id === Number(d.editContent)); if (c) { state.editing = { ...c, sortOrder: c.sort_order, published: !!c.published }; staff(); window.scrollTo(0, 0); } return; }
    if (d.pickup) { const id = Number(d.pickup); await api('/api/admin/pickup', { method: 'POST', body: JSON.stringify({ contentId: staffData.pickupId === id ? 0 : id }) }); toast('ピックアップを更新しました'); staff(); return; }
    if (d.resetPw) { if (confirm(`${d.name} のパスワードを初期化（職員番号と同じ）しますか？ 本人は次回ログイン時に変更が必要になります。`)) { try { const r = await api(`/api/admin/users/${d.resetPw}/reset-password`, { method: 'POST' }); alert(`初期化しました。\n初期パスワード：${r.initialPassword}\n本人にお伝えください。`); staff(); } catch (err) { toast(err.message); } } return; }
    if (d.delUser) { if (confirm(`${d.name} を削除しますか？ 通知も止まります。`)) { await api(`/api/admin/users/${d.delUser}`, { method: 'DELETE' }); staff(); } }
  });
  $('bellBtn').addEventListener('click', () => render('notices'));
  $('meBtn').addEventListener('click', () => render('mypage'));
  $('brandBtn').addEventListener('click', () => render('home'));

  // 画面に戻ってきたら必ず最新を取り直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && state.view !== 'forcePassword') { refresh(); if (state.registration) state.registration.update(); }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted && state.user) refresh(); });

  async function refresh() {
    try {
      const [me, n, c] = await Promise.all([api('/api/me'), api('/api/notices'), api('/api/contents')]);
      state.user = me.user; state.status = me.status; state.rules = me.rules;
      state.notices = n.notices; state.contents = c.contents; state.pickupId = c.pickupId;
      updateBadge();
      if (['home', 'notices', 'learn', 'tools', 'leave', 'approve', 'health', 'messages'].includes(state.view)) render(state.view);
    } catch (_) { /* 圏外などは前回表示のまま */ }
  }

  // ---- Service Worker -------------------------------------------------------
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    state.registration = reg;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!refreshing) { refreshing = true; location.reload(); } });
  }

  // ---- 起動 -------------------------------------------------------------------
  async function boot() {
    const me = await api('/api/me');
    state.user = me.user; state.status = me.status; state.rules = me.rules;
    if (!me.user) { render('login'); return; }
    if (me.user.mustChangePassword) { state.view = 'forcePassword'; forcePassword(); return; }
    const [n, c] = await Promise.all([api('/api/notices'), api('/api/contents')]);
    state.notices = n.notices; state.contents = c.contents; state.pickupId = c.pickupId;
    const params = new URLSearchParams(location.search);
    const openId = Number(params.get('notice') || 0);
    const openView = params.get('view');
    const openAlert = Number(params.get('alert') || 0);
    if (state.staffMode && isAdmin()) { render('staff'); return; }
    if (openAlert) { history.replaceState(null, '', '/'); state.alertId = openAlert; render('alert', { id: openAlert }); return; }
    const openChat = Number(params.get('chat') || 0);
    if (openChat) { history.replaceState(null, '', '/'); render('chat', { id: openChat }); return; }
    const openSurvey = Number(params.get('survey') || 0);
    if (openSurvey) { history.replaceState(null, '', '/'); render('survey', { id: openSurvey }); return; }
    if (openView === 'schedule') { const dt = params.get('date'); history.replaceState(null, '', '/'); render('schedule', /^\d{4}-\d{2}-\d{2}$/.test(dt || '') ? { date: dt } : {}); return; }
    if (['leave', 'approve', 'health', 'healthReport', 'messages', 'dept', 'training', 'surveys', 'alerts', 'schedGroups'].includes(openView)) { history.replaceState(null, '', '/'); render(openView); return; }
    if (openId) {
      history.replaceState(null, '', '/');
      const found = n.notices.find((x) => x.id === openId);
      state.prevView = 'home';
      if (found) { render('detail', { notice: found }); return; }
    }
    render('home');
  }
  registerSW().finally(() => boot().catch(() => render('login')));
})();
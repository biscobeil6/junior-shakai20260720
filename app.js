'use strict';

const STORAGE_KEY = 'social.simpleProgress.v1';
const SETTINGS_KEY = 'social.simpleSettings.v1';

const state = {
  data: [],
  bySubject: new Map(),
  progress: loadJSON(STORAGE_KEY, { results: {}, cycles: {} }),
  settings: loadJSON(SETTINGS_KEY, { sessionSize: 20 }),
  rewards: { interval: 10, images: [] },
  rewardDeck: [],
  lastRewardId: null,
  session: null,
  selectedSubject: null,
  selectedSubtag: null,
  issues: []
};

const main = document.getElementById('main');
const headerTitle = document.getElementById('headerTitle');
const headerSub = document.getElementById('headerSub');
document.getElementById('homeBtn').addEventListener('click', renderHome);
document.getElementById('statsBtn').addEventListener('click', renderStats);
document.getElementById('rewardContinue').addEventListener('click', closeRewardAndContinue);

init().catch(err => {
  console.error(err);
  state.issues.push(`起動エラー: ${err.message}`);
  renderHome();
});

async function init() {
  await Promise.all([loadQuestions(), loadRewards()]);
  renderHome();
}

async function loadQuestions() {
  const res = await fetch('social_questions.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`問題データを読み込めません（HTTP ${res.status}）`);
  const raw = await res.json();
  if (!raw || !Array.isArray(raw.questions)) throw new Error('questions配列がありません');

  const seen = new Set();
  for (const [index, q] of raw.questions.entries()) {
    const prefix = `${index + 1}番目`;
    if (!q || !q.id || !q.subject || !q.subtag || !q.question || !Array.isArray(q.choices)) {
      state.issues.push(`${prefix}: 必須項目不足`); continue;
    }
    if (seen.has(q.id)) { state.issues.push(`${prefix}: ID重複 ${q.id}`); continue; }
    seen.add(q.id);
    if (q.choices.length < 2 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
      state.issues.push(`${prefix}: 選択肢または正解番号が不正`); continue;
    }
    const normalized = { ...q, answerText: q.choices[q.answer] };
    state.data.push(normalized);
    if (!state.bySubject.has(q.subject)) state.bySubject.set(q.subject, new Map());
    const subMap = state.bySubject.get(q.subject);
    if (!subMap.has(q.subtag)) subMap.set(q.subtag, []);
    subMap.get(q.subtag).push(normalized);
  }
}

async function loadRewards() {
  try {
    const res = await fetch('rewards.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.rewards.interval = Number.isInteger(data.interval) && data.interval > 0 ? data.interval : 10;
    state.rewards.images = Array.isArray(data.images) ? data.images.filter(x => x && x.id && x.file) : [];
  } catch (e) {
    state.issues.push(`rewards.json: ${e.message}`);
  }
}

function renderHome() {
  state.session = null;
  state.selectedSubject = null;
  state.selectedSubtag = null;
  setHeader('受験暗記アプリ', '社会・周回学習');
  main.innerHTML = `
    <section class="hero">
      <div class="settings-row">1回に解く問題数
        <div class="segmented" id="sizeSelector">
          ${[10,20,50].map(n => `<button data-size="${n}" class="${state.settings.sessionSize===n?'active':''}">${n}</button>`).join('')}
        </div>
      </div>
    </section>
    <section class="subject-group">
      <h2>分野を選んでください</h2>
      <div class="tile-grid">
        ${[...state.bySubject.entries()].map(([subject, subMap]) => `
          <article class="unit-tile" data-subject="${escapeAttr(subject)}">
            <h3>${escapeHTML(subject)}</h3>
            <p>${[...subMap.values()].reduce((a,b)=>a+b.length,0)}問</p>
            <p>${subMap.size}単元</p>
          </article>`).join('')}
      </div>
    </section>
    ${state.issues.length ? `<section class="panel"><h2>データ確認</h2>${state.issues.map(x=>`<div class="issue">${escapeHTML(x)}</div>`).join('')}</section>` : ''}
  `;
  document.querySelectorAll('#sizeSelector button').forEach(btn => btn.addEventListener('click', () => {
    state.settings.sessionSize = Number(btn.dataset.size);
    saveJSON(SETTINGS_KEY, state.settings);
    renderHome();
  }));
  document.querySelectorAll('[data-subject]').forEach(el => el.addEventListener('click', () => renderSubtags(el.dataset.subject)));
}

function renderSubtags(subject) {
  state.selectedSubject = subject;
  const subMap = state.bySubject.get(subject);
  setHeader(subject, '単元を選んでください');
  const allLabel = subject === '歴史' ? '全時代' : subject === '地理' ? '全単元' : '全分野';
  main.innerHTML = `<section class="subject-group">
    <div class="tile-grid">
      <article class="unit-tile featured" data-subtag="__ALL__">
        <h3>${allLabel}</h3><p>${scopeQuestions(subject, '__ALL__').length}問</p><p>すべて混ぜて出題</p>
      </article>
      ${[...subMap.entries()].map(([subtag, items]) => `
        <article class="unit-tile" data-subtag="${escapeAttr(subtag)}">
          <h3>${escapeHTML(subtag)}</h3><p>${items.length}問</p>
          <p>${cycleSummary(subject, subtag)}</p>
        </article>`).join('')}
    </div>
    <div class="button-row"><button class="secondary-btn" id="backHome">戻る</button></div>
  </section>`;
  document.querySelectorAll('[data-subtag]').forEach(el => el.addEventListener('click', () => renderModes(subject, el.dataset.subtag)));
  document.getElementById('backHome').onclick = renderHome;
}

function renderModes(subject, subtag) {
  state.selectedSubject = subject;
  state.selectedSubtag = subtag;
  const label = scopeLabel(subject, subtag);
  const questions = scopeQuestions(subject, subtag);
  const wrong = questions.filter(q => state.progress.results[q.id]?.lastCorrect === false);
  const cycle = getCycle(subject, subtag);
  const done = cycle.doneIds.filter(id => questions.some(q => q.id === id)).length;
  setHeader(label, subject);
  main.innerHTML = `<section class="panel">
    <h2>学習モードを選んでください</h2>
    <div class="mode-grid">
      <button class="mode-card" id="cycleMode">
        <strong>周回モード</strong>
        <span>一周するまで同じ問題は出ません</span>
        <small>${done}/${questions.length}問 消化済み</small>
      </button>
      <button class="mode-card" id="wrongMode" ${wrong.length ? '' : 'disabled'}>
        <strong>間違い見直し</strong>
        <span>直近の回答が不正解の問題だけ</span>
        <small>${wrong.length}問</small>
      </button>
    </div>
    <div class="button-row">
      <button class="secondary-btn" id="backUnits">戻る</button>
      ${done > 0 ? '<button class="danger-outline-btn" id="resetCycle">この周回を最初から</button>' : ''}
    </div>
  </section>`;
  document.getElementById('cycleMode').onclick = () => startCycle(subject, subtag);
  document.getElementById('wrongMode').onclick = () => startWrongReview(subject, subtag);
  document.getElementById('backUnits').onclick = () => renderSubtags(subject);
  const reset = document.getElementById('resetCycle');
  if (reset) reset.onclick = () => {
    if (!confirm(`${label}の現在の周回記録を消して、最初から始めますか？`)) return;
    state.progress.cycles[scopeKey(subject, subtag)] = { doneIds: [], round: cycle.round || 1 };
    saveProgress();
    renderModes(subject, subtag);
  };
}

function startCycle(subject, subtag) {
  const questions = scopeQuestions(subject, subtag);
  const cycle = getCycle(subject, subtag);
  const validIds = new Set(questions.map(q => q.id));
  cycle.doneIds = cycle.doneIds.filter(id => validIds.has(id));
  let remaining = questions.filter(q => !cycle.doneIds.includes(q.id));
  if (!remaining.length) {
    const nextRound = (cycle.round || 1) + 1;
    if (!confirm(`1周完了しています。第${nextRound}周を始めますか？`)) return;
    cycle.doneIds = [];
    cycle.round = nextRound;
    remaining = [...questions];
  }
  saveProgress();
  beginSession(shuffle(remaining).slice(0, state.settings.sessionSize), {
    subject, subtag, mode: 'cycle', title: `${scopeLabel(subject, subtag)}・第${cycle.round || 1}周`
  });
}

function startWrongReview(subject, subtag) {
  const wrong = scopeQuestions(subject, subtag).filter(q => state.progress.results[q.id]?.lastCorrect === false);
  if (!wrong.length) { toast('見直す問題はありません'); return; }
  beginSession(shuffle(wrong).slice(0, state.settings.sessionSize), {
    subject, subtag, mode: 'wrong', title: `${scopeLabel(subject, subtag)}・間違い見直し`
  });
}

function beginSession(questions, meta) {
  if (!questions.length) { toast('出題できる問題がありません'); return; }
  state.rewardDeck = [];
  state.session = { questions, ...meta, index: 0, answered: 0, correct: 0, pendingNext: false };
  renderQuestion();
}

function renderQuestion() {
  const s = state.session;
  if (!s || s.index >= s.questions.length) return renderResult();
  const q = s.questions[s.index];
  setHeader(s.title, `${s.index + 1}/${s.questions.length}`);
  const order = shuffle(q.choices.map((text, originalIndex) => ({ text, originalIndex })));
  main.innerHTML = `<section class="panel">
    <div class="quiz-top">
      <div class="progress-track"><span style="width:${Math.round((s.index/s.questions.length)*100)}%"></span></div>
      <span class="muted">正解 ${s.correct}</span>
    </div>
    <div class="question">${escapeHTML(q.question)}</div>
    <div class="choice-list">
      ${order.map((c, i) => `<button class="choice-btn" data-index="${c.originalIndex}"><span class="choice-mark">${i+1}</span><span>${escapeHTML(c.text)}</span></button>`).join('')}
    </div>
    <div id="feedback" class="choice-feedback"></div>
  </section>`;
  document.querySelectorAll('.choice-btn').forEach(btn => btn.addEventListener('click', () => answerQuestion(q, Number(btn.dataset.index), btn)));
}

function answerQuestion(q, selectedIndex, selectedButton) {
  const s = state.session;
  if (s.pendingNext) return;
  s.pendingNext = true;
  const correct = selectedIndex === q.answer;
  s.answered++;
  if (correct) s.correct++;

  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    const idx = Number(btn.dataset.index);
    const mark = btn.querySelector('.choice-mark');
    if (idx === q.answer) {
      btn.classList.add('correct');
      mark.textContent = '○';
    } else if (btn === selectedButton) {
      btn.classList.add('incorrect');
      mark.textContent = '×';
    }
  });
  const feedback = document.getElementById('feedback');
  feedback.innerHTML = correct
    ? `<span class="feedback-ok">○ 正解！</span>`
    : `<span class="feedback-bad">× 不正解</span><span class="feedback-answer">正解：${escapeHTML(q.answerText)}</span>`;

  const prev = state.progress.results[q.id] || { attempts: 0, correctCount: 0 };
  state.progress.results[q.id] = {
    attempts: prev.attempts + 1,
    correctCount: prev.correctCount + (correct ? 1 : 0),
    lastCorrect: correct,
    lastAnsweredAt: new Date().toISOString()
  };
  if (s.mode === 'cycle') {
    const cycle = getCycle(s.subject, s.subtag);
    if (!cycle.doneIds.includes(q.id)) cycle.doneIds.push(q.id);
  }
  saveProgress();

  const shouldReward = s.answered % state.rewards.interval === 0 && state.rewards.images.length;
  setTimeout(() => {
    if (shouldReward) showReward();
    else nextQuestion();
  }, correct ? 900 : 1500);
}

function nextQuestion() {
  if (!state.session) return;
  state.session.index++;
  state.session.pendingNext = false;
  renderQuestion();
}

function renderResult() {
  const s = state.session;
  if (!s) return renderHome();
  const wrongNow = scopeQuestions(s.subject, s.subtag).filter(q => state.progress.results[q.id]?.lastCorrect === false).length;
  const cycle = getCycle(s.subject, s.subtag);
  const total = scopeQuestions(s.subject, s.subtag).length;
  const done = cycle.doneIds.filter(id => scopeQuestions(s.subject, s.subtag).some(q => q.id === id)).length;
  setHeader('今回の結果', s.title);
  main.innerHTML = `<section class="panel result-panel">
    <div class="result-score">${s.correct} / ${s.questions.length}</div>
    <p>正答率 ${Math.round((s.correct/s.questions.length)*100)}%</p>
    ${s.mode === 'cycle' ? `<p>現在の周回：${done}/${total}問</p>` : `<p>残っている間違い：${wrongNow}問</p>`}
    <div class="button-row">
      <button class="primary-btn" id="continueMode">同じモードを続ける</button>
      <button class="secondary-btn" id="backModes">モード選択へ</button>
    </div>
  </section>`;
  document.getElementById('continueMode').onclick = () => s.mode === 'cycle' ? startCycle(s.subject, s.subtag) : startWrongReview(s.subject, s.subtag);
  document.getElementById('backModes').onclick = () => renderModes(s.subject, s.subtag);
}

function renderStats() {
  setHeader('成績', '端末内に保存されています');
  const answered = Object.values(state.progress.results);
  const attempts = answered.reduce((a,x)=>a+(x.attempts||0),0);
  const correct = answered.reduce((a,x)=>a+(x.correctCount||0),0);
  const wrong = Object.values(state.progress.results).filter(x=>x.lastCorrect===false).length;
  main.innerHTML = `<section class="stats-grid">
    <section class="panel">
      <h2>全体</h2>
      <p>回答回数：${attempts}</p>
      <p>正解回数：${correct}</p>
      <p>現在の間違い：${wrong}問</p>
      <p>通算正答率：${attempts ? Math.round(correct/attempts*100) : 0}%</p>
    </section>
    <section class="panel">
      <h2>成績リセット</h2>
      <p class="muted">回答履歴・間違い記録・周回状況をすべて消します。問題や画像は消えません。</p>
      <button class="danger-btn" id="resetAll">成績をリセット</button>
    </section>
  </section>`;
  document.getElementById('resetAll').onclick = () => {
    if (!confirm('成績と周回状況をすべて消します。よろしいですか？')) return;
    const word = prompt('確認のため「リセット」と入力してください');
    if (word !== 'リセット') { toast('リセットを中止しました'); return; }
    state.progress = { results: {}, cycles: {} };
    saveProgress();
    renderStats();
    toast('成績をリセットしました');
  };
}

function showReward() {
  const image = drawReward();
  if (!image) return nextQuestion();
  const modal = document.getElementById('rewardModal');
  const img = document.getElementById('rewardImage');
  const blur = document.getElementById('rewardBlur');
  img.src = image.file;
  blur.style.backgroundImage = `url("${image.file}")`;
  document.getElementById('rewardCaption').textContent = image.caption || 'よくできました！';
  modal.classList.remove('hidden');
}

function closeRewardAndContinue() {
  document.getElementById('rewardModal').classList.add('hidden');
  nextQuestion();
}

function drawReward() {
  const images = state.rewards.images;
  if (!images.length) return null;
  if (!state.rewardDeck.length) {
    state.rewardDeck = shuffle(images.map(x => x.id));
    if (state.lastRewardId && state.rewardDeck.length > 1 && state.rewardDeck[0] === state.lastRewardId) {
      [state.rewardDeck[0], state.rewardDeck[1]] = [state.rewardDeck[1], state.rewardDeck[0]];
    }
  }
  const id = state.rewardDeck.shift();
  state.lastRewardId = id;
  return images.find(x => x.id === id);
}

function scopeQuestions(subject, subtag) {
  const subMap = state.bySubject.get(subject);
  if (!subMap) return [];
  if (subtag === '__ALL__') return [...subMap.values()].flat();
  return subMap.get(subtag) || [];
}
function scopeKey(subject, subtag) { return `${subject}::${subtag}`; }
function getCycle(subject, subtag) {
  const key = scopeKey(subject, subtag);
  if (!state.progress.cycles[key]) state.progress.cycles[key] = { doneIds: [], round: 1 };
  return state.progress.cycles[key];
}
function cycleSummary(subject, subtag) {
  const total = scopeQuestions(subject, subtag).length;
  const done = getCycle(subject, subtag).doneIds.filter(id => scopeQuestions(subject, subtag).some(q=>q.id===id)).length;
  return `周回 ${done}/${total}問`;
}
function scopeLabel(subject, subtag) {
  if (subtag !== '__ALL__') return subtag;
  return subject === '歴史' ? '全時代' : subject === '地理' ? '全単元' : '全分野';
}
function saveProgress() { saveJSON(STORAGE_KEY, state.progress); }
function setHeader(title, sub) { headerTitle.textContent = title; headerSub.textContent = sub; }
function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function shuffle(arr) { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function escapeHTML(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function escapeAttr(v='') { return escapeHTML(v); }

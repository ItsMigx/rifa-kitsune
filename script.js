/* ============================================================
   script.js
   Lógica PÚBLICA da rifa: grade de números, carrinho, reserva,
   Pix, sons, animações e sincronização em tempo real com o
   Firestore. Qualquer visitante usa este arquivo.

   As funções administrativas (login, confirmar pagamento,
   sorteio, etc.) ficam em admin.js, que importa o que precisa
   deste arquivo.
   ============================================================ */

import { db, numbersCol, configDocRef } from "./firebase.js";
import {
  onSnapshot,
  doc,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { FOX_LOGO, PRIZE1_IMAGE, PRIZE2_IMAGE } from "./images.js";

/* ============ CONFIG ============ */
export const TOTAL_NUMBERS = 150;
export const PRICE = 5.00;
const PIX = {
  key: "15c7d9e9-8648-41e2-953b-68e1df5d5e23",
  name: "ARIANA RODRIGUES NERES DE MEDEIROS",
  city: "SAO PAULO"
};

export let state = { numbers: {}, prizes: [{ title: "", desc: "" }, { title: "", desc: "" }], meta: 0, draw: null };
export let selected = new Set();
export let isAdmin = false; // controlado de verdade pelo admin.js (Firebase Auth); aqui só reflete o estado atual para o render()
export function setIsAdmin(v) { isAdmin = v; }

let adminClickCount = 0;
let adminClickTimer = null;
let lastToggled = null;

/* ============ FIREBASE: SINCRONIZAÇÃO EM TEMPO REAL ============ */
// Substitui o antigo polling a cada 3s: agora qualquer alteração no
// Firestore (feita por qualquer pessoa, em qualquer lugar) chega aqui
// na hora, via onSnapshot.
onSnapshot(numbersCol, (snapshot) => {
  const fresh = {};
  snapshot.forEach((docSnap) => {
    fresh[docSnap.id] = docSnap.data();
  });
  state.numbers = fresh;
  reconcileSelection();
  render();
}, (err) => {
  console.error("Erro ao sincronizar números:", err);
});

onSnapshot(configDocRef, (snap) => {
  const data = snap.exists() ? snap.data() : null;
  state.prizes = (data && data.prizes) || [{ title: "", desc: "" }, { title: "", desc: "" }];
  state.meta = (data && data.meta) || 0;
  state.draw = (data && data.draw) || null;
  render();
}, (err) => {
  console.error("Erro ao sincronizar configurações:", err);
});

/* ============ PIX EMV BUILDER ============ */
function stripAccents(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function emvField(id, value) {
  const len = String(value).length.toString().padStart(2, '0');
  return id + len + value;
}
function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) { crc = ((crc << 1) ^ 0x1021) & 0xFFFF; }
      else { crc = (crc << 1) & 0xFFFF; }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function buildPixPayload(amount) {
  const merchantName = stripAccents(PIX.name).toUpperCase().substring(0, 25).trimEnd();
  const merchantCity = stripAccents(PIX.city).toUpperCase().substring(0, 15).trimEnd();
  const gui = emvField("00", "BR.GOV.BCB.PIX");
  const key = emvField("01", PIX.key);
  const mai = emvField("26", gui + key);
  const mcc = emvField("52", "0000");
  const cur = emvField("53", "986");
  const amt = emvField("54", amount.toFixed(2));
  const country = emvField("58", "BR");
  const name = emvField("59", merchantName);
  const city = emvField("60", merchantCity);
  const addData = emvField("62", emvField("05", "***"));
  let payload = emvField("00", "01") + emvField("01", "11") + mai + mcc + cur + amt + country + name + city + addData + "6304";
  payload += crc16(payload);
  return payload;
}

/* ============ RENDER ============ */
export function money(v) { return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = (s === null || s === undefined) ? '' : String(s);
  return d.innerHTML;
}

function safeCall(fn) {
  try { fn(); } catch (e) { console.error('Erro no render:', fn.name, e); }
}

// admin.js registra aqui suas próprias funções de render (pedidos, estado do sorteio)
// pra serem chamadas junto do render() público, sem script.js precisar conhecer admin.js.
const adminRenderHooks = [];
export function registerAdminRenderHook(fn) { adminRenderHooks.push(fn); }

export function render() {
  safeCall(renderGrid);
  safeCall(renderStats);
  safeCall(renderPrizes);
  safeCall(renderWinner);
  safeCall(renderCart);
  safeCall(renderNameRing);
  if (isAdmin) { adminRenderHooks.forEach(fn => safeCall(fn)); }
}

let gridRenderedOnce = false;
let gridEls = null;
function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;

  if (!gridEls) {
    gridEls = [];
    grid.innerHTML = "";
    for (let i = 1; i <= TOTAL_NUMBERS; i++) {
      const btn = document.createElement('div');
      btn.className = 'num';
      btn.dataset.status = '';
      btn.style.animation = `fadeUp .5s ease ${(i % 24) * 0.02}s both`;
      btn.addEventListener('click', () => {
        const entry = state.numbers[i];
        if (entry && (entry.status === 'pago' || entry.status === 'reservado')) return;
        const nowSelected = !selected.has(i);
        if (selected.has(i)) selected.delete(i); else selected.add(i);
        nowSelected ? sndSelect() : sndDeselect();
        lastToggled = i;
        render();
      });
      grid.appendChild(btn);
      gridEls[i] = btn;
    }
  }

  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    const entry = state.numbers[i];
    const btn = gridEls[i];
    let status;
    if (entry && entry.status === 'pago') status = 'pago';
    else if (entry && entry.status === 'reservado') status = 'reservado';
    else status = selected.has(i) ? 'selecionado' : 'livre';

    const wantPop = (i === lastToggled && status === 'selecionado');
    const statusKey = status + (wantPop ? '-pop' : '');
    if (btn.dataset.status === statusKey) continue;

    btn.className = 'num' +
      (status === 'pago' ? ' is-paid' : '') +
      (status === 'reservado' ? ' is-reserved' : '') +
      (status === 'selecionado' ? ' is-selected' : '') +
      (wantPop ? ' pop' : '');
    btn.textContent = status === 'pago' ? '' : String(i).padStart(3, '0');
    btn.dataset.status = statusKey;
  }
  lastToggled = null;
  gridRenderedOnce = true;
}

function renderNameRing() {
  const el = document.getElementById('ringText');
  if (!el) return;
  const names = [...new Set(Object.values(state.numbers)
    .filter(e => e && e.status === 'pago' && e.nome)
    .map(e => e.nome.trim().split(' ')[0]))];
  let content;
  if (names.length === 0) {
    content = 'KITSUNE • KITSUNE • KITSUNE • KITSUNE • ';
  } else {
    let joined = names.join(' • ') + ' • ';
    while (joined.length < 130) { joined += joined; }
    content = joined;
  }
  if (el.textContent !== content) el.textContent = content;
}

let lastSoldCount = null;
function renderStats() {
  let sold = 0, revenue = 0;
  Object.values(state.numbers).forEach(e => {
    if (e && e.status === 'pago') { sold++; revenue += PRICE; }
  });
  const soldEl = document.getElementById('statSold');
  soldEl.textContent = sold;
  if (lastSoldCount !== null && lastSoldCount !== sold) {
    soldEl.classList.remove('pulse');
    void soldEl.offsetWidth;
    soldEl.classList.add('pulse');
  }
  lastSoldCount = sold;
  document.getElementById('statFree').textContent = TOTAL_NUMBERS - sold;
  document.getElementById('statTotal').textContent = 'R$ ' + money(revenue);
  const wrap = document.getElementById('progressWrap');
  if (state.meta && state.meta > 0) {
    wrap.style.display = 'block';
    const pct = Math.min(100, (revenue / state.meta) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressText').textContent = `R$${money(revenue)} / R$${money(state.meta)}`;
  } else {
    wrap.style.display = 'none';
  }
}

function renderPrizes() {
  const wrap = document.getElementById('prizesWrap');
  if (!wrap) return;
  wrap.innerHTML = "";
  state.prizes.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'prize-card';
    const media = idx === 0
      ? `<img class="prize-img" src="${PRIZE1_IMAGE}" alt="Copo personalizado">`
      : `<img class="prize-img" src="${PRIZE2_IMAGE}" alt="Camisa personalizada da sala">`;
    const title = p.title || (idx === 0 ? 'Copo personalizado (à escolha)' : 'Camisa personalizada da sala');
    const desc = p.desc || (idx === 0
      ? 'A pessoa sorteada escolhe o modelo e a cor entre as opções disponíveis.'
      : 'A camisa oficial da nossa sala, no modelo do print. ⚠️ Vem sem nome personalizado — só o design padrão da turma.');
    card.innerHTML = `${media}<span class="tag">Prêmio ${idx + 1}</span><h3>${esc(title)}</h3><p>${esc(desc)}</p>`;
    wrap.appendChild(card);
  });
}

let lastDrawTs = null;
function renderWinner() {
  const banner = document.getElementById('winnerBanner');
  if (!banner) return;
  const box = banner.querySelector('.winner-box');
  if (!state.draw) { banner.style.display = 'none'; box.classList.remove('celebrate'); lastDrawTs = null; return; }
  banner.style.display = 'block';
  box.classList.add('celebrate');
  const d = state.draw;
  if (lastDrawTs !== d.ts) {
    lastDrawTs = d.ts;
    launchConfetti();
    sndDraw();
  }
  const t1 = state.numbers[d.ticket1];
  const t2 = state.numbers[d.ticket2];
  const methodLabel = d.method === 'federal' ? 'Loteria Federal' : 'Sorteio criptográfico seguro';
  document.getElementById('winnerContent').innerHTML = `
    <div class="w-row">Prêmio 1 → nº <b>${String(d.ticket1).padStart(3, '0')}</b> — ${t1 ? esc(t1.nome) : '—'}</div>
    <div class="w-row">Prêmio 2 → nº <b>${String(d.ticket2).padStart(3, '0')}</b> — ${t2 ? esc(t2.nome) : '—'}</div>
    <div class="w-row" style="color:var(--cream-dim); font-size:12px;">Método: ${methodLabel}</div>
  `;
}

function renderCart() {
  const bar = document.getElementById('cartbar');
  if (!bar) return;
  if (selected.size === 0) { bar.classList.remove('show'); return; }
  bar.classList.add('show');
  document.getElementById('cartCount').textContent = selected.size;
  document.getElementById('cartTotal').textContent = 'R$ ' + money(selected.size * PRICE);
}

/* ============ RECONCILIAÇÃO DO CARRINHO ============ */
export function reconcileSelection() {
  let removedAny = false;
  [...selected].forEach(n => {
    if (state.numbers[n]) { selected.delete(n); removedAny = true; }
  });
  if (removedAny) {
    showToast('Algum número que você tinha escolhido acabou de ser reservado por outra pessoa e foi removido da sua seleção.');
  }
}

/* ============ TOAST / CONFIRM CUSTOMIZADO ============ */
export function openOverlay(id) { document.getElementById(id).classList.add('open'); }
export function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }

export function showToast(msg) {
  let toast = document.getElementById('toastMsg');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastMsg';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 4500);
}

let _confirmResolve = null;
export function showConfirm(msg) {
  return new Promise(resolve => {
    document.getElementById('confirmMsg').textContent = msg;
    _confirmResolve = resolve;
    openOverlay('confirmOverlay');
  });
}
document.getElementById('confirmYes').addEventListener('click', () => {
  closeOverlay('confirmOverlay');
  if (_confirmResolve) _confirmResolve(true);
});
document.getElementById('confirmNo').addEventListener('click', () => {
  closeOverlay('confirmOverlay');
  if (_confirmResolve) _confirmResolve(false);
});

/* ============ SHA-256 (usado pela senha crítica em admin.js) ============ */
export async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ SONS ============ */
let _actx = null;
function getAudioCtx() {
  if (!_actx) {
    try { _actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (_actx.state === 'suspended') { _actx.resume(); }
  return _actx;
}
function playTone(freq, duration = 0.1, type = 'sine', vol = 0.15, delay = 0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  } catch (e) {}
}
export function sndSelect() { playTone(700, 0.05, 'sine', 0.08); }
export function sndDeselect() { playTone(400, 0.05, 'sine', 0.07); }
export function sndError() { playTone(180, 0.15, 'sine', 0.08); }
export function sndSuccess() {
  playTone(600, 0.1, 'sine', 0.1, 0);
  playTone(800, 0.12, 'sine', 0.1, 0.09);
}
export function sndAdmin() {
  playTone(300, 0.1, 'sine', 0.08, 0);
  playTone(500, 0.14, 'sine', 0.09, 0.1);
}
export function sndDraw() {
  playTone(600, 0.14, 'sine', 0.1, 0);
  playTone(800, 0.14, 'sine', 0.1, 0.12);
  playTone(1000, 0.18, 'sine', 0.1, 0.24);
}
export function sndClick() { playTone(600, 0.05, 'sine', 0.08); }

/* ============ CHECKOUT (RESERVA DO VISITANTE) ============ */
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => closeOverlay(el.dataset.close));
});

document.getElementById('myNumbersBtn').addEventListener('click', () => {
  document.getElementById('myNumbersQuery').value = '';
  document.getElementById('myNumbersResult').innerHTML = '';
  openOverlay('myNumbersOverlay');
});

function searchMyNumbers() {
  const q = document.getElementById('myNumbersQuery').value.trim();
  const resEl = document.getElementById('myNumbersResult');
  if (!q) { resEl.innerHTML = '<p class="hint">Digite seu WhatsApp ou nome pra buscar.</p>'; return; }

  const qDigits = q.replace(/\D/g, '');
  const qLower = q.toLowerCase();
  const matches = [];
  Object.entries(state.numbers).forEach(([num, e]) => {
    if (!e) return;
    const phoneDigits = (e.telefone || '').replace(/\D/g, '');
    const phoneMatch = qDigits.length >= 8 && phoneDigits && phoneDigits.includes(qDigits);
    const nameMatch = qLower.length >= 3 && e.nome && e.nome.toLowerCase().includes(qLower);
    if (phoneMatch || nameMatch) { matches.push({ num: parseInt(num), status: e.status }); }
  });

  if (matches.length === 0) {
    resEl.innerHTML = '<p class="hint">Nenhum número encontrado com esses dados. Confira se digitou certinho.</p>';
    sndError();
    return;
  }

  matches.sort((a, b) => a.num - b.num);
  resEl.innerHTML = `<p class="hint">Encontramos ${matches.length} número(s):</p>` + matches.map(m => `
    <div class="my-num-row">
      <span class="mono">${String(m.num).padStart(3, '0')}</span>
      <span class="pill ${m.status}">${m.status}</span>
    </div>
  `).join('');
  sndSuccess();
}
document.getElementById('myNumbersSearch').addEventListener('click', searchMyNumbers);
document.getElementById('myNumbersQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchMyNumbers();
});

document.getElementById('goCheckout').addEventListener('click', () => {
  // admin.js pode interceptar este clique (modo de teste) antes de chegar aqui —
  // veja adminTestModeIntercept em admin.js
  if (window.__adminTestModeActive && window.__adminTestModeActive()) {
    window.__quickTestReserve && window.__quickTestReserve();
    return;
  }
  document.getElementById('checkoutStep1').style.display = 'block';
  document.getElementById('checkoutStep2').style.display = 'none';
  document.getElementById('checkoutError').textContent = '';
  const nums = [...selected].sort((a, b) => a - b).map(n => String(n).padStart(3, '0')).join(', ');
  document.getElementById('checkoutSummary').innerHTML = `Números: <b>${nums}</b><br>Total: <b>R$ ${money(selected.size * PRICE)}</b>`;
  document.getElementById('buyerName').value = '';
  document.getElementById('buyerEmail').value = '';
  document.getElementById('buyerPhone').value = '';
  openOverlay('checkoutOverlay');
});

document.getElementById('confirmReserve').addEventListener('click', async () => {
  const name = document.getElementById('buyerName').value.trim();
  const email = document.getElementById('buyerEmail').value.trim();
  const phone = document.getElementById('buyerPhone').value.trim();
  const errEl = document.getElementById('checkoutError');
  if (!name) { errEl.textContent = 'Digite seu nome.'; sndError(); return; }
  if (!phone) { errEl.textContent = 'Digite seu WhatsApp.'; sndError(); return; }
  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 11) { errEl.textContent = 'Digite um WhatsApp válido, com DDD (ex: 11 90000-0000).'; sndError(); return; }
  if (email && (!email.includes('@') || !email.includes('.'))) { errEl.textContent = 'Digite um e-mail válido (ou deixe em branco).'; sndError(); return; }
  if (selected.size === 0) { errEl.textContent = 'Nenhum número selecionado.'; sndError(); return; }

  const chosen = [...selected];
  const orderId = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const ts = Date.now();

  try {
    // Transação atômica: garante que ninguém consegue "roubar" um número
    // entre o momento em que você escolheu e o momento em que confirma.
    await runTransaction(db, async (tx) => {
      const refs = chosen.map(n => doc(db, 'numbers', String(n)));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      const taken = [];
      snaps.forEach((snap, idx) => { if (snap.exists()) taken.push(chosen[idx]); });
      if (taken.length) {
        const e = new Error('taken');
        e.taken = taken;
        throw e;
      }
      refs.forEach(ref => {
        tx.set(ref, { status: 'reservado', nome: name, email: email, telefone: phone, order: orderId, ts });
      });
    });
  } catch (e) {
    if (e && e.taken) {
      e.taken.forEach(n => selected.delete(n));
      errEl.textContent = `Alguns números já foram escolhidos por outra pessoa (${e.taken.map(n => String(n).padStart(3, '0')).join(', ')}). Removidos da sua seleção — revise e tente de novo.`;
      sndError();
      render();
    } else {
      console.error(e);
      errEl.textContent = 'Não foi possível reservar agora. Tente de novo em alguns segundos.';
      sndError();
    }
    return;
  }

  sndSuccess();
  const total = chosen.length * PRICE;
  const payload = buildPixPayload(total);
  document.getElementById('payAmount').textContent = money(total);
  document.getElementById('pixCode').value = payload;
  document.getElementById('qrcode').innerHTML = '';
  new QRCode(document.getElementById('qrcode'), { text: payload, width: 200, height: 200 });

  document.getElementById('checkoutStep1').style.display = 'none';
  document.getElementById('checkoutStep2').style.display = 'block';
  selected.clear();
  render();
});

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

document.getElementById('copyPix').addEventListener('click', async () => {
  const field = document.getElementById('pixCode');
  field.select();
  field.setSelectionRange(0, field.value.length);
  const btn = document.getElementById('copyPix');
  const original = btn.textContent;
  const ok = await copyToClipboard(field.value);
  btn.textContent = ok ? '✓ Copiado!' : 'Selecionado — use Ctrl+C';
  setTimeout(() => { btn.textContent = original; }, 2200);
});

/* ============ REVEAL AO ROLAR ============ */
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('in-view'); revealObserver.unobserve(entry.target); }
  });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

/* ============ CONFETE ============ */
function launchConfetti() {
  const emojis = ['🎉', '🦊', '🔥', '✨', '🏮'];
  for (let i = 0; i < 24; i++) {
    setTimeout(() => {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      piece.style.left = (Math.random() * 100) + 'vw';
      piece.style.top = (60 + Math.random() * 20) + 'vh';
      piece.style.fontSize = (16 + Math.random() * 16) + 'px';
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 1500);
    }, i * 40);
  }
}

/* ============ LOGO / TELA DE ABERTURA ============ */
document.getElementById('foxTrigger').src = FOX_LOGO;

(function initIntro() {
  const overlay = document.getElementById('introOverlay');
  const fox = document.getElementById('foxTrigger');
  if (!overlay || !fox) { return; }

  const target = fox.getBoundingClientRect();
  const startSize = 150;
  const startTop = window.innerHeight / 2 - startSize / 2 - 46;
  const startLeft = window.innerWidth / 2 - startSize / 2;

  fox.style.position = 'fixed';
  fox.style.zIndex = '600';
  fox.style.margin = '0';
  fox.style.left = startLeft + 'px';
  fox.style.top = startTop + 'px';
  fox.style.width = startSize + 'px';
  fox.style.height = startSize + 'px';
  fox.style.transition = 'none';
  void fox.offsetWidth;

  setTimeout(() => {
    fox.style.transition = 'left 1s cubic-bezier(.22,.85,.2,1), top 1s cubic-bezier(.22,.85,.2,1), width 1s cubic-bezier(.22,.85,.2,1), height 1s cubic-bezier(.22,.85,.2,1)';
    fox.style.left = target.left + 'px';
    fox.style.top = target.top + 'px';
    fox.style.width = target.width + 'px';
    fox.style.height = target.height + 'px';
  }, 1400);

  setTimeout(() => { overlay.classList.add('hide'); }, 1650);

  setTimeout(() => {
    fox.style.position = '';
    fox.style.zIndex = '';
    fox.style.margin = '';
    fox.style.left = '';
    fox.style.top = '';
    fox.style.width = '';
    fox.style.height = '';
    fox.style.transition = '';
    overlay.remove();
  }, 2500);
})();

/* ============ GATILHO DA RAPOSA (5 cliques → abre login do admin) ============ */
// A ativação em si (Firebase Auth) fica em admin.js; aqui só cuidamos do
// gesto de "5 cliques" que abre a tela de senha, e do botão de logout
// quando já está em modo admin (admin.js decide o que "isAdmin" significa).
document.getElementById('foxTrigger').addEventListener('click', () => {
  if (window.__isAdminActive && window.__isAdminActive()) {
    window.__adminLogout && window.__adminLogout();
    return;
  }
  adminClickCount++;
  clearTimeout(adminClickTimer);
  adminClickTimer = setTimeout(() => { adminClickCount = 0; }, 2500);
  if (adminClickCount >= 5) {
    adminClickCount = 0;
    document.getElementById('adminEmail').value = '';
    document.getElementById('adminPass').value = '';
    document.getElementById('adminError').textContent = '';
    openOverlay('adminLoginOverlay');
  }
});

/* ============ BRASAS FLUTUANTES ============ */
function spawnEmber() {
  const ember = document.createElement('div');
  ember.className = 'ember';
  const size = 3 + Math.random() * 4;
  ember.style.width = size + 'px';
  ember.style.height = size + 'px';
  ember.style.left = Math.random() * 100 + 'vw';
  ember.style.setProperty('--drift', (Math.random() * 50 - 25) + 'px');
  const duration = 9 + Math.random() * 10;
  ember.style.animationDuration = duration + 's';
  document.body.appendChild(ember);
  setTimeout(() => ember.remove(), duration * 1000);
}
for (let i = 0; i < 10; i++) { setTimeout(spawnEmber, i * 900); }
setInterval(spawnEmber, 1400);

/* ============ PROTEÇÃO CONTRA TRAVAMENTOS ============ */
window.addEventListener('error', (ev) => {
  console.error('Erro capturado:', ev.error || ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('Promise rejeitada:', ev.reason);
  ev.preventDefault();
});

render();

/* ============================================================
   admin.js
   Lógica ADMINISTRATIVA da rifa: login (Firebase Authentication),
   confirmar pagamento, liberar número, editar prêmios/meta,
   sorteio, backup e modo de teste.

   Só quem faz login com e-mail/senha cadastrados no Firebase
   Authentication consegue usar qualquer coisa daqui.
   ============================================================ */

import { auth, db, configDocRef, historyCol } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  writeBatch,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  state, selected, TOTAL_NUMBERS, PRICE,
  render, registerAdminRenderHook, setIsAdmin,
  money, esc, showToast, showConfirm, openOverlay, closeOverlay,
  sndError, sndSuccess, sndAdmin, sndClick, sha256Hex
} from "./script.js";

/* ============ SENHA CRÍTICA (ações sensíveis) ============ */
// Segunda camada, além do login do Firebase — continua sendo uma
// senha simples conferida no navegador (não é o Firebase Auth),
// exatamente como funcionava antes. Fica só aqui, não no Firestore.
const CRITICAL_PASSWORD_HASH = "fe5a990212648c026a782c9a119ccc51f28a989bbbe6871653ef78aaedd251b8";

let _criticalResolve = null;
function requireCriticalAuth(msg) {
  return new Promise(resolve => {
    document.getElementById('criticalAuthMsg').textContent = msg || 'Essa ação é sensível e exige a senha crítica.';
    document.getElementById('criticalPass').value = '';
    document.getElementById('criticalError').textContent = '';
    _criticalResolve = resolve;
    openOverlay('criticalAuthOverlay');
  });
}
document.getElementById('criticalCancel').addEventListener('click', () => {
  closeOverlay('criticalAuthOverlay');
  if (_criticalResolve) _criticalResolve(false);
});
document.getElementById('criticalSubmit').addEventListener('click', async () => {
  const pass = document.getElementById('criticalPass').value;
  const hash = await sha256Hex(pass);
  if (hash === CRITICAL_PASSWORD_HASH) {
    closeOverlay('criticalAuthOverlay');
    if (_criticalResolve) _criticalResolve(true);
  } else {
    document.getElementById('criticalError').textContent = 'Senha crítica incorreta.';
    sndError();
  }
});

/* ============ LOGIN / LOGOUT (Firebase Authentication) ============ */
let isAdminLocal = false;
window.__isAdminActive = () => isAdminLocal;
window.__adminLogout = () => signOut(auth);

document.getElementById('adminSubmit').addEventListener('click', async () => {
  const email = document.getElementById('adminEmail').value.trim();
  const pass = document.getElementById('adminPass').value;
  const errEl = document.getElementById('adminError');
  errEl.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    closeOverlay('adminLoginOverlay');
  } catch (e) {
    errEl.textContent = 'E-mail ou senha incorretos.';
    sndError();
  }
});

// onAuthStateChanged é a fonte da verdade sobre quem é admin.
// Também significa que, se você já logou antes nesse navegador,
// continua logado mesmo depois de fechar e abrir a aba de novo.
onAuthStateChanged(auth, async (user) => {
  isAdminLocal = !!user;
  setIsAdmin(isAdminLocal);
  const fox = document.getElementById('foxTrigger');
  const panel = document.getElementById('adminPanel');
  if (isAdminLocal) {
    fox.classList.add('admin-on');
    panel.classList.add('show');
    triggerAdminActivationFX();
    await ensureConfigDocExists();
    fillAdminInputs();
    render();
  } else {
    fox.classList.remove('admin-on');
    panel.classList.remove('show');
  }
});

// Garante que o documento config/main existe (primeiro uso do projeto).
async function ensureConfigDocExists() {
  try {
    const snap = await getDoc(configDocRef);
    if (!snap.exists()) {
      await setDoc(configDocRef, {
        prizes: [{ title: '', desc: '' }, { title: '', desc: '' }],
        meta: 0,
        draw: null
      });
    }
  } catch (e) { console.error('Erro ao inicializar configurações:', e); }
}

function triggerAdminActivationFX() {
  const fox = document.getElementById('foxTrigger');
  const rect = fox.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const flash = document.createElement('div');
  flash.className = 'admin-flash';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 950);

  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const ring = document.createElement('div');
      ring.className = 'admin-ring';
      ring.style.left = cx + 'px';
      ring.style.top = cy + 'px';
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 1050);
    }, i * 180);
  }

  showToast('🔓 Modo administrador ativado');
  sndAdmin();
}

/* ============ HISTÓRICO (log de ações administrativas) ============ */
async function logHistory(action, detail) {
  try {
    await addDoc(historyCol, {
      action, detail,
      adminEmail: auth.currentUser ? auth.currentUser.email : null,
      ts: serverTimestamp()
    });
  } catch (e) { console.error('Erro ao gravar histórico:', e); }
}

/* ============ MODO DE TESTE ============ */
let adminTestMode = false;
window.__adminTestModeActive = () => isAdminLocal && adminTestMode;
window.__quickTestReserve = quickTestReserve;

document.getElementById('toggleTestMode').addEventListener('click', () => {
  adminTestMode = !adminTestMode;
  const btn = document.getElementById('toggleTestMode');
  btn.textContent = adminTestMode ? 'Desativar modo de teste' : 'Ativar modo de teste';
  btn.classList.toggle('btn-primary', adminTestMode);
  showToast(adminTestMode ? '🧪 Modo de teste ativado.' : 'Modo de teste desativado.');
});

async function quickTestReserve() {
  if (selected.size === 0) return;
  const orderId = 'teste_' + Date.now();
  const ts = Date.now();
  try {
    const batch = writeBatch(db);
    selected.forEach(n => {
      batch.set(doc(db, 'numbers', String(n)), {
        status: 'pago', nome: 'Teste (admin)', email: '', telefone: '00000000000',
        order: orderId, ts, teste: true
      });
    });
    await batch.commit();
    selected.clear();
    sndSuccess();
    showToast('🧪 Números de teste marcados como pagos.');
    render();
  } catch (e) {
    console.error(e);
    showToast('Erro ao criar números de teste.');
  }
}

/* ============ BACKUP ============ */
document.getElementById('downloadBackup').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rifa-kitsune-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ============ ZONA DE RISCO ============ */
document.getElementById('resetTestData').addEventListener('click', async () => {
  if (!(await showConfirm('Isso vai apagar TODAS as reservas e pagamentos (números voltam a ficar livres). Prêmios e meta continuam salvos. Essa ação não tem volta. Confirmar?'))) return;
  if (!(await requireCriticalAuth('Zerar todos os números exige a senha crítica.'))) return;
  try {
    const batch = writeBatch(db);
    Object.keys(state.numbers).forEach(num => {
      batch.delete(doc(db, 'numbers', String(num)));
    });
    batch.update(configDocRef, { draw: null });
    await batch.commit();
    await logHistory('reset', 'Todos os números foram zerados.');
    showToast('Todos os números foram zerados.');
  } catch (e) {
    console.error(e);
    showToast('Erro ao zerar números.');
  }
});

/* ============ PRÊMIOS E META ============ */
function fillAdminInputs() {
  document.getElementById('p1title').value = state.prizes[0]?.title || '';
  document.getElementById('p1desc').value = state.prizes[0]?.desc || '';
  document.getElementById('p2title').value = state.prizes[1]?.title || '';
  document.getElementById('p2desc').value = state.prizes[1]?.desc || '';
  document.getElementById('metaInput').value = state.meta || '';
}

document.getElementById('savePrizes').addEventListener('click', async () => {
  const prizes = [
    { title: document.getElementById('p1title').value.trim(), desc: document.getElementById('p1desc').value.trim() },
    { title: document.getElementById('p2title').value.trim(), desc: document.getElementById('p2desc').value.trim() }
  ];
  try {
    await setDoc(configDocRef, { prizes }, { merge: true });
    await logHistory('prizes', 'Prêmios atualizados.');
    showToast('Prêmios salvos!');
  } catch (e) { console.error(e); showToast('Erro ao salvar prêmios.'); }
});

document.getElementById('saveMeta').addEventListener('click', async () => {
  const meta = parseFloat(document.getElementById('metaInput').value) || 0;
  try {
    await setDoc(configDocRef, { meta }, { merge: true });
    await logHistory('meta', `Meta definida para R$${meta}.`);
    showToast('Meta salva!');
  } catch (e) { console.error(e); showToast('Erro ao salvar meta.'); }
});

/* ============ ESTADO DO SORTEIO (mostra/esconde botões) ============ */
function renderDrawState() {
  const options = document.getElementById('drawOptions');
  const done = document.getElementById('drawDoneBox');
  if (!options || !done) return;
  if (state.draw) {
    options.style.display = 'none';
    done.style.display = 'block';
  } else {
    options.style.display = 'block';
    done.style.display = 'none';
  }
}
registerAdminRenderHook(renderDrawState);

/* ============ PEDIDOS (tabela do admin) ============ */
function renderAdminOrders() {
  const wrap = document.getElementById('ordersTable');
  if (!wrap) return;
  const groups = {};
  Object.entries(state.numbers).forEach(([num, e]) => {
    if (!e) return;
    const key = e.order || (e.nome + e.ts);
    if (!groups[key]) groups[key] = { nome: e.nome, email: e.email, telefone: e.telefone, status: e.status, nums: [], ts: e.ts, teste: !!e.teste };
    groups[key].nums.push(parseInt(num));
    if (e.status === 'pago') groups[key].status = 'pago';
  });
  const list = Object.entries(groups).sort((a, b) => b[1].ts - a[1].ts);

  const summaryEl = document.getElementById('ordersSummary');
  const reservedCount = list.filter(([, g]) => g.status === 'reservado').length;
  const paidCount = list.filter(([, g]) => g.status === 'pago').length;
  summaryEl.innerHTML = `
    <div class="mini-stat"><b>${list.length}</b><span>pedidos</span></div>
    <div class="mini-stat"><b>${reservedCount}</b><span>reservados</span></div>
    <div class="mini-stat"><b>${paidCount}</b><span>pagos</span></div>
  `;

  if (list.length === 0) { wrap.innerHTML = '<p class="empty">Nenhum pedido ainda.</p>'; return; }
  let html = '<table><thead><tr><th>Nome</th><th>Números</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>';
  list.forEach(([key, g], idx) => {
    const nums = g.nums.sort((a, b) => a - b).map(n => String(n).padStart(3, '0')).join(', ');
    const total = money(g.nums.length * PRICE);
    html += `<tr style="animation-delay:${Math.min(idx, 10) * 0.04}s">
      <td>${esc(g.nome)}${g.teste ? ' <span class="pill" style="background:rgba(156,43,33,0.25); color:var(--red-bright);">TESTE</span>' : ''}<br><span style="color:var(--cream-dim);font-size:11px;">${esc(g.email || '')}</span>${g.telefone ? '<br><span style="color:var(--cream-dim);font-size:11px;">' + esc(g.telefone) + '</span>' : ''}</td>
      <td class="mono">${nums}</td>
      <td class="mono">R$ ${total}</td>
      <td><span class="pill ${g.status}">${g.status}</span></td>
      <td>
        ${g.status === 'reservado' ? `<button class="mini-btn ok" data-confirm="${key}">Confirmar</button>` : ''}
        <button class="mini-btn no" data-release="${key}" data-status="${g.status}">Liberar</button>
      </td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await showConfirm('Confirmar que o pagamento desse pedido foi recebido? Os números ficam travados definitivamente.'))) return;
      const key = btn.dataset.confirm;
      try {
        const batch = writeBatch(db);
        Object.keys(state.numbers).forEach(num => {
          const e = state.numbers[num];
          if (e && (e.order || (e.nome + e.ts)) === key) {
            batch.update(doc(db, 'numbers', String(num)), { status: 'pago' });
          }
        });
        await batch.commit();
        await logHistory('confirm', `Pagamento confirmado: ${key}`);
        sndSuccess();
      } catch (e) { console.error(e); showToast('Erro ao confirmar pagamento.'); }
    });
  });

  wrap.querySelectorAll('[data-release]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!(await showConfirm('Liberar esses números? Eles voltam a ficar disponíveis para qualquer pessoa escolher.'))) return;
      if (btn.dataset.status === 'pago') {
        if (!(await requireCriticalAuth('Esse número já está PAGO. Liberar um número já confirmado exige a senha crítica.'))) return;
      }
      const key = btn.dataset.release;
      try {
        const batch = writeBatch(db);
        Object.keys(state.numbers).forEach(num => {
          const e = state.numbers[num];
          if (e && (e.order || (e.nome + e.ts)) === key) {
            batch.delete(doc(db, 'numbers', String(num)));
          }
        });
        await batch.commit();
        await logHistory('release', `Números liberados: ${key}`);
      } catch (e) { console.error(e); showToast('Erro ao liberar números.'); }
    });
  });
}
registerAdminRenderHook(renderAdminOrders);

/* ============ SORTEIO ============ */
function getPaidNumbers() {
  return Object.entries(state.numbers).filter(([n, e]) => e && e.status === 'pago').map(([n]) => parseInt(n)).sort((a, b) => a - b);
}
function buyerId(entry) {
  const phone = (entry.telefone || '').replace(/\D/g, '');
  return phone || (entry.nome || '').trim().toLowerCase();
}

document.getElementById('drawCrypto').addEventListener('click', async () => {
  const pool = getPaidNumbers();
  const msg = document.getElementById('drawMsg');
  if (pool.length < 2) { msg.textContent = 'É preciso pelo menos 2 números pagos para sortear os 2 prêmios.'; return; }
  const uniqueBuyers = new Set(pool.map(n => buyerId(state.numbers[n])));
  if (uniqueBuyers.size < 2) { msg.textContent = 'É preciso que pelo menos 2 pessoas diferentes tenham números pagos, pra garantir que a mesma pessoa não leve os dois prêmios.'; return; }
  if (!(await showConfirm('Realizar o sorteio agora? Essa ação define o resultado final e fica visível para todo mundo.'))) return;
  if (!(await requireCriticalAuth('Realizar o sorteio exige a senha crítica.'))) return;
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  const ticket1 = pool[arr[0] % pool.length];
  const buyer1 = buyerId(state.numbers[ticket1]);
  const pool2 = pool.filter(n => buyerId(state.numbers[n]) !== buyer1);
  const ticket2 = pool2[arr[1] % pool2.length];
  try {
    const draw = { method: 'crypto', ticket1, ticket2, ts: Date.now() };
    await setDoc(configDocRef, { draw }, { merge: true });
    await logHistory('draw', `Sorteio (crypto): ${ticket1} / ${ticket2}`);
    msg.textContent = 'Sorteio realizado com sucesso!';
  } catch (e) { console.error(e); msg.textContent = 'Erro ao salvar o resultado do sorteio.'; }
});

document.getElementById('drawFederal').addEventListener('click', async () => {
  const pool = getPaidNumbers();
  const msg = document.getElementById('drawMsg');
  const f1 = parseInt(document.getElementById('fed1').value);
  const f2 = parseInt(document.getElementById('fed2').value);
  if (pool.length < 2) { msg.textContent = 'É preciso pelo menos 2 números pagos para sortear os 2 prêmios.'; return; }
  const uniqueBuyers = new Set(pool.map(n => buyerId(state.numbers[n])));
  if (uniqueBuyers.size < 2) { msg.textContent = 'É preciso que pelo menos 2 pessoas diferentes tenham números pagos, pra garantir que a mesma pessoa não leve os dois prêmios.'; return; }
  if (isNaN(f1) || isNaN(f2)) { msg.textContent = 'Informe os dois números de 5 dígitos da Loteria Federal.'; return; }
  if (!(await showConfirm('Realizar o sorteio agora? Essa ação define o resultado final e fica visível para todo mundo.'))) return;
  if (!(await requireCriticalAuth('Realizar o sorteio exige a senha crítica.'))) return;
  const ticket1 = pool[f1 % pool.length];
  const buyer1 = buyerId(state.numbers[ticket1]);
  const pool2 = pool.filter(n => buyerId(state.numbers[n]) !== buyer1);
  const ticket2 = pool2[f2 % pool2.length];
  try {
    const draw = { method: 'federal', ticket1, ticket2, ts: Date.now() };
    await setDoc(configDocRef, { draw }, { merge: true });
    await logHistory('draw', `Sorteio (Loteria Federal): ${ticket1} / ${ticket2}`);
    msg.textContent = 'Sorteio calculado com base na Loteria Federal!';
  } catch (e) { console.error(e); msg.textContent = 'Erro ao salvar o resultado do sorteio.'; }
});

document.getElementById('redoDraw').addEventListener('click', async () => {
  if (!(await showConfirm('Refazer o sorteio? O resultado atual será apagado e o vencedor anterior deixa de aparecer no site. Só use isso por um motivo legítimo (ex: erro no primeiro sorteio) e avise a sala diretamente — o histórico de ações fica salvo no Firestore, mas o resultado antigo em si não fica mais visível no site.'))) return;
  if (!(await requireCriticalAuth('Refazer o sorteio exige a senha crítica.'))) return;
  try {
    await setDoc(configDocRef, { draw: null }, { merge: true });
    await logHistory('redoDraw', 'Sorteio resetado manualmente.');
    showToast('Sorteio resetado — pronto para sortear de novo.');
  } catch (e) { console.error(e); showToast('Erro ao resetar sorteio.'); }
});

/* ============================================================
   firebase.js
   Configuração e inicialização do Firebase.

   COMO USAR:
   1. Crie um projeto no Firebase (veja o README.md, seção
      "Como criar um projeto Firebase").
   2. Copie as credenciais do seu projeto e cole no objeto
      firebaseConfig abaixo, no lugar dos textos "COLE_AQUI".
   3. Salve o arquivo. Não precisa mexer em mais nada aqui.

   Este arquivo só cuida da conexão com o Firebase. A lógica da
   rifa em si está em script.js (parte pública) e admin.js
   (parte administrativa).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ⚠️ COLE AQUI as credenciais do SEU projeto Firebase
// (Console do Firebase → Configurações do projeto → Seus apps → SDK setup and configuration)
const firebaseConfig = {
  apiKey: "AIzaSyBl0ZhWKNzbKitXaAoDzBNYPs2IilwypX0",
  authDomain: "rifa-kitsune.firebaseapp.com",
  projectId: "rifa-kitsune",
  storageBucket: "rifa-kitsune.firebasestorage.app",
  messagingSenderId: "1071372771831",
  appId: "1:1071372771831:web:c4a08116e9e96f237c0ef2",
  measurementId: "G-51DYY2CYX7"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Referências das coleções/documentos usados pela rifa.
// (mantidas aqui centralizadas pra facilitar entender o "banco de dados" do projeto)
export const numbersCol = collection(db, "numbers");   // um documento por número (001 a 150)
export const configDocRef = doc(db, "config", "main"); // prêmios, meta e resultado do sorteio
export const historyCol = collection(db, "history");   // histórico de ações administrativas

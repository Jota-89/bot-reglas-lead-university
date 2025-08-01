// Configuración Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

const firebaseConfig = {
  apiKey: "demo-project",
  authDomain: "demo-project.firebaseapp.com",
  projectId: "demo-bot",
  storageBucket: "demo-bot.appspot.com",
  messagingSenderId: "123456789",
  appId: "demo-app-id"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app);

// Conectar a emuladores locales
if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
  connectFunctionsEmulator(functions, location.hostname, 5001);
}

// Elementos DOM
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');

// Variables
let isProcessing = false;

// Event Listeners
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// Autenticación anónima al cargar
signInAnonymously(auth);

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || isProcessing) return;

  isProcessing = true;
  addMessage('user', message);
  messageInput.value = '';
  
  // Mostrar indicador de escritura
  const typingDiv = addMessage('bot', '🤖 Buscando en el reglamento académico...');
  
  try {
    // Llamar a la función de Firebase
    const consultarReglamento = httpsCallable(functions, 'consultarReglamento');
    console.log('Enviando pregunta:', message);
    
    const response = await consultarReglamento({ pregunta: message });
    console.log('Respuesta recibida:', response.data);
    
    // Remover indicador de escritura
    typingDiv.remove();
    
    if (response.data.success) {
      addMessage('bot', response.data.respuesta);
    } else {
      addMessage('bot', 'Lo siento, hubo un error: ' + response.data.error);
    }
  } catch (error) {
    console.error('Error completo:', error);
    typingDiv.remove();
    addMessage('bot', '❌ Error de conexión. Detalles en consola (F12)');
  }
  
  isProcessing = false;
}

function addMessage(sender, text) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${sender}-message`;
  messageDiv.innerHTML = `
    <div class="message-content">
      <p>${text}</p>
    </div>
  `;
  
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  
  return messageDiv;
}

// Agregar estilos para los mensajes
const style = document.createElement('style');
style.textContent = `
.message {
  margin: 1rem 0;
  display: flex;
}

.user-message {
  justify-content: flex-end;
}

.bot-message {
  justify-content: flex-start;
}

.message-content {
  max-width: 70%;
  padding: 1rem;
  border-radius: 10px;
  word-wrap: break-word;
}

.user-message .message-content {
  background: #667eea;
  color: white;
}

.bot-message .message-content {
  background: #f0f0f0;
  color: #333;
}
`;
document.head.appendChild(style);
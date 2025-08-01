// Configuración Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';

const firebaseConfig = {
    apiKey: "demo-project",
    authDomain: "demo-project.firebaseapp.com", 
    projectId: "demo-bot",
    storageBucket: "demo-bot.appspot.com",
    messagingSenderId: "123456789",
    appId: "demo-app-id"
};

const app = initializeApp(firebaseConfig);

// Elementos DOM
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const chatMessages = document.getElementById('chatMessages');

// Variables
let isProcessing = false;
let functionsUrl = '';

// Determinar URL de Functions según el entorno
if (location.hostname.includes('onrender.com')) {
    functionsUrl = 'http://localhost:5001/demo-bot/us-central1/consultarReglamento';
} else if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    functionsUrl = `http://${location.hostname}:5001/demo-bot/us-central1/consultarReglamento`;
} else {
    functionsUrl = 'https://us-central1-demo-bot.cloudfunctions.net/consultarReglamento';
}

console.log('Functions URL:', functionsUrl);

// Event Listeners
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessage('user', message);
    messageInput.value = '';
    
    // Mostrar indicador de escritura
    const typingDiv = addMessage('bot', '🤖 Buscando en el reglamento académico...');
    
    try {
        console.log('Enviando pregunta:', message);
        
        // Llamada HTTP directa en lugar de Firebase SDK
        const response = await fetch(functionsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                data: { pregunta: message }
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Respuesta recibida:', data);
        
        // Remover indicador de escritura
        typingDiv.remove();
        
        if (data.success) {
            addMessage('bot', data.respuesta);
        } else {
            addMessage('bot', 'Lo siento, hubo un error: ' + data.error);
        }
        
    } catch (error) {
        console.error('Error completo:', error);
        typingDiv.remove();
        addMessage('bot', '❌ Error de conexión: ' + error.message);
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

// Mensaje de bienvenida inicial
window.addEventListener('load', () => {
    addMessage('bot', '¡Hola! Soy tu asistente de reglas académicas de Lead University. Pregúntame sobre matrícula, becas, repeticiones o cualquier duda del reglamento.');
});
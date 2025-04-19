const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || `https://advgestor.onrender.com/ping`;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MIN_DELAY = 25_000; // 25 segundos
const MAX_DELAY = 30_000; // 30 segundos
const MAX_MESSAGES_PER_REQUEST = 50;

// Armazenamento
const allowedSenders = new Map();
let currentQRCode = null;

// Persistência
const STATE_DIR = path.join(__dirname, 'state');
const ALLOWED_SENDERS_FILE = path.join(STATE_DIR, 'allowed_senders.json');

// Manipulação de SIGTERM
let server;
process.on('SIGTERM', () => {
  console.log('Recebido SIGTERM. Encerrando servidor...');
  if (server) {
    server.close(() => {
      console.log('Servidor encerrado com sucesso');
      process.exit(0);
    });
  } else {
    console.log('Nenhum servidor ativo para encerrar');
    process.exit(0);
  }
});

// Verificar variáveis de ambiente
console.log('Verificando variáveis de ambiente...');
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL não definida');
if (!KEEP_ALIVE_URL) throw new Error('KEEP_ALIVE_URL não definida');
console.log('Variáveis de ambiente OK');

// Criar diretório de estado
async function initStateDir() {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch (error) {
    console.error('Erro ao criar diretório de estado:', error.message);
  }
}

// Carregar estado
async function loadState() {
  try {
    const allowedSendersData = await fs.readFile(ALLOWED_SENDERS_FILE, 'utf8');
    const parsed = JSON.parse(allowedSendersData);
    for (const [number, data] of Object.entries(parsed)) {
      allowedSenders.set(number, data);
    }
    console.log('allowedSenders carregado:', allowedSenders.size);
  } catch (error) {
    console.log('Nenhum allowedSenders salvo ou erro:', error.message);
  }
}

// Salvar estado
async function saveState() {
  try {
    const allowedSendersObj = Object.fromEntries(allowedSenders);
    await fs.writeFile(ALLOWED_SENDERS_FILE, JSON.stringify(allowedSendersObj, null, 2));
    console.log('Estado salvo com sucesso');
  } catch (error) {
    console.error('Erro ao salvar estado:', error.message);
  }
}

// Middleware
app.use((req, res, next) => {
  if (req.path === '/send' && req.method === 'POST') return next();
  return express.json()(req, res, next);
});

// Função para parsear JSON
const cleanAndParseJSON = (data) => {
  try {
    if (typeof data === 'object' && data !== null) return data;
    let jsonString = typeof data === 'string' ? data : JSON.stringify(data);
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error('JSON inválido');
    }
    jsonString = jsonString.substring(firstBrace, lastBrace + 1).trim().replace(/'/g, '"');
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('Erro ao parsear JSON:', error);
    throw error;
  }
};

// Função para enviar mensagem com delay
const sendMessageWithDelay = async ({ telefone, message }, delay) => {
  return new Promise((resolve) => {
    setTimeout(async () => {
      const cleanNumber = telefone.toString().replace(/[^0-9]/g, '');
      try {
        if (!global.client) {
          console.error('Cliente WhatsApp não conectado');
          resolve({ success: false, number: cleanNumber, error: 'Cliente WhatsApp não conectado' });
          return;
        }
        const [result] = await global.client.onWhatsApp(`${cleanNumber}@s.whatsapp.net`);
        if (!result || !result.exists) {
          console.log(`Número ${cleanNumber} não registrado no WhatsApp`);
          resolve({ success: false, number: cleanNumber, error: 'Número não registrado' });
          return;
        }
        const sentMessage = await global.client.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message }, { timeout: 60_000 });
        console.log(`Mensagem enviada para ${cleanNumber}`);
        resolve({ success: true, number: cleanNumber });
      } catch (error) {
        console.error(`Erro ao enviar para ${cleanNumber}:`, error.message);
        resolve({ success: false, number: cleanNumber, error: error.message });
      }
    }, delay);
  });
};

// Função para enviar dados ao Make
async function sendToMake(data) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        timeout: FETCH_TIMEOUT,
      });
      if (response.ok) {
        console.log('Dados enviados ao Make:', data);
        return true;
      }
      console.error(`Erro no Make: Status ${response.status}`);
      throw new Error(`Status ${response.status}`);
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar ao Make (tentativa ${4 - retries}/3):`, error.message);
      if (retries === 0) return false;
      await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
    }
  }
  return false;
}

// Rota para obter QR code
app.get('/qrcode', (req, res) => {
  if (currentQRCode) {
    console.log('Retornando QR code atual');
    res.json({ qrcode: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(currentQRCode)}` });
  } else {
    console.log('Nenhum QR code disponível');
    res.status(404).json({ error: 'Nenhum QR code disponível, aguardando geração' });
  }
});

// Rota para enviar mensagens
app.post('/send', express.json(), async (req, res) => {
  try {
    let messages = req.body;

    // Caso 1: Payload com "dados" (formato antigo do Wix ou Make)
    if (messages.dados) {
      const parsedData = cleanAndParseJSON(messages.dados);
      if (parsedData.messages && Array.isArray(parsedData.messages)) {
        messages = parsedData.messages; // Extrair "messages"
      } else if (Array.isArray(parsedData)) {
        messages = parsedData; // Se "dados" já contém o array direto
      } else {
        console.error('Requisição inválida: "dados" deve conter um array ou "messages"');
        return res.status(400).json({ error: 'Payload inválido: "dados" deve conter um array ou "messages"' });
      }
    }
    // Caso 2: Payload com "number" e "message" (formato alternativo)
    else if (messages.number && messages.message) {
      messages = [{ telefone: messages.number, message: messages.message }];
    }
    // Caso 3: Payload direto (formato esperado, ex.: Wix ajustado)
    else if (!Array.isArray(messages)) {
      console.error('Requisição inválida: o corpo deve ser um array de mensagens');
      return res.status(400).json({ error: 'O corpo da requisição deve ser um array de mensagens' });
    }

    if (messages.length > MAX_MESSAGES_PER_REQUEST) {
      console.error(`Número de mensagens (${messages.length}) excede o limite`);
      return res.status(400).json({ error: `Máximo de ${MAX_MESSAGES_PER_REQUEST} mensagens` });
    }

    if (!global.client) {
      console.error('Cliente WhatsApp não conectado');
      return res.status(503).json({ error: 'WhatsApp não conectado' });
    }

    const sendPromises = messages.map(msg => {
      const { telefone, message } = msg;
      if (!telefone || !message) return { success: false, error: 'Telefone ou mensagem ausente' };
      const delay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
      return sendMessageWithDelay({ telefone, message }, delay);
    });

    res.status(202).json({ message: 'Enviando mensagens' });
    const results = await Promise.all(sendPromises);
    console.log('Resultado do envio:', results);
  } catch (error) {
    console.error('Erro em /send:', error.message);
    return res.status(500).json({ error: 'Erro ao processar envio' });
  }
});

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Pong!');
});

// Conexão com WhatsApp
const connectToWhatsApp = async (retryCount = 0) => {
  const authDir = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message) {
      console.log('Mensagem ignorada: sem conteúdo');
      return;
    }
    if (msg.key.remoteJid.endsWith('@g.us')) {
      console.log('Mensagem ignorada: origem de grupo');
      return;
    }

    const messageType = Object.keys(msg.message)[0];
    if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') {
      console.log(`Mensagem ignorada: tipo ${messageType} não suportado`);
      return;
    }

    const senderNumber = msg.key.remoteJid.split('@')[0];
    const conversationId = msg.key.id;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderName = msg.pushName || senderNumber;
    const currentTime = Date.now();

    const senderData = allowedSenders.get(senderNumber);
    const isAllowed = senderData && (currentTime - senderData.lastMessageTime) < MESSAGE_TIMEOUT;
    const drEliahRegex = /dr\.?\s*eliah/i;
    const containsDrEliah = drEliahRegex.test(text);

    if (!isAllowed && !containsDrEliah) {
      console.log(`Mensagem de ${senderNumber} ignorada: não liberado e sem "Dr. Eliah"`);
      return;
    }

    if (containsDrEliah) {
      console.log(`Remetente ${senderNumber} liberado por "Dr. Eliah"`);
    }

    allowedSenders.set(senderNumber, { lastMessageTime: currentTime });
    await saveState();

    const webhookData = {
      number: senderNumber,
      conversationId: conversationId,
      message: text,
      name: senderName,
    };
    await sendToMake(webhookData);
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      currentQRCode = qr;
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
      console.log('Novo QR Code gerado:', qrLink);
    }
    if (connection === 'open') {
      console.log('Conectado ao WhatsApp!');
      global.client = sock;
      currentQRCode = null;
      retryCount = 0;
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.message || 'Desconhecido';
      console.log(`Desconectado: ${reason}. Reconectando...`);
      currentQRCode = null;
      const delay = Math.min(5_000 * Math.pow(2, retryCount), 60_000);
      setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
    }
  });
};

// Limpeza de remetentes
setInterval(async () => {
  const currentTime = Date.now();
  let removed = 0;
  for (const [senderNumber, data] of allowedSenders.entries()) {
    if ((currentTime - data.lastMessageTime) >= MESSAGE_TIMEOUT) {
      allowedSenders.delete(senderNumber);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Removidos ${removed} remetentes expirados de allowedSenders`);
    await saveState();
  }
}, CLEANUP_INTERVAL);

// Keep-alive
let keepAliveFailures = 0;
setInterval(async () => {
  console.log('Enviando keep-alive para', KEEP_ALIVE_URL);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const response = await fetch(KEEP_ALIVE_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    console.log(`Keep-alive sucesso: ${await response.text()}`);
    keepAliveFailures = 0;
  } catch (error) {
    console.error('Erro no keep-alive:', error.message);
    keepAliveFailures++;
    if (keepAliveFailures >= 3) {
      console.error('Keep-alive falhou 3 vezes consecutivas');
    }
  }
}, KEEP_ALIVE_INTERVAL);

// Inicia o servidor
server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Servidor rodando na porta ${port}`);
  await initStateDir();
  await loadState();
  connectToWhatsApp();
});

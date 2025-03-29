const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://hook.us1.make.com/crkwif3h4cdyvfx7anf4ltla2831r6pr'; // Mova isso pra variável de ambiente no Render
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos

app.use(express.json());

// Rota para enviar mensagem (POST)
app.post('/send', async (req, res) => {
  const { number, message } = req.body;

  // Validação de entrada
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'Número e mensagem são obrigatórios' });
  }

  // Limpar o número (remover +, espaços, traços, etc.)
  const cleanNumber = number.replace(/[^0-9]/g, '');
  if (!cleanNumber || cleanNumber.length < 10) {
    return res.status(400).json({ success: false, error: 'Número de telefone inválido' });
  }

  console.log(`Requisição POST recebida na rota /send: { number: ${cleanNumber}, message: ${message} }`);
  try {
    await global.client.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message, linkPreview: false }, { timeout: 60_000 });
    console.log(`Mensagem enviada com sucesso para: ${cleanNumber}`);
    res.json({ success: true, message: `Mensagem enviada pra ${cleanNumber}` });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    if (error.message && error.message.includes('timed out')) {
      res.status(408).json({ success: false, error: 'Timeout ao enviar mensagem' });
    } else {
      res.status(500).json({ success: false, error: 'Erro ao enviar mensagem' });
    }
  }
});

// Rota simples pra "ping"
app.get('/ping', (req, res) => {
  console.log('Ping recebido! Servidor está ativo.');
  res.send('Pong!');
});

// Função para conectar ao WhatsApp
const connectToWhatsApp = async (retryCount = 0) => {
  const authDir = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60_000,
  });

  // Evento para salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // Evento para monitorar mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('Nova mensagem recebida:', messages);

    const msg = messages[0];
    if (!msg || !msg.message) return;

    // Ignorar mensagens de grupo (se desejado)
    if (msg.key.remoteJid.endsWith('@g.us')) {
      console.log('Mensagem de grupo ignorada:', msg.key.remoteJid);
      return;
    }

    // Verificar se é uma mensagem de texto
    const messageType = Object.keys(msg.message)[0];
    if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

    // Extrair informações
    const senderNumber = msg.key.remoteJid.split('@')[0];
    const conversationId = msg.key.id;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderName = msg.pushName || senderNumber;

    console.log(`Mensagem recebida de ${senderName} (${senderNumber}) - ID da conversa: ${conversationId}: ${text}`);

    // Enviar mensagem para o webhook do Make com retry
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            number: senderNumber,
            conversationId: conversationId,
            message: text,
            name: senderName,
          }),
          timeout: FETCH_TIMEOUT,
        });
        if (response.ok) {
          console.log('Mensagem enviada para o webhook do Make com sucesso!');
          break;
        } else {
          throw new Error(`Webhook respondeu com status ${response.status}`);
        }
      } catch (error) {
        retries--;
        console.error(`Erro ao enviar mensagem para o webhook do Make (tentativa ${4 - retries}/3):`, error);
        if (retries === 0) {
          console.error('Falha ao enviar mensagem para o webhook após 3 tentativas');
        } else {
          await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries))); // Backoff exponencial
        }
      }
    }
  });

  // Evento de atualização de conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log('QR Code (texto):', qr);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('Conectado ao WhatsApp com sucesso!');
      global.client = sock;
      retryCount = 0; // Resetar contagem de tentativas
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.message || 'Motivo desconhecido';
      console.log(`Desconectado! Motivo: ${reason}. Reconectando...`);
      // Backoff exponencial: 5s, 10s, 20s, etc.
      const delay = Math.min(5_000 * Math.pow(2, retryCount), 60_000);
      setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
    }
  });
};

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

// Conecta ao WhatsApp
connectToWhatsApp();

// Função para "pingar" a si mesmo a cada 14 minutos
let keepAliveFailures = 0;
const keepAlive = async () => {
  const url = 'https://whatsapp-api-render-pqn2.onrender.com/ping';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await response.text();
    console.log(`Keep-alive ping: ${text}`);
    keepAliveFailures = 0; // Resetar contagem de falhas
  } catch (error) {
    console.error('Erro ao fazer keep-alive ping:', error);
    keepAliveFailures++;
    if (keepAliveFailures >= 3) {
      console.error('Keep-alive falhou 3 vezes consecutivas. Verifique a conectividade.');
    }
  }
};

// Executa o ping a cada 14 minutos
setInterval(keepAlive, KEEP_ALIVE_INTERVAL);

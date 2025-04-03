const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://hook.us1.make.com/crkwif3h4cdyvfx7anf4ltla2831r6pr';
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos em milissegundos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos em milissegundos

// Armazenamento em memória dos números liberados
const allowedSenders = new Map(); // { "5575992017552": { lastMessageTime: timestamp } }

// Middleware pra parsear JSON em rotas que não sejam /send
app.use((req, res, next) => {
  if (req.path === '/send' && req.method === 'POST') {
    // Para a rota /send, vamos ler o corpo como texto bruto
    return next();
  }
  return express.json()(req, res, next);
});

// Função para limpar e corrigir JSON
const cleanAndParseJSON = (data) => {
  try {
    // Se já for um objeto, não precisa processar
    if (typeof data === 'object' && data !== null) {
      return data;
    }

    // Converter pra string, caso não seja
    let jsonString = typeof data === 'string' ? data : JSON.stringify(data);

    // Remover tudo antes do primeiro { e depois do último }
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error('JSON inválido: não contém chaves {}');
    }
    jsonString = jsonString.substring(firstBrace, lastBrace + 1);

    // Remover espaços desnecessários no início e fim
    jsonString = jsonString.trim();

    // Tentar corrigir aspas inválidas (ex.: ' por ")
    jsonString = jsonString.replace(/'/g, '"');

    // Parsear o JSON
    const parsed = JSON.parse(jsonString);

    // Garantir que as quebras de linha no campo "message" sejam preservadas
    if (parsed.message && typeof parsed.message === 'string') {
      parsed.message = parsed.message.replace(/\\n/g, '\n');
    }

    return parsed;
  } catch (error) {
    console.error('Erro ao limpar e parsear JSON:', error);
    throw new Error(`Falha ao processar JSON: ${error.message}`);
  }
};

// Rota para enviar mensagem (POST)
app.post('/send', async (req, res) => {
  // Ler o corpo da requisição como texto bruto
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    rawBody += chunk;
  });

  req.on('end', async () => {
    try {
      // Limpar e parsear o JSON
      const body = cleanAndParseJSON(rawBody);

      const { number, message } = body;

      // Validação de entrada
      if (!number || !message) {
        return res.status(400).json({ success: false, error: 'Número e mensagem são obrigatórios' });
      }

      // Limpar o número (remover +, espaços, traços, etc.)
      const cleanNumber = number.toString().replace(/[^0-9]/g, '');
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
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });
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
    const currentTime = Date.now();

    console.log(`Mensagem recebida de ${senderName} (${senderNumber}) - ID da conversa: ${conversationId}: ${text}`);

    // Verificar se o remetente já está liberado
    const senderData = allowedSenders.get(senderNumber);
    const isAllowed = senderData && (currentTime - senderData.lastMessageTime) < MESSAGE_TIMEOUT;

    // Verificar se a mensagem contém "Dr. Manoel" ou variações (case-insensitive)
    const drManoelRegex = /dr\.?\s*manoel/i; // Aceita "dr manoel", "dr. manoel", "DR MANOEL", etc.
    const containsDrManoel = drManoelRegex.test(text);

    // Se o remetente não está liberado e a mensagem não contém "Dr. Manoel", ignorar
    if (!isAllowed && !containsDrManoel) {
      console.log(`Mensagem ignorada: remetente ${senderNumber} não está liberado e mensagem não contém "Dr. Manoel".`);
      return;
    }

    // Se a mensagem contém "Dr. Manoel", liberar o remetente
    if (containsDrManoel) {
      console.log(`Remetente ${senderNumber} liberado por mencionar "Dr. Manoel".`);
    }

    // Atualizar o timestamp do remetente
    allowedSenders.set(senderNumber, { lastMessageTime: currentTime });

    // Preparar os dados pra enviar pro webhook
    const webhookData = {
      number: senderNumber,
      conversationId: conversationId,
      message: text,
      name: senderName,
    };

    // Enviar mensagem para o webhook do Make com retry
    let retries = 3;
    while (retries > 0) {
      try {
        const cleanedData = cleanAndParseJSON(webhookData);
        const response = await fetch(WEBHOOK_URL, { // Corrigido: WEBHOOk_URL -> WEBHOOK_URL
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanedData),
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
      retryCount = 0;
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.message || 'Motivo desconhecido';
      console.log(`Desconectado! Motivo: ${reason}. Reconectando...`);
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

// Função para limpar remetentes expirados
const cleanupExpiredSenders = () => {
  const currentTime = Date.now();
  for (const [senderNumber, data] of allowedSenders.entries()) {
    if ((currentTime - data.lastMessageTime) >= MESSAGE_TIMEOUT) {
      console.log(`Remetente ${senderNumber} removido da lista de liberados: última mensagem foi há mais de 30 minutos.`);
      allowedSenders.delete(senderNumber);
    }
  }
};

// Executa a limpeza a cada 5 minutos
setInterval(cleanupExpiredSenders, CLEANUP_INTERVAL);

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
    keepAliveFailures = 0;
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

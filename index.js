const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const fetch = require('node-fetch');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjam';
const ADVOCATE_NAME = process.env.ADVOCATE_NAME;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MIN_DELAY = 25_000; // 25 segundos
const MAX_DELAY = 30_000; // 30 segundos
const MAX_MESSAGES_PER_REQUEST = 50;

// Verificar variáveis de ambiente
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL não definida');
if (!KEEP_ALIVE_URL) throw new Error('KEEP_ALIVE_URL não definida');
if (!DATAJUD_API_KEY) throw new Error('DATAJUD_API_KEY não definida');
if (!ADVOCATE_NAME) throw new Error('ADVOCATE_NAME não definida');

// Armazenamento em memória
const allowedSenders = new Map();
let isCheckingPublications = false; // Controle para evitar verificações simultâneas

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
          resolve({ success: false, number: cleanNumber, error: 'Cliente WhatsApp não conectado' });
          return;
        }
        const [result] = await global.client.onWhatsApp(`${cleanNumber}@s.whatsapp.net`);
        if (!result || !result.exists) {
          console.log(`Número ${cleanNumber} não registrado no WhatsApp`);
          resolve({ success: false, number: cleanNumber, error: 'Número não registrado' });
          return;
        }
        const sentMessage = await global.client.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message, linkPreview: false }, { timeout: 60_000 });
        console.log(`Mensagem enviada para ${cleanNumber}`);
        resolve({ success: true, number: cleanNumber });
      } catch (error) {
        console.error(`Erro ao enviar para ${cleanNumber}:`, error);
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
      throw new Error(`Status ${response.status}`);
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar ao Make (tentativa ${4 - retries}/3):`, error);
      if (retries === 0) return false;
      await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
    }
  }
  return false;
}

// Função para classificar o tipo de publicação
function classifyPublicationType(text) {
  if (!text) return 'Desconhecido';
  text = text.toLowerCase();
  if (text.includes('intimad')) return 'Intimação';
  if (text.includes('despacho')) return 'Despacho';
  if (text.includes('decisão') || text.includes('decid')) return 'Decisão';
  if (text.includes('sentença')) return 'Sentença';
  return 'Outros';
}

// Função para buscar publicações do Datajud
async function fetchDatajudPublications() {
  if (isCheckingPublications) {
    console.log('Verificação de publicações já em andamento, ignorando...');
    return [];
  }
  isCheckingPublications = true;

  try {
    const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;
    console.log(`Buscando publicações para ${ADVOCATE_NAME}`);

    const requestBody = {
      query: {
        bool: {
          filter: [
            {
              range: {
                dataPublicacao: {
                  gte: 'now/d',
                  lte: 'now/d'
                }
              }
            }
          ],
          must: [
            {
              match: {
                'advogados.nome': ADVOCATE_NAME
              }
            }
          ]
        }
      },
      size: 100,
      _source: ['numeroProcesso', 'tipoPublicacao', 'dataPublicacao', 'textoPublicacao']
    };

    const response = await axios.post(endpoint, requestBody, {
      headers: {
        'Authorization': `APIKey ${DATAJUD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: FETCH_TIMEOUT
    });

    if (response.status !== 200) {
      throw new Error(`Status ${response.status}`);
    }

    const publications = response.data.hits.hits.map(hit => hit._source);
    console.log(`Encontradas ${publications.length} publicações`);

    // Enviar cada publicação individualmente ao Make
    for (const pub of publications) {
      const publicationData = {
        numeroProcesso: pub.numeroProcesso || 'Desconhecido',
        tipoPublicacao: classifyPublicationType(pub.tipoPublicacao || pub.textoPublicacao),
        dataPublicacao: pub.dataPublicacao || new Date().toISOString().split('T')[0]
      };
      const sent = await sendToMake(publicationData);
      if (!sent) {
        console.error(`Falha ao enviar publicação: ${JSON.stringify(publicationData)}`);
      }
      // Pequeno atraso para evitar sobrecarga no webhook
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return publications;
  } catch (error) {
    console.error('Erro ao buscar publicações:', error.message);
    return [];
  } finally {
    isCheckingPublications = false;
  }
}

// Rota para enviar mensagens
app.post('/send', async (req, res) => {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', chunk => rawBody += chunk);

  req.on('end', async () => {
    try {
      const body = cleanAndParseJSON(rawBody);
      let messages = [];

      if (body.dados) {
        const dadosParsed = cleanAndParseJSON(body.dados);
        if (!dadosParsed.messages || !Array.isArray(dadosParsed.messages)) {
          console.error('Requisição inválida: "messages" deve ser uma lista');
          return res.status(400).send();
        }
        messages = dadosParsed.messages;
      } else if (body.number && body.message) {
        messages = [{ telefone: body.number, message: body.message }];
      } else {
        console.error('Requisição inválida: payload inválido');
        return res.status(400).send();
      }

      if (messages.length > MAX_MESSAGES_PER_REQUEST) {
        console.error(`Número de mensagens (${messages.length}) excede o limite`);
        return res.status(400).send();
      }

      const sendPromises = [];
      let currentDelay = 0;
      for (const msg of messages) {
        const { telefone, message } = msg;
        if (!telefone || !message) continue;
        const delay = currentDelay + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
        sendPromises.push(sendMessageWithDelay({ telefone, message }, delay));
        currentDelay = delay;
      }

      res.status(200).send();
      const results = await Promise.all(sendPromises);
      console.log('Resultado do envio:', results);
    } catch (error) {
      console.error('Erro em /send:', error);
      res.status(500).send();
    }
  });
});

// Rota manual para testar publicações
app.get('/fetch-publications', async (req, res) => {
  try {
    const publications = await fetchDatajudPublications();
    res.status(200).json({ message: 'Publicações buscadas', publications });
  } catch (error) {
    console.error('Erro em /fetch-publications:', error.message);
    res.status(500).json({ error: 'Erro ao buscar publicações' });
  }
});

// Agendamento: 8h, segunda a sexta
cron.schedule('0 8 * * 1-5', async () => {
  console.log('Verificação inicial de publicações às 8h');
  const publications = await fetchDatajudPublications();
  if (publications.length === 0) {
    console.log('Nenhuma publicação encontrada, iniciando verificações a cada 15 minutos');
    // Agendar verificações a cada 15 minutos até 18h
    const retryJob = cron.schedule('*/15 * * * 1-5', async () => {
      const retryPublications = await fetchDatajudPublications();
      if (retryPublications.length > 0) {
        console.log('Publicações encontradas, encerrando verificações');
        retryJob.stop();
      }
      // Parar às 18h
      const now = new Date();
      const hours = now.getHours();
      if (hours >= 18) {
        console.log('Horário limite (18h) atingido, encerrando verificações');
        retryJob.stop();
      }
    }, { timezone: 'America/Sao_Paulo' });
  }
}, { timezone: 'America/Sao_Paulo' });

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
    if (!msg || !msg.message) return;
    if (msg.key.remoteJid.endsWith('@g.us')) return;

    const messageType = Object.keys(msg.message)[0];
    if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

    const senderNumber = msg.key.remoteJid.split('@')[0];
    const conversationId = msg.key.id;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderName = msg.pushName || senderNumber;
    const currentTime = Date.now();

    const senderData = allowedSenders.get(senderNumber);
    const isAllowed = senderData && (currentTime - senderData.lastMessageTime) < MESSAGE_TIMEOUT;
    const drEliahRegex = /dr\.?\s*eliah/i;
    const containsDrEliah = drEliahRegex.test(text);

    if (!isAllowed && !containsDrEliah) return;

    if (containsDrEliah) {
      console.log(`Remetente ${senderNumber} liberado por "Dr. Eliah"`);
    }

    allowedSenders.set(senderNumber, { lastMessageTime: currentTime });

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
      console.log('Link do QR Code:', `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`);
    }
    if (connection === 'open') {
      console.log('Conectado ao WhatsApp!');
      global.client = sock;
      retryCount = 0;
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.message || 'Desconhecido';
      console.log(`Desconectado: ${reason}. Reconectando...`);
      const delay = Math.min(5_000 * Math.pow(2, retryCount), 60_000);
      setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
    }
  });
};

// Rota de ping
app.get('/ping', (req, res) => res.send('Pong!'));

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

// Conecta ao WhatsApp
connectToWhatsApp();

// Limpeza de remetentes
setInterval(() => {
  const currentTime = Date.now();
  for (const [senderNumber, data] of allowedSenders.entries()) {
    if ((currentTime - data.lastMessageTime) >= MESSAGE_TIMEOUT) {
      allowedSenders.delete(senderNumber);
    }
  }
}, CLEANUP_INTERVAL);

// Keep-alive
let keepAliveFailures = 0;
setInterval(async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const response = await fetch(KEEP_ALIVE_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    console.log(`Keep-alive: ${await response.text()}`);
    keepAliveFailures = 0;
  } catch (error) {
    console.error('Erro no keep-alive:', error);
    keepAliveFailures++;
    if (keepAliveFailures >= 3) {
      console.error('Keep-alive falhou 3 vezes consecutivas');
    }
  }
}, KEEP_ALIVE_INTERVAL);

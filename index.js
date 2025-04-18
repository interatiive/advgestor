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
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjam'; // Ex.: 'tjam' para Tribunal de Justiça do Amazonas
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MIN_DELAY = 25_000; // 25 segundos
const MAX_DELAY = 30_000; // 30 segundos
const MAX_MESSAGES_PER_REQUEST = 50;

// Verificar variáveis de ambiente
if (!WEBHOOK_URL) {
  console.error('Erro: WEBHOOK_URL não está definida.');
  process.exit(1);
}
if (!KEEP_ALIVE_URL) {
  console.error('Erro: KEEP_ALIVE_URL não está definida.');
  process.exit(1);
}
if (!DATAJUD_API_KEY) {
  console.error('Erro: DATAJUD_API_KEY não está definida.');
  process.exit(1);
}

// Armazenamento em memória dos números liberados
const allowedSenders = new Map();

// Middleware para parsear JSON, exceto na rota /send
app.use((req, res, next) => {
  if (req.path === '/send' && req.method === 'POST') {
    return next();
  }
  return express.json()(req, res, next);
});

// Função para limpar e parsear JSON
const cleanAndParseJSON = (data) => {
  try {
    if (typeof data === 'object' && data !== null) {
      return data;
    }
    let jsonString = typeof data === 'string' ? data : JSON.stringify(data);
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || firstBrace > lastBrace) {
      throw new Error('JSON inválido: não contém chaves {}');
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
          console.error('Erro: Cliente WhatsApp não está conectado.');
          resolve({ success: false, number: cleanNumber, error: 'Cliente WhatsApp não está conectado.' });
          return;
        }
        const [result] = await global.client.onWhatsApp(`${cleanNumber}@s.whatsapp.net`);
        if (!result || !result.exists) {
          console.log(`Número ${cleanNumber} não está registrado no WhatsApp`);
          resolve({ success: false, number: cleanNumber, error: 'Número não registrado no WhatsApp' });
          return;
        }
        const sentMessage = await global.client.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message, linkPreview: false }, { timeout: 60_000 });
        console.log(`Mensagem enviada com sucesso para: ${cleanNumber}`, sentMessage);
        resolve({ success: true, number: cleanNumber });
      } catch (error) {
        console.error(`Erro ao enviar mensagem para ${cleanNumber}:`, error);
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
        console.log('Dados enviados ao Make com sucesso:', data);
        return true;
      } else {
        throw new Error(`Webhook respondeu com status ${response.status}`);
      }
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar ao Make (tentativa ${4 - retries}/3):`, error);
      if (retries === 0) {
        console.error('Falha ao enviar ao Make após 3 tentativas');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
    }
  }
  return false;
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
          console.error('Requisição inválida: "messages" deve ser uma lista dentro de "dados"');
          return res.status(400).send();
        }
        messages = dadosParsed.messages;
      } else if (body.number && body.message) {
        messages = [{ telefone: body.number, message: body.message }];
      } else {
        console.error('Requisição inválida: o payload deve conter "dados" ou os campos "number" e "message"');
        return res.status(400).send();
      }

      if (messages.length > MAX_MESSAGES_PER_REQUEST) {
        console.error(`Número de mensagens (${messages.length}) excede o limite de ${MAX_MESSAGES_PER_REQUEST}`);
        return res.status(400).send();
      }

      console.log(`Requisição POST recebida com ${messages.length} mensagens para envio`);

      const sendPromises = [];
      let currentDelay = 0;
      for (const msg of messages) {
        const { telefone, message } = msg;
        if (!telefone || !message) {
          console.log(`Mensagem inválida ignorada: ${JSON.stringify(msg)}`);
          continue;
        }
        const delay = currentDelay + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
        sendPromises.push(sendMessageWithDelay({ telefone, message }, delay));
        currentDelay = delay;
      }

      res.status(200).send();
      const results = await Promise.all(sendPromises);
      console.log('Resultado do envio:', results);
    } catch (error) {
      console.error('Erro ao processar /send:', error);
      res.status(500).send();
    }
  });
});

// Função para buscar publicações do Datajud
async function fetchDatajudPublications() {
  try {
    const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;
    console.log(`Buscando publicações no Datajud: ${endpoint}`);

    // Exemplo de filtro para buscar publicações recentes (ajuste conforme necessário)
    const requestBody = {
      query: {
        bool: {
          filter: [
            {
              range: {
                dataDistribuicao: {
                  gte: "now-1d/d", // Últimas 24 horas
                  lte: "now-1d/d"
                }
              }
            }
          ]
        }
      },
      size: 100 // Limite de resultados por requisição (ajuste conforme necessário)
    };

    const response = await axios.post(endpoint, requestBody, {
      headers: {
        'Authorization': `APIKey ${DATAJUD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: FETCH_TIMEOUT
    });

    if (response.status !== 200) {
      throw new Error(`Erro na API do Datajud: Status ${response.status}`);
    }

    const publications = response.data.hits.hits.map(hit => hit._source);
    console.log(`Encontradas ${publications.length} publicações`);

    // Enviar os dados ao Make
    const sentToMake = await sendToMake({ publications });
    if (!sentToMake) {
      console.error('Falha ao enviar publicações ao Make');
    }

    return publications;
  } catch (error) {
    console.error('Erro ao buscar publicações do Datajud:', error.message);
    return [];
  }
}

// Rota manual para testar a busca de publicações
app.get('/fetch-publications', async (req, res) => {
  try {
    const publications = await fetchDatajudPublications();
    res.status(200).json({ message: 'Publicações buscadas com sucesso', publications });
  } catch (error) {
    console.error('Erro na rota /fetch-publications:', error.message);
    res.status(500).json({ error: 'Erro ao buscar publicações' });
  }
});

// Agendar busca diária às 8h
cron.schedule('0 8 * * *', async () => {
  console.log('Executando busca diária de publicações do Datajud');
  await fetchDatajudPublications();
}, {
  timezone: 'America/Sao_Paulo'
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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message) return;

    if (msg.key.remoteJid.endsWith('@g.us')) {
      console.log('Mensagem de grupo ignorada:', msg.key.remoteJid);
      return;
    }

    const messageType = Object.keys(msg.message)[0];
    if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;

    const senderNumber = msg.key.remoteJid.split('@')[0];
    const conversationId = msg.key.id;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const senderName = msg.pushName || senderNumber;
    const currentTime = Date.now();

    console.log(`Mensagem recebida de ${senderName} (${senderNumber}): ${text}`);

    const senderData = allowedSenders.get(senderNumber);
    const isAllowed = senderData && (currentTime - senderData.lastMessageTime) < MESSAGE_TIMEOUT;
    const drEliahRegex = /dr\.?\s*eliah/i;
    const containsDrEliah = drEliahRegex.test(text);

    if (!isAllowed && !containsDrEliah) {
      console.log(`Mensagem ignorada: remetente ${senderNumber} não liberado e sem "Dr. Eliah".`);
      return;
    }

    if (containsDrEliah) {
      console.log(`Remetente ${senderNumber} liberado por mencionar "Dr. Eliah".`);
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
      const qrLink = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
      console.log('Link do QR Code:', qrLink);
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

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Ping recebido!');
  res.send('Pong!');
});

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

// Conecta ao WhatsApp
connectToWhatsApp();

// Limpeza de remetentes expirados
const cleanupExpiredSenders = () => {
  const currentTime = Date.now();
  for (const [senderNumber, data] of allowedSenders.entries()) {
    if ((currentTime - data.lastMessageTime) >= MESSAGE_TIMEOUT) {
      console.log(`Remetente ${senderNumber} removido: inativo por mais de 30 minutos.`);
      allowedSenders.delete(senderNumber);
    }
  }
};
setInterval(cleanupExpiredSenders, CLEANUP_INTERVAL);

// Keep-alive
let keepAliveFailures = 0;
const keepAlive = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const response = await fetch(KEEP_ALIVE_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await response.text();
    console.log(`Keep-alive ping: ${text}`);
    keepAliveFailures = 0;
  } catch (error) {
    console.error('Erro no keep-alive:', error);
    keepAliveFailures++;
    if (keepAliveFailures >= 3) {
      console.error('Keep-alive falhou 3 vezes consecutivas.');
    }
  }
};
setInterval(keepAlive, KEEP_ALIVE_INTERVAL);

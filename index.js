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
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjba';
const ADVOCATE_NAME = process.env.ADVOCATE_NAME;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MIN_DELAY = 25_000; // 25 segundos
const MAX_DELAY = 30_000; // 30 segundos
const MAX_MESSAGES_PER_REQUEST = 50;

// Controle de busca de publicações
let publicationCheck = {
  date: null,
  completed: false
};
let isCheckingPublications = false;

// Verificar variáveis de ambiente
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL não definida');
if (!KEEP_ALIVE_URL) throw new Error('KEEP_ALIVE_URL não definida');
if (!DATAJUD_API_KEY) throw new Error('DATAJUD_API_KEY não definida');
if (!ADVOCATE_NAME) throw new Error('ADVOCATE_NAME não definida');

// Armazenamento em memória
const allowedSenders = new Map();

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

// Função para classificar tipo de publicação
function classifyPublicationType(movement) {
  if (!movement) return 'Outros';
  movement = movement.toLowerCase();
  if (movement.includes('intima')) return 'Intimação';
  if (movement.includes('despacho')) return 'Despacho';
  if (movement.includes('decis')) return 'Decisão';
  if (movement.includes('sentença')) return 'Sentença';
  return 'Outros';
}

// Função para buscar publicações com paginação (data fixa: 2025-04-16)
async function fetchDatajudPublications() {
  if (isCheckingPublications) {
    console.log('Busca de publicações já em andamento, ignorando...');
    return [];
  }
  isCheckingPublications = true;

  // Verificar duplicatas
  const currentDate = new Date().toISOString().split('T')[0];
  if (publicationCheck.date !== currentDate) {
    publicationCheck = { date: null, completed: false }; // Reset ao mudar de dia
  }
  if (publicationCheck.completed) {
    console.log('Publicações já enviadas hoje, ignorando busca');
    isCheckingPublications = false;
    return [];
  }

  let allPublications = [];
  let from = 0;
  const size = 10;
  const maxPages = 10; // Limite de segurança
  let page = 0;

  const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;

  try {
    while (page < maxPages) {
      const requestBody = {
        query: {
          bool: {
            filter: [
              {
                range: {
                  dataPublicacao: {
                    gte: '2025-04-16',
                    lte: '2025-04-16'
                  }
                }
              }
            ],
            must: [
              {
                query_string: {
                  query: `"${ADVOCATE_NAME}"`,
                  fields: ['textoPublicacao']
                }
              }
            ]
          }
        },
        from,
        size,
        _source: ['id', 'orgaoJulgador.nome', 'movimentos.nome', 'dataPublicacao', 'grau', 'classeProcessual.nome']
      };

      const response = await axios.post(endpoint, requestBody, {
        headers: {
          'Authorization': `APIKey ${DATAJUD_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: FETCH_TIMEOUT
      });

      if (response.status !== 200) {
        console.error(`Erro na API do Datajud: Status ${response.status}`);
        break;
      }

      const publications = response.data.hits.hits.map(hit => ({
        numeroProcesso: hit._source.id || 'Desconhecido',
        tipoPublicacao: classifyPublicationType(hit._source.movimentos?.nome),
        orgaoJulgador: hit._source.orgaoJulgador?.nome || 'Desconhecido',
        dataPublicacao: hit._source.dataPublicacao || '2025-04-16',
        grau: hit._source.grau || 'Desconhecido',
        classeProcessual: hit._source.classeProcessual?.nome || 'Desconhecida'
      }));

      allPublications.push(...publications);
      console.log(`Página ${page + 1}: ${publications.length} publicações`);

      if (publications.length < size) break; // Fim da paginação
      from += size;
      page++;
    }

    console.log(`Total de publicações encontradas: ${allPublications.length}`);

    // Enviar ao Make
    let allSent = true;
    for (const pub of allPublications) {
      const success = await sendToMake(pub);
      if (!success) {
        console.error(`Falha ao enviar publicação: ${JSON.stringify(pub)}`);
        allSent = false;
      }
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
    }

    // Marcar como concluído se todas foram enviadas
    if (allSent && allPublications.length > 0) {
      publicationCheck = { date: currentDate, completed: true };
    }

    return allPublications;
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

// Rota de teste
app.get('/test-fetch-publications', async (req, res) => {
  try {
    console.log('Iniciando teste de busca de publicações no TJBA para 2025-04-16');
    const publications = await fetchDatajudPublications();
    res.status(200).json({
      message: `Encontradas ${publications.length} publicações para 2025-04-16`,
      publications,
      sentToMake: publicationCheck.completed
    });
  } catch (error) {
    console.error('Erro no teste:', error.message);
    res.status(500).json({ error: 'Erro ao buscar publicações' });
  }
});

// Agendamento: 8h, segunda a sexta
cron.schedule('0 8 * * 1-5', async () => {
  console.log('Verificação inicial às 8h');
  const publications = await fetchDatajudPublications();
  if (publications.length === 0 && !publicationCheck.completed) {
    console.log('Nenhuma publicação, iniciando retries a cada 20 minutos');
    const retryJob = cron.schedule('*/20 * * * 1-5', async () => {
      const retryPublications = await fetchDatajudPublications();
      if (retryPublications.length > 0 || publicationCheck.completed) {
        console.log('Publicações encontradas ou já enviadas, encerrando retries');
        retryJob.stop();
      }
      if (new Date().getHours() >= 17) {
        console.log('Horário limite (17h) atingido, encerrando retries');
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

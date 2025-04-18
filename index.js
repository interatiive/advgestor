const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || `https://advgestor.onrender.com/ping`;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjba'; // Alterado para tjba
const ADVOCATE_NAME = process.env.ADVOCATE_NAME;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const MIN_DELAY = 25_000; // 25 segundos
const MAX_DELAY = 30_000; // 30 segundos
const MAX_MESSAGES_PER_REQUEST = 50;

// Armazenamento
const allowedSenders = new Map();
let publicationCheck = { date: null, completed: false };
let isCheckingPublications = false;
let currentQRCode = null;

// Persistência
const STATE_DIR = path.join(__dirname, 'state');
const ALLOWED_SENDERS_FILE = path.join(STATE_DIR, 'allowed_senders.json');
const PUBLICATION_CHECK_FILE = path.join(STATE_DIR, 'publication_check.json');

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
if (!DATAJUD_API_KEY) throw new Error('DATAJUD_API_KEY não definida');
if (!ADVOCATE_NAME) throw new Error('ADVOCATE_NAME não definida');
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
  try {
    const publicationCheckData = await fs.readFile(PUBLICATION_CHECK_FILE, 'utf8');
    publicationCheck = JSON.parse(publicationCheckData);
    console.log('publicationCheck carregado:', publicationCheck);
  } catch (error) {
    console.log('Nenhum publicationCheck salvo ou erro:', error.message);
  }
}

// Salvar estado
async function saveState() {
  try {
    const allowedSendersObj = Object.fromEntries(allowedSenders);
    await fs.writeFile(ALLOWED_SENDERS_FILE, JSON.stringify(allowedSendersObj, null, 2));
    await fs.writeFile(PUBLICATION_CHECK_FILE, JSON.stringify(publicationCheck, null, 2));
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

// Função para buscar publicações com paginação
async function fetchDatajudPublications(dateRange = { gte: 'now/d', lte: 'now/d' }) {
  if (isCheckingPublications) {
    console.log('Busca de publicações já em andamento, ignorando...');
    return [];
  }
  isCheckingPublications = true;

  const currentDate = new Date().toISOString().split('T')[0];
  if (publicationCheck.date !== currentDate) {
    publicationCheck = { date: null, completed: false };
  }
  if (publicationCheck.completed) {
    console.log('Publicações já enviadas hoje, ignorando busca');
    isCheckingPublications = false;
    return [];
  }

  let allPublications = [];
  let from = 0;
  const size = 10;
  const maxPages = 10;

  const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;

  try {
    while (from < maxPages * size) {
      console.log(`Buscando página ${(from / size) + 1} para data ${dateRange.gte}...`);
      const requestBody = {
        query: {
          bool: {
            filter: [
              {
                range: {
                  dataPublicacao: dateRange
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
        dataPublicacao: hit._source.dataPublicacao || dateRange.gte,
        grau: hit._source.grau || 'Desconhecido',
        classeProcessual: hit._source.classeProcessual?.nome || 'Desconhecida'
      }));

      allPublications.push(...publications);
      console.log(`Página ${(from / size) + 1}: ${publications.length} publicações`);

      if (publications.length < size) break;
      from += size;
    }

    console.log(`Total de publicações encontradas: ${allPublications.length}`);

    let allSent = true;
    for (const pub of allPublications) {
      const success = await sendToMake(pub);
      if (!success) {
        console.error(`Falha ao enviar publicação: ${JSON.stringify(pub)}`);
        allSent = false;
      }
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
    }

    if (allSent && allPublications.length > 0) {
      publicationCheck = { date: currentDate, completed: true };
      console.log('Busca concluída com sucesso, publicationCheck atualizado:', publicationCheck);
      await saveState();
    }

    return allPublications;
  } catch (error) {
    console.error('Erro ao buscar publicações:', error.message);
    return [];
  } finally {
    isCheckingPublications = false;
  }
}

// Rota para testar publicações
app.get('/test-fetch-publications', async (req, res) => {
  console.log('Iniciando teste de busca de publicações para 2025-04-16');
  try {
    const publications = await fetchDatajudPublications({ gte: '2025-04-16', lte: '2025-04-16' });
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
          return res.status(400).json({ error: '"messages" deve ser uma lista' });
        }
        messages = dadosParsed.messages;
      } else if (body.number && body.message) {
        messages = [{ telefone: body.number, message: body.message }];
      } else {
        console.error('Requisição inválida: payload inválido');
        return res.status(400).json({ error: 'Payload inválido' });
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
      res.status(500).json({ error: 'Erro ao processar envio' });
    }
  });
});

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Pong!');
});

// Agendamento: 8h, segunda a sexta
cron.schedule('0 8 * * 1-5', async () => {
  console.log('Iniciando busca automática às 8h (America/Sao_Paulo)');
  try {
    const publications = await fetchDatajudPublications({ gte: 'now/d', lte: 'now/d' });
    console.log(`Busca automática concluída: ${publications.length} publicações encontradas`);
  } catch (error) {
    console.error('Erro na busca automática:', error.message);
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

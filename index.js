const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const exifParser = require('exif-parser');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos em milissegundos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos em milissegundos
const MIN_DELAY = 25_000; // 25 segundos em milissegundos
const MAX_DELAY = 30_000; // 30 segundos em milissegundos
const MAX_MESSAGES_PER_REQUEST = 50; // Limite máximo de mensagens por requisição

// Verificar se o WEBHOOK_URL está definido
if (!WEBHOOK_URL) {
  console.error('Erro: A variável de ambiente WEBHOOK_URL não está definida. Configure-a no Render.');
  process.exit(1);
}

// Verificar se LAWYER_NAME está definido (pra Jusbrasil)
if (!process.env.LAWYER_NAME) {
  console.error('Erro: A variável de ambiente LAWYER_NAME não está definida. Configure-a no Render.');
  process.exit(1);
}

// Armazenamento em memória dos números liberados
const allowedSenders = new Map();

// Middleware pra parsear JSON em rotas que não sejam /send
app.use((req, res, next) => {
  if (req.path === '/send' && req.method === 'POST') {
    return next();
  }
  return express.json()(req, res, next);
});

// Middleware pra URL-encoded (pra /validate-media)
app.use(express.urlencoded({ extended: true }));

// Função para limpar e corrigir JSON
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
    console.error('Erro ao limpar e parsear JSON:', error);
    throw error;
  }
};

// Função para enviar mensagem com delay
const sendMessageWithDelay = async ({ telefone, message }, delay) => {
  return new Promise((resolve) => {
    setTimeout(async () => {
      const cleanNumber = telefone.toString().replace(/[^0-9]/g, '');
      try {
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

// Função para enviar dados pro Make (usada por "Dr. Eliah" e Jusbrasil)
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
        console.log('Dados enviados pro Make com sucesso:', data);
        break;
      } else {
        throw new Error(`Webhook respondeu com status ${response.status}`);
      }
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar pro Make (tentativa ${4 - retries}/3):`, error);
      if (retries === 0) {
        console.error('Falha ao enviar pro Make após 3 tentativas');
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
      }
    }
  }
}

// Rota para enviar mensagens (POST)
app.post('/send', async (req, res) => {
  let rawBody = '';
  req.setEncoding('utf8');
  req.on('data', chunk => rawBody += chunk);

  req.on('end', async () => {
    try {
      // Parsear o corpo bruto
      const body = cleanAndParseJSON(rawBody);

      // Verificar se "dados" existe e parsear o JSON interno
      if (!body.dados) {
        console.error('Requisição inválida: campo "dados" não encontrado');
        return res.status(400).send();
      }

      const dadosParsed = cleanAndParseJSON(body.dados);
      if (!dadosParsed.messages || !Array.isArray(dadosParsed.messages)) {
        console.error('Requisição inválida: "messages" deve ser uma lista dentro de "dados"');
        return res.status(400).send();
      }

      const messages = dadosParsed.messages;
      if (messages.length > MAX_MESSAGES_PER_REQUEST) {
        console.error(`Número de mensagens (${messages.length}) excede o limite de ${MAX_MESSAGES_PER_REQUEST}`);
        return res.status(400).send();
      }

      console.log(`Requisição POST recebida com ${messages.length} mensagens para envio programado`);

      // Programar envio de cada mensagem com delay
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

      // Responder com status 200 sem corpo
      res.status(200).send();

      // Executar os envios em segundo plano e logar os resultados
      const results = await Promise.all(sendPromises);
      console.log('Resultado do envio em massa:', results);
    } catch (error) {
      console.error('Erro ao processar requisição /send:', error);
      res.status(500).send();
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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('Nova mensagem recebida:', messages);

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

    console.log(`Mensagem recebida de ${senderName} (${senderNumber}) - ID da conversa: ${conversationId}: ${text}`);

    const senderData = allowedSenders.get(senderNumber);
    const isAllowed = senderData && (currentTime - senderData.lastMessageTime) < MESSAGE_TIMEOUT;
    const drEliahRegex = /dr\.?\s*eliah/i;
    const containsDrEliah = drEliahRegex.test(text);

    if (!isAllowed && !containsDrEliah) {
      console.log(`Mensagem ignorada: remetente ${senderNumber} não está liberado e mensagem não contém "Dr. Eliah".`);
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
      console.log('Link do QR Code (clique para visualizar):', qrLink);
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

// --- Código do Jusbrasil ---

// Função pra formatar a data atual no formato do Jusbrasil (ex.: "14/04/2025")
function getCurrentDateFormats() {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const year = today.getFullYear();
  return {
    full: `${day}/${month}/${year}`, // Ex.: "14/04/2025"
  };
}

// Função pra construir o link de busca no Jusbrasil
function buildSearchUrl() {
  const lawyerName = process.env.LAWYER_NAME;
  const { full } = getCurrentDateFormats();
  const query = `"${encodeURIComponent(lawyerName)}" "${encodeURIComponent(full)}"`;
  return `https://www.jusbrasil.com.br/diarios/busca?q=${query}&o=data`;
}

// Função pra verificar se a data no título corresponde ao dia atual
function isCurrentDateInTitle(title) {
  const { full } = getCurrentDateFormats();
  return title.includes(full);
}

// Função pra extrair dados de um link do Jusbrasil
async function extractDataFromLink(link) {
  try {
    const response = await axios.get(link);
    const $ = cheerio.load(response.data);

    // Extrair número do processo (ex.: "12345-67.2023.8.05.0001")
    let processNumber = '';
    const processText = $('body').text().match(/\d{5}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
    if (processText) {
      processNumber = processText[0];
    }

    // Extrair vara e comarca (ex.: "2ª Vara Cível – Salvador/BA")
    let court = '';
    let jurisdiction = '';
    const courtText = $('body').text().match(/(\d{1,2}ª?\s*Vara\s*\w*)\s*–\s*(\w+\/\w+)/);
    if (courtText) {
      court = courtText[1].trim();
      jurisdiction = courtText[2].trim();
    }

    // Extrair data (data atual, já que é do dia)
    const date = getCurrentDateFormats().full;

    // Extrair OAB (ex.: "34609")
    let oab = '';
    const oabText = $('body').text().match(/OAB.*?\d{5}/);
    if (oabText) {
      oab = oabText[0].match(/\d{5}/)[0];
    }

    // Se o link não tiver os dados, tenta o trecho (snippet) do resultado
    if (!processNumber || !court || !jurisdiction) {
      const snippet = $('meta[name="description"]').attr('content') || '';
      const snippetProcess = snippet.match(/\d{5}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
      if (snippetProcess) processNumber = snippetProcess[0];
      const snippetCourt = snippet.match(/(\d{1,2}ª?\s*Vara\s*\w*)\s*–\s*(\w+\/\w+)/);
      if (snippetCourt) {
        court = snippetCourt[1].trim();
        jurisdiction = snippetCourt[2].trim();
      }
    }

    return {
      oab: oab || '',
      processNumber: processNumber || '',
      date: date,
      court: court || '',
      jurisdiction: jurisdiction || ''
    };
  } catch (error) {
    console.error(`Erro ao acessar link ${link}: ${error.message}`);
    return {
      oab: '',
      processNumber: '',
      date: getCurrentDateFormats().full,
      court: '',
      jurisdiction: ''
    };
  }
}

// Função principal pra buscar resultados e processar (Jusbrasil)
async function checkJusbrasil() {
  try {
    const url = buildSearchUrl();
    let page = 1;
    let hasResultsForToday = false;
    const linksToProcess = [];

    while (true) {
      const pageUrl = `${url}&page=${page}`;
      const response = await axios.get(pageUrl);
      const $ = cheerio.load(response.data);

      const results = $('.search-result');
      if (results.length === 0) break;

      for (let i = 0; i < results.length; i++) {
        const title = $(results[i]).find('.search-result__title').text();
        if (isCurrentDateInTitle(title)) {
          hasResultsForToday = true;
          const link = $(results[i]).find('a').attr('href');
          if (link) linksToProcess.push(link);
        } else {
          return { stop: true, links: linksToProcess };
        }
      }

      if (!hasResultsForToday) {
        page++;
      } else {
        break;
      }
    }

    return { stop: hasResultsForToday, links: linksToProcess };
  } catch (error) {
    console.error(`Erro ao buscar resultados: ${error.message}`);
    return { stop: false, links: [] };
  }
}

// Função pra rodar a busca no Jusbrasil a cada 20 minutos entre 9h e 18h
function startJusbrasilCheck() {
  cron.schedule('*/20 9-18 * * *', async () => {
    const now = new Date();
    console.log(`[Jusbrasil] Verificando resultados às ${now.toISOString()}`);

    const { stop, links } = await checkJusbrasil();

    if (stop && links.length > 0) {
      console.log(`[Jusbrasil] Encontrados ${links.length} resultados do dia. Processando...`);
      for (const link of links) {
        const data = await extractDataFromLink(link);
        await sendToMake(data);
      }
      console.log('[Jusbrasil] Processamento concluído. Parando até amanhã às 9h.');
    } else if (stop) {
      console.log('[Jusbrasil] Nenhum resultado encontrado, mas data anterior detectada. Parando até amanhã às 9h.');
    } else {
      console.log('[Jusbrasil] Nenhum resultado do dia encontrado. Continuando a busca em 20 minutos.');
    }
  });
}

// --- Código pra validação de mídia ---

// Função pra baixar a imagem
async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// Função pra gerar hash SHA-256
function generateHash(data) {
  return require('crypto').createHash('sha256').update(data).digest('hex');
}

// Função pra extrair metadados EXIF
function extractExif(imageBuffer) {
  try {
    const parser = exifParser.create(imageBuffer);
    const result = parser.parse();
    return {
      date: result.tags.DateTimeOriginal || '',
      make: result.tags.Make || '',
      model: result.tags.Model || '',
      gps: result.tags.GPSLatitude && result.tags.GPSLongitude ? {
        latitude: result.tags.GPSLatitude,
        longitude: result.tags.GPSLongitude
      } : null
    };
  } catch (error) {
    console.error('Erro ao extrair EXIF:', error.message);
    return {};
  }
}

// Função pra verificar clareza da imagem (resolução mínima)
function checkImageClarity(imageBuffer) {
  const { width, height } = require('image-size')(imageBuffer);
  const minResolution = { width: 1280, height: 720 }; // 720p
  return {
    isClear: width >= minResolution.width && height >= minResolution.height,
    resolution: `${width}x${height}`
  };
}

// Função pra adicionar timestamp (usando FreeTSA)
async function addTimestamp(hash) {
  try {
    const form = new FormData();
    form.append('hash', hash);
    form.append('hash_algorithm', 'sha256');
    const response = await axios.post('https://freetsa.org/tsr', form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer'
    });
    const timestamp = response.headers['date'];
    return { timestamp, tsr: Buffer.from(response.data).toString('base64') };
  } catch (error) {
    console.error('Erro ao adicionar timestamp:', error.message);
    return { timestamp: new Date().toISOString(), tsr: null };
  }
}

// Função pra registrar na blockchain (usando OpenTimestamps)
async function registerOnBlockchain(hash) {
  try {
    const form = new FormData();
    form.append('hash', hash);
    form.append('type', 'sha256');
    const response = await axios.post('https://opentimestamps.org/api/stamp', form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    console.error('Erro ao registrar na blockchain:', error.message);
    return null;
  }
}

// Função auxiliar pra processar uma única imagem
async function processSingleImage(imageUrl, uploaderName, uploaderDocument, uploadTimestamp) {
  console.log(`[Validate-Media] Processando imagem: ${imageUrl}`);

  // Cadeia de custódia
  const chainOfCustody = [
    { step: 'Upload pelo cliente', who: uploaderName, when: uploadTimestamp },
    { step: 'Recebido pelo Make', who: 'Make Workflow', when: new Date().toISOString() },
    { step: 'Processado pelo Render', who: 'Render Server', when: new Date().toISOString() }
  ];

  // Baixar a imagem
  const imageBuffer = await downloadImage(imageUrl);

  // Gerar hash
  const hash = generateHash(imageBuffer);
  console.log(`[Validate-Media] Hash gerado: ${hash}`);

  // Extrair metadados EXIF
  const exif = extractExif(imageBuffer);
  console.log(`[Validate-Media] Metadados EXIF:`, exif);

  // Verificar clareza
  const clarity = checkImageClarity(imageBuffer);
  console.log(`[Validate-Media] Clareza da imagem:`, clarity);

  // Adicionar timestamp
  const { timestamp, tsr } = await addTimestamp(hash);
  console.log(`[Validate-Media] Timestamp adicionado: ${timestamp}`);

  // Registrar na blockchain
  const blockchainProof = await registerOnBlockchain(hash);
  console.log(`[Validate-Media] Blockchain proof: ${blockchainProof ? 'Gerado' : 'Falhou'}`);

  // Autenticação da origem
  const origin = {
    uploader: uploaderName,
    uploaderDocument: uploaderDocument,
    uploadTimestamp: uploadTimestamp,
    deviceInfo: exif.make && exif.model ? `${exif.make} ${exif.model}` : 'Desconhecido'
  };

  return {
    originalUrl: imageUrl,
    hash,
    exif,
    clarity,
    timestamp,
    timestampProof: tsr,
    blockchainProof,
    chainOfCustody,
    origin
  };
}

// Rota pra validar mídia
app.post('/validate-media', async (req, res) => {
  try {
    const { imageUrls, uploaderName, uploaderDocument, uploadTimestamp, uploaderEmail } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'imageUrls é obrigatório e deve ser uma lista não vazia' });
    }
    if (!uploaderName || !uploaderDocument || !uploadTimestamp || !uploaderEmail) {
      return res.status(400).json({ error: 'uploaderName, uploaderDocument, uploadTimestamp e uploaderEmail são obrigatórios' });
    }

    console.log(`[Validate-Media] Processando ${imageUrls.length} imagens`);

    // Processar cada imagem em paralelo
    const results = await Promise.all(
      imageUrls.map(url => processSingleImage(url, uploaderName, uploaderDocument, uploadTimestamp))
    );

    res.json({ images: results, uploaderEmail });
  } catch (error) {
    console.error('[Validate-Media] Erro ao processar imagens:', error.message);
    res.status(500).json({ error: 'Erro ao processar imagens' });
  }
});

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

// Conecta ao WhatsApp
connectToWhatsApp();

// Inicia a busca no Jusbrasil
startJusbrasilCheck();
console.log('[Jusbrasil] Script iniciado. Aguardando 9h pra começar a busca.');

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

setInterval(cleanupExpiredSenders, CLEANUP_INTERVAL);

// Função para "pingar" a si mesmo
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

setInterval(keepAlive, KEEP_ALIVE_INTERVAL);

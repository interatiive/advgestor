const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const exifParser = require('exif-parser');
const FormData = require('form-data');
const OpenTimestamps = require('opentimestamps');
const asn1js = require('asn1js');
const pkijs = require('pkijs');
const crypto = require('crypto');

// Configurar pkijs
const { TimeStampReq, MessageImprint, TimeStampResp } = pkijs;

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

// Função para enviar dados pro Make (usada por "Dr. Eliah")
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

// --- Código pra validação de mídia ---

// Função pra baixar a imagem
async function downloadImage(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.wix.com'
      }
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Erro ao baixar a imagem ${url}:`, error.message);
    throw new Error(`Falha ao baixar a imagem: ${error.message}`);
  }
}

// Função pra gerar hash SHA-256
function generateHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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
  try {
    const { width, height } = require('image-size')(imageBuffer);
    const minResolution = { width: 1280, height: 720 }; // 720p
    return {
      isClear: width >= minResolution.width && height >= minResolution.height,
      resolution: `${width}x${height}`
    };
  } catch (error) {
    console.error('Erro ao verificar clareza da imagem:', error.message);
    return { isClear: false, resolution: 'Desconhecida' };
  }
}

// Função pra criar uma requisição de timestamp query (RFC 3161)
function createTimestampQuery(hash) {
  const hashBuffer = Buffer.from(hash, 'hex');
  const messageImprint = new MessageImprint({
    hashAlgorithm: { algorithm: '2.16.840.1.101.3.4.2.1' }, // SHA-256 OID
    hashedMessage: new asn1js.OctetString({ valueHex: hashBuffer })
  });

  const tsr = new TimeStampReq({
    version: 1,
    messageImprint,
    certReq: true
  });

  return Buffer.from(tsr.toSchema().toBER(false));
}

// Função pra adicionar timestamp (usando Sectigo TSA)
async function addTimestamp(hash) {
  try {
    const tsQuery = createTimestampQuery(hash);
    const response = await axios.post('http://timestamp.sectigo.com', tsQuery, {
      headers: {
        'Content-Type': 'application/timestamp-query',
        'Accept': 'application/timestamp-reply'
      },
      responseType: 'arraybuffer'
    });

    const tsRespBuffer = Buffer.from(response.data);
    const asn1Resp = asn1js.fromBER(tsRespBuffer);
    const tsResp = new TimeStampResp({ schema: asn1Resp.result });

    const tstInfo = tsResp.timeStampToken.tstInfo;
    const timestamp = tstInfo.genTime.toISOString();
    const tsr = tsRespBuffer.toString('base64');

    return { timestamp, tsr };
  } catch (error) {
    console.error('Erro ao adicionar timestamp:', error.message);
    return { timestamp: new Date().toISOString(), tsr: null };
  }
}

// Função pra registrar na blockchain (usando OpenTimestamps)
async function registerOnBlockchain(hash) {
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const otsStamp = await OpenTimestamps.stamp(hashBuffer);
    const timestampProof = Buffer.from(otsStamp).toString('base64');
    return timestampProof;
  } catch (error) {
    console.error('Erro ao registrar na blockchain:', error.message);
    return null;
  }
}

// Função auxiliar pra processar uma única imagem
async function processSingleImage(imageUrl) {
  console.log(`[Validate-Media] Processando imagem: ${imageUrl}`);

  // Cadeia de custódia
  const chainOfCustody = [
    { step: 'Upload pelo cliente', who: 'Cliente via Wix', when: new Date().toISOString() },
    { step: 'Recebido pelo Make', who: 'Make Workflow', when: new Date().toISOString() },
    { step: 'Processado pelo Render', who: 'Render Server', when: new Date().toISOString() }
  ];

  try {
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
      uploader: 'Cliente via Wix',
      uploaderDocument: 'Não fornecido',
      uploadTimestamp: new Date().toISOString(),
      deviceInfo: exif.make && exif.model ? `${exif.make} ${exif.model}` : 'Desconhecido'
    };

    return {
      success: true,
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
  } catch (error) {
    console.error(`[Validate-Media] Erro ao processar imagem ${imageUrl}:`, error.message);
    return {
      success: false,
      originalUrl: imageUrl,
      error: error.message
    };
  }
}

// Rota pra validar mídia
app.post('/validate-media', async (req, res) => {
  try {
    let { imageUrls } = req.body;

    console.log(`[Validate-Media] Recebido imageUrls: ${imageUrls}`);

    // Verificar se imageUrls é uma string e convertê-la em array, se necessário
    if (typeof imageUrls === 'string') {
      imageUrls = imageUrls.split(/,\s*/).map(url => url.trim());
      console.log(`[Validate-Media] Após split:`, imageUrls);
    }

    // Validar se imageUrls é um array e não está vazio
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'imageUrls é obrigatório e deve ser uma lista não vazia' });
    }

    console.log(`[Validate-Media] Processando ${imageUrls.length} imagens`);

    // Processar cada imagem em paralelo
    const results = await Promise.all(
      imageUrls.map(url => processSingleImage(url))
    );

    // Separar resultados bem-sucedidos de falhas
    const successfulResults = results.filter(result => result.success);
    const failedResults = results.filter(result => !result.success);

    if (successfulResults.length === 0) {
      return res.status(500).json({
        error: 'Nenhuma imagem pôde ser processada',
        failed: failedResults
      });
    }

    res.json({
      images: successfulResults,
      failed: failedResults.length > 0 ? failedResults : undefined
    });
  } catch (error) {
    console.error('[Validate-Media] Erro ao processar imagens:', error.message);
    res.status(500).json({ error: 'Erro ao processar imagens', details: error.message });
  }
});

// Middleware para tratamento de erros
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Erro de parsing JSON:', err.message);
    return res.status(400).json({ error: 'Corpo da requisição não é um JSON válido' });
  }
  next();
});

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

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const ExifReader = require('exifreader');
const FormData = require('form-data');
const { PNG } = require('pngjs');
const crypto = require('crypto');

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

// Função pra extrair metadados EXIF e PNG usando exifreader e pngjs
function extractExif(imageBuffer) {
  try {
    const tags = ExifReader.load(imageBuffer);
    console.log(`[Validate-Media] Tags EXIF brutas:`, tags);

    // Converter coordenadas DMS para decimal, se disponíveis
    const getGpsCoordinate = (value, ref) => {
      if (!value || !ref) return null;
      const degrees = value[0].numerator / value[0].denominator;
      const minutes = value[1].numerator / value[1].denominator;
      const seconds = value[2].numerator / value[2].denominator;
      let decimal = degrees + (minutes / 60) + (seconds / 3600);
      if (ref === 'S' || ref === 'W') decimal = -decimal;
      return decimal;
    };

    // Tentar extrair metadados EXIF padrão
    const gpsLatitude = tags['GPSLatitude'] && tags['GPSLatitudeRef']
      ? getGpsCoordinate(tags['GPSLatitude'].value, tags['GPSLatitudeRef'].description)
      : null;
    const gpsLongitude = tags['GPSLongitude'] && tags['GPSLongitudeRef']
      ? getGpsCoordinate(tags['GPSLongitude'].value, tags['GPSLongitudeRef'].description)
      : null;

    let exifData = {
      createDate: null, // Inicialmente nulo
      make: tags['Make']?.description || '',
      model: tags['Model']?.description || '',
      gps: gpsLatitude && gpsLongitude ? {
        latitude: gpsLatitude,
        longitude: gpsLongitude
      } : null
    };

    // Prioridade para createDate: EXIF DateTimeOriginal > EXIF DateTime
    if (tags['DateTimeOriginal']?.description) {
      exifData.createDate = tags['DateTimeOriginal'].description;
    } else if (tags['DateTime']?.description) {
      exifData.createDate = tags['DateTime'].description;
    }

    // Se for uma imagem PNG ou não houver createDate em EXIF, tentar extrair metadados PNG
    if (!exifData.createDate || tags['FileType']?.value === 'png') {
      console.log('[Validate-Media] Imagem PNG ou sem createDate EXIF. Tentando extrair metadados PNG...');
      
      // Verificar se é uma imagem PNG válida
      const isPng = imageBuffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; // Assinatura PNG
      if (isPng) {
        try {
          // Usar pngjs para ler a imagem e extrair chunks
          const png = new PNG();
          const chunks = [];

          // Parsear a imagem e coletar chunks
          png.parse(imageBuffer, (err) => {
            if (err) {
              console.error('[Validate-Media] Erro ao parsear PNG:', err.message);
              return;
            }
          });

          // Capturar chunks usando eventos do parser
          const parser = new PNG();
          parser.on('metadata', (metadata) => {
            // Metadados básicos (largura, altura, etc.) não são necessários aqui
          });
          parser.on('parsed', () => {
            // Não usamos os dados de pixel, apenas os chunks
          });
          parser.on('error', (err) => {
            console.error('[Validate-Media] Erro ao parsear PNG:', err.message);
          });

          // Ler os chunks manualmente usando um parser de chunks
          const chunkData = [];
          let offset = 8; // Pular a assinatura PNG
          while (offset < imageBuffer.length) {
            const length = imageBuffer.readUInt32BE(offset);
            const type = imageBuffer.slice(offset + 4, offset + 8).toString();
            const data = imageBuffer.slice(offset + 8, offset + 8 + length);
            chunkData.push({ name: type, data });
            offset += 12 + length; // 4 bytes length + 4 bytes type + data + 4 bytes CRC
          }

          // Procurar por tIME (data de modificação)
          const timeChunk = chunkData.find(chunk => chunk.name === 'tIME');
          if (timeChunk) {
            const data = timeChunk.data;
            const year = data.readUInt16BE(0);
            const month = data.readUInt8(2);
            const day = data.readUInt8(3);
            const hour = data.readUInt8(4);
            const minute = data.readUInt8(5);
            const second = data.readUInt8(6);
            const tIME = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`;
            exifData.createDate = exifData.createDate || tIME;
          }

          // Procurar por Creation Time em tEXt ou iTXt
          const textChunks = chunkData.filter(chunk => chunk.name === 'tEXt' || chunk.name === 'iTXt');
          const creationTimeChunk = textChunks.find(chunk => {
            const text = chunk.data.toString('utf8');
            return text.includes('Creation Time');
          });
          if (creationTimeChunk) {
            const text = creationTimeChunk.data.toString('utf8');
            const creationTime = text.split('Creation Time\0')[1];
            exifData.createDate = creationTime; // Prioridade para Creation Time
          }

          console.log('[Validate-Media] Metadados PNG extraídos:', { createDate: exifData.createDate });
        } catch (error) {
          console.error('[Validate-Media] Erro ao extrair metadados PNG:', error.message);
        }
      } else {
        console.log('[Validate-Media] Imagem não é PNG, pulando extração de metadados PNG.');
      }
    }

    // Tentar extrair metadados XMP, se disponíveis
    if (!exifData.createDate && tags['XMP']) {
      const xmpData = tags['XMP'].description;
      console.log('[Validate-Media] Dados XMP encontrados:', xmpData);
      const xmpDateMatch = xmpData.match(/<xmp:CreateDate>(.*?)<\/xmp:CreateDate>/);
      const xmpCreatorMatch = xmpData.match(/<dc:creator>(.*?)<\/dc:creator>/);
      if (xmpDateMatch) exifData.createDate = xmpDateMatch[1];
      if (xmpCreatorMatch) exifData.make = xmpCreatorMatch[1] || exifData.make;
    }

    // Se createDate ainda estiver vazio, usar campos de texto alternativos
    if (!exifData.createDate) {
      const textFields = {};
      for (const key in tags) {
        if (key.startsWith('TextEntry_')) {
          const textKey = tags[key].keyword || key;
          const textValue = tags[key].value || '';
          textFields[textKey] = textValue;
        }
      }
      console.log('[Validate-Media] Campos de texto PNG (tEXt/iTXt):', textFields);
      exifData.createDate = textFields['Creation Time'] || textFields['Date'] || '';
    }

    return exifData;
  } catch (error) {
    console.error('Erro ao extrair EXIF:', error.message);
    return { createDate: '', make: '', model: '', gps: null };
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

    // Extrair metadados EXIF e PNG
    const exif = extractExif(imageBuffer);
    console.log(`[Validate-Media] Metadados EXIF/PNG:`, exif);

    // Verificar clareza
    const clarity = checkImageClarity(imageBuffer);
    console.log(`[Validate-Media] Clareza da imagem:`, clarity);

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

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { PNG } = require('pngjs');
const crypto = require('crypto');
const { exiftool } = require('exiftool-vendored');
const ExifReader = require('exifreader');

const app = express();
const port = process.env.PORT || 3000;

// Verificar se o módulo crypto está disponível
console.log('Módulo crypto carregado:', typeof crypto !== 'undefined' ? 'Sim' : 'Não');

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const FETCH_TIMEOUT = 10_000; // 10 segundos
const MESSAGE_TIMEOUT = 30 * 60 * 1000; // 30 minutos em milissegundos
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos em milissegundos
const MIN_DELAY = 25_000; // 25 segundos em milissegundos
const MAX_DELAY = 30_000; // 30 segundos em milissegundos
const MAX_MESSAGES_PER_REQUEST = 50; // Limite máximo de mensagens por requisição

// Verificar se as variáveis de ambiente estão definidas
if (!WEBHOOK_URL) {
  console.error('Erro: A variável de ambiente WEBHOOK_URL não está definida. Configure-a no Render.');
  process.exit(1);
}

if (!KEEP_ALIVE_URL) {
  console.error('Erro: A variável de ambiente KEEP_ALIVE_URL não está definida. Configure-a no Render.');
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

// Função para enviar dados pro Make (usada por "Dr. Eliah" e pela rota /validate-media)
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
        return true;
      } else {
        throw new Error(`Webhook respondeu com status ${response.status}`);
      }
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar pro Make (tentativa ${4 - retries}/3):`, error);
      if (retries === 0) {
        console.error('Falha ao enviar pro Make após 3 tentativas');
        return false;
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
      }
    }
  }
  return false;
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

      let messages = [];

      // Verificar se o payload contém "dados" (formato antigo)
      if (body.dados) {
        const dadosParsed = cleanAndParseJSON(body.dados);
        if (!dadosParsed.messages || !Array.isArray(dadosParsed.messages)) {
          console.error('Requisição inválida: "messages" deve ser uma lista dentro de "dados"');
          return res.status(400).send();
        }
        messages = dadosParsed.messages;
      }
      // Verificar se o payload contém "number" e "message" diretamente (novo formato do Make)
      else if (body.number && body.message) {
        messages = [{ telefone: body.number, message: body.message }];
      }
      else {
        console.error('Requisição inválida: o payload deve conter "dados" ou os campos "number" e "message"');
        return res.status(400).send();
      }

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

// Função pra determinar a extensão do arquivo com base no tipo de imagem
function getFileExtension(imageBuffer) {
  const signatures = {
    '89504e470d0a1a0a': 'png', // PNG
    'ffd8ff': 'jpg', // JPEG
    '6674797068656963': 'heic', // HEIC (ftypheic)
    '47494638': 'gif', // GIF
    '52494646': 'webp' // WEBP (RIFF)
  };

  const header = imageBuffer.slice(0, 8).toString('hex');
  for (const [signature, ext] of Object.entries(signatures)) {
    if (header.startsWith(signature)) {
      return ext;
    }
  }
  return 'unknown'; // Extensão padrão se o tipo não for identificado
}

// Função pra extrair metadados EXIF usando exiftool-vendored e exifreader como fallback
async function extractExif(imageBuffer) {
  let exifData = {
    createDate: '',
    make: '',
    model: '',
    software: '',
    dateTimeOriginal: '',
    mccData: '',
    gps: null,
    warning: null
  };

  // Determinar a extensão correta do arquivo temporário
  const fileExt = getFileExtension(imageBuffer);
  const tempFilePath = path.join(__dirname, `temp-${Date.now()}.${fileExt}`);

  try {
    // Salvar o buffer temporariamente em um arquivo para usar com exiftool
    await fs.writeFile(tempFilePath, imageBuffer);

    // Extrair metadados com exiftool-vendored
    const tags = await exiftool.read(tempFilePath);
    console.log(`[Validate-Media] Tags brutas extraídas com exiftool:`, tags);

    // Converter coordenadas DMS para decimal, se disponíveis
    const getGpsCoordinate = (value, ref) => {
      if (!value || !ref) return null;
      const degreesMatch = value.match(/(\d+)\s*deg/);
      const minutesMatch = value.match(/(\d+\.?\d*)\s*'/);
      const secondsMatch = value.match(/(\d+\.?\d*)\s*"/);
      const degrees = degreesMatch ? parseFloat(degreesMatch[1]) : 0;
      const minutes = minutesMatch ? parseFloat(minutesMatch[1]) : 0;
      const seconds = secondsMatch ? parseFloat(secondsMatch[1]) : 0;
      let decimal = degrees + (minutes / 60) + (seconds / 3600);
      if (ref === 'S' || ref === 'W') decimal = -decimal;
      return decimal;
    };

    // Tentar extrair metadados padrão com exiftool
    const gpsLatitude = tags.GPSLatitude && tags.GPSLatitudeRef
      ? getGpsCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef)
      : null;
    const gpsLongitude = tags.GPSLongitude && tags.GPSLongitudeRef
      ? getGpsCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef)
      : null;

    exifData.make = tags.Make || '';
    exifData.model = tags.Model || '';
    exifData.software = tags.Software || '';
    exifData.dateTimeOriginal = tags.DateTimeOriginal || '';
    exifData.mccData = tags.MCCData || '';
    exifData.gps = gpsLatitude && gpsLongitude ? {
      latitude: gpsLatitude,
      longitude: gpsLongitude
    } : null;

    // Prioridade para createDate: DateTimeOriginal > CreateDate
    if (tags.DateTimeOriginal) {
      exifData.createDate = tags.DateTimeOriginal;
    } else if (tags.CreateDate) {
      exifData.createDate = tags.CreateDate;
    }
  } catch (error) {
    console.error('Erro ao extrair metadados com exiftool:', error.message);
    exifData.warning = `Erro ao extrair metadados com exiftool: ${error.message}`;
  } finally {
    // Limpar o arquivo temporário
    try {
      await fs.unlink(tempFilePath);
    } catch (error) {
      console.error(`Erro ao deletar arquivo temporário ${tempFilePath}:`, error.message);
    }
  }

  // Verificar se os metadados principais estão vazios
  let hasUsefulMetadata = exifData.createDate || exifData.make || exifData.model || exifData.software || exifData.dateTimeOriginal || exifData.gps;

  // Se não houver metadados úteis ou se houve erro no exiftool, tentar com exifreader
  if (!hasUsefulMetadata || exifData.warning) {
    console.log('[Validate-Media] Tentando extrair metadados com exifreader...');
    try {
      const exifReaderTags = await ExifReader.load(imageBuffer);
      console.log('[Validate-Media] Tags brutas extraídas com exifreader:', exifReaderTags);

      exifData.make = exifReaderTags['Make']?.description || exifData.make;
      exifData.model = exifReaderTags['Model']?.description || exifData.model;
      exifData.software = exifReaderTags['Software']?.description || exifData.software;
      exifData.dateTimeOriginal = exifReaderTags['DateTimeOriginal']?.description || exifData.dateTimeOriginal;
      exifData.createDate = exifReaderTags['DateTimeOriginal']?.description || exifData.createDate;

      const gpsLat = exifReaderTags['GPSLatitude']?.description;
      const gpsLatRef = exifReaderTags['GPSLatitudeRef']?.description;
      const gpsLon = exifReaderTags['GPSLongitude']?.description;
      const gpsLonRef = exifReaderTags['GPSLongitudeRef']?.description;
      if (gpsLat && gpsLatRef && gpsLon && gpsLonRef) {
        const lat = parseFloat(gpsLat);
        const lon = parseFloat(gpsLon);
        exifData.gps = {
          latitude: gpsLatRef === 'S' ? -lat : lat,
          longitude: gpsLonRef === 'W' ? -lon : lon
        };
      }
    } catch (error) {
      console.error('[Validate-Media] Erro ao extrair metadados com exifreader:', error.message);
      exifData.warning = exifData.warning
        ? `${exifData.warning} | Erro com exifreader: ${error.message}`
        : `Erro ao extrair metadados com exifreader: ${error.message}`;
    }
  }

  // Verificar novamente se há metadados úteis
  hasUsefulMetadata = exifData.createDate || exifData.make || exifData.model || exifData.software || exifData.dateTimeOriginal || exifData.gps;
  if (!hasUsefulMetadata && !exifData.warning) {
    console.log('[Validate-Media] Aviso: Nenhum metadado útil encontrado na imagem (ex.: createDate, make, model, gps).');
    exifData.warning = 'Nenhum metadado útil encontrado na imagem (ex.: data de criação, fabricante, modelo, localização). A imagem pode ter sido processada ou não contém metadados EXIF.';
  }

  // Se for uma imagem PNG, tentar extrair metadados PNG adicionais
  const isPng = imageBuffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a'; // Assinatura PNG
  if (isPng) {
    console.log('[Validate-Media] Imagem PNG detectada. Tentando extrair metadados PNG...');
    try {
      const png = new PNG();
      const chunks = [];

      // Parsear a imagem e coletar chunks
      png.parse(imageBuffer, (err) => {
        if (err) {
          console.error('[Validate-Media] Erro ao parsear PNG:', err.message);
          return;
        }
      });

      // Ler os chunks manualmente
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
  }

  return exifData;
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

    // Extrair metadados EXIF e outros
    const exif = await extractExif(imageBuffer);
    console.log(`[Validate-Media] Metadados extraídos:`, exif);

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
      const responseData = {
        error: 'Nenhuma imagem pôde ser processada',
        failed: failedResults
      };
      // Enviar para o Make mesmo em caso de falha total
      await sendToMake(responseData);
      return res.status(500).json(responseData);
    }

    // Preparar o JSON de resposta
    const responseData = {
      images: successfulResults,
      failed: failedResults.length > 0 ? failedResults : undefined
    };

    // Enviar o resultado para o Make
    const sentToMake = await sendToMake(responseData);
    if (!sentToMake) {
      console.error('[Validate-Media] Falha ao enviar resultado para o Make');
      return res.status(500).json({ error: 'Erro ao enviar resultado para o Make' });
    }

    // Responder ao cliente
    res.status(200).json({ message: 'Imagens processadas e resultado enviado ao Make com sucesso' });
  } catch (error) {
    console.error('[Validate-Media] Erro ao processar imagens:', error.message);
    const errorResponse = { error: 'Erro ao processar imagens', details: error.message };
    // Enviar erro para o Make
    await sendToMake(errorResponse);
    res.status(500).json(errorResponse);
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
const server = app.listen(port, '0.0.0.0', () => {
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
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const response = await fetch(KEEP_ALIVE_URL, { signal: controller.signal });
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

// Encerrar o exiftool quando o servidor for desligado
process.on('SIGINT', async () => {
  console.log('Encerrando o servidor e o exiftool...');
  await exiftool.end();
  server.close(() => {
    console.log('Servidor encerrado.');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('Encerrando o servidor e o exiftool...');
  await exiftool.end();
  server.close(() => {
    console.log('Servidor encerrado.');
    process.exit(0);
  });
});

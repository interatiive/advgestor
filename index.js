const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fetch = require('node-fetch');
const qrcode = require('qrcode');
const { whisper } = require('whisper-node');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

const app = express();

// Middleware para logar o corpo bruto da requisição antes do parsing
app.use(express.raw({ type: '*/*' }), (req, res, next) => {
  if (req.body && req.body.length > 0) {
    console.log('Corpo bruto da requisição recebido:', req.body.toString());
  } else {
    console.log('Corpo bruto da requisição vazio.');
  }
  // Reinterpreta o corpo como JSON
  if (req.headers['content-type']?.includes('application/json')) {
    try {
      req.body = JSON.parse(req.body.toString());
    } catch (error) {
      console.error('Erro ao parsear JSON:', error.message);
      return res.status(400).json({ error: 'JSON inválido: ' + error.message });
    }
  }
  next();
});

app.use(cors());

// Obtém o hostname do Render dinamicamente
const HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:3000';
const PROTOCOL = HOSTNAME.includes('localhost') ? 'http' : 'https';
const QR_CODE_URL = `${PROTOCOL}://${HOSTNAME}/qrcode`;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let qrCodeData = null;
let isClientReady = false;
let lastQrGenerationTime = 0; // Timestamp da última geração de QR code
const QR_CODE_EXPIRY = 2 * 60 * 1000; // 2 minutos de validade para o QR code
const contactsWithDoctor = new Map();

// Função para converter áudio para formato WAV (necessário para Whisper)
async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('wav')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// Função para transcrever áudio
async function transcribeAudio(audioPath) {
  try {
    const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');
    await convertToWav(audioPath, wavPath);
    const transcript = await whisper(wavPath, {
      modelName: 'base', // Modelo leve do Whisper
      language: 'pt' // Define o idioma como português
    });
    fs.unlinkSync(audioPath); // Remove o arquivo original
    fs.unlinkSync(wavPath); // Remove o arquivo WAV temporário
    return transcript.map(segment => segment.text).join(' ');
  } catch (error) {
    console.error('Erro ao transcrever áudio:', error);
    return null;
  }
}

// Função para inicializar o cliente com retentativas
async function initializeClient() {
  try {
    client.on('qr', (qr) => {
      const now = Date.now();
      if (now - lastQrGenerationTime > QR_CODE_EXPIRY || !qrCodeData) {
        qrCodeData = qr;
        lastQrGenerationTime = now;
        console.log(`Novo QR Code gerado! Acesse o QR code em: ${QR_CODE_URL}`);
      } else {
        console.log('QR Code recente ainda válido, ignorando novo evento.');
      }
    });

    client.on('ready', () => {
      isClientReady = true;
      qrCodeData = null; // Limpa o QR code após a conexão
      lastQrGenerationTime = 0;
      console.log('Cliente WhatsApp-Web.js pronto!');
    });

    client.on('authenticated', () => {
      console.log('Cliente autenticado com sucesso!');
    });

    client.on('auth_failure', (msg) => {
      console.error('Falha na autenticação:', msg);
      isClientReady = false;
      qrCodeData = null;
      lastQrGenerationTime = 0;
    });

    client.on('disconnected', (reason) => {
      console.log('Cliente desconectado:', reason);
      isClientReady = false;
      qrCodeData = null;
      lastQrGenerationTime = 0;
      setTimeout(initializeClient, 20000); // Tenta reconectar após 20 segundos
    });

    client.on('message', async (message) => {
      console.log('Mensagem recebida:', { from: message.from, type: message.type, body: message.body });

      let messageBody = message.body ? message.body.toLowerCase() : '';

      // Verifica se a mensagem é um áudio
      if (message.type === 'ptt' || message.type === 'audio') {
        try {
          const media = await message.downloadMedia();
          if (media) {
            const audioPath = path.join(__dirname, `audio-${Date.now()}.ogg`);
            fs.writeFileSync(audioPath, Buffer.from(media.data, 'base64'));
            const transcript = await transcribeAudio(audioPath);
            if (transcript) {
              console.log('Áudio transcrito:', transcript);
              messageBody = transcript.toLowerCase();
            } else {
              console.log('Falha ao transcrever áudio.');
            }
          }
        } catch (error) {
          console.error('Erro ao processar áudio:', error);
        }
      }

      const doctorVariations = ['dr. eliah', 'dr eliah', 'doutor eliah', 'dr.eliah'];
      if (messageBody && doctorVariations.some(variation => messageBody.includes(variation))) {
        const contactId = message.from;
        contactsWithDoctor.set(contactId, Date.now());
        console.log(`Mensagem com "Dr. Eliah" detectada de ${contactId}`);

        try {
          const response = await fetch('https://hook.us1.make.com/replace_with_your_make_webhook_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId, message: messageBody })
          });
          console.log('Webhook enviado:', response.status);
        } catch (error) {
          console.error('Erro ao enviar webhook:', error);
        }
      }
    });

    console.log('Inicializando cliente WhatsApp...');
    await client.initialize();
  } catch (error) {
    console.error('Erro ao inicializar cliente WhatsApp:', error);
    setTimeout(initializeClient, 20000); // Tenta novamente após 20 segundos
  }
}

initializeClient();

// Limpeza de contatos inativos
setInterval(() => {
  const now = Date.now();
  for (const [contactId, timestamp] of contactsWithDoctor) {
    if (now - timestamp > 30 * 60 * 1000) {
      contactsWithDoctor.delete(contactId);
      console.log(`Contato ${contactId} removido da memória após 30 minutos.`);
    }
  }
}, 10 * 60 * 1000);

app.get('/', (req, res) => {
  console.log('Requisição recebida no endpoint / (keep-alive)', { ip: req.ip, timestamp: new Date().toISOString() });
  res.json({ message: 'Servidor rodando' });
});

app.get('/qrcode', async (req, res) => {
  console.log('Rota /qrcode acessada. Estado atual:', { isClientReady, qrCodeDataAvailable: !!qrCodeData });

  if (isClientReady) {
    console.log('Cliente já está conectado, QR code não é necessário.');
    return res.status(200).json({ message: 'Cliente já está conectado ao WhatsApp.' });
  }

  const now = Date.now();
  if (!qrCodeData || (now - lastQrGenerationTime > QR_CODE_EXPIRY)) {
    console.log('QR Code expirado ou não disponível. Aguardando novo QR code...');
    qrCodeData = null; // Força a geração de um novo QR code
    lastQrGenerationTime = 0;
    return res.status(500).json({ error: 'QR Code não disponível ou expirado. Aguarde um novo QR code.' });
  }

  try {
    console.log('Gerando imagem do QR Code...');
    const qrCodeImage = await qrcode.toDataURL(qrCodeData);
    console.log('Imagem do QR Code gerada com sucesso.');
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(qrCodeImage.split(',')[1], 'base64'));
  } catch (error) {
    console.error('Erro ao gerar imagem do QR Code:', error);
    res.status(500).json({ error: 'Erro ao gerar imagem do QR Code' });
  }
});

app.post('/send', async (req, res) => {
  console.log('Requisição recebida na rota /send. Corpo da requisição:', req.body);

  if (!isClientReady) {
    console.log('Cliente WhatsApp não está pronto.');
    return res.status(500).json({ error: 'Cliente WhatsApp não está pronto' });
  }

  let messages = [];

  try {
    if (req.body.dados && req.body.cobranca) {
      messages = req.body.dados.map(item => ({
        number: item['Telefone para Envio'],
        message: req.body.cobranca
      }));
    } else if (Array.isArray(req.body)) {
      messages = req.body;
    } else {
      console.log('Formato de requisição inválido:', req.body);
      return res.status(400).json({ error: 'Formato de requisição inválido' });
    }
  } catch (error) {
    console.error('Erro ao processar corpo da requisição:', error);
    return res.status(400).json({ error: 'Erro ao processar corpo da requisição: JSON inválido' });
  }

  try {
    for (const msg of messages) {
      const phoneNumber = msg.number.replace(/\D/g, '');
      const chatId = `${phoneNumber}@c.us`;
      console.log(`Tentando enviar mensagem para ${chatId}: ${msg.message}`);
      await client.sendMessage(chatId, msg.message);
      console.log(`Mensagem enviada para ${phoneNumber}`);
      const delay = Math.floor(Math.random() * (30000 - 25000 + 1)) + 25000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    res.json({ success: true, message: 'Mensagens enviadas com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar mensagens:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagens' });
  }
});

app.listen(3000, () => {
  console.log('Servidor rodando na porta 3000');
});

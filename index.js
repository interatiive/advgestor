const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fetch = require('node-fetch');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();

// Configurações fixas para o Cliente 1
const INSTANCE_ID = 'cliente1';
const PORT = 3000;
const HOSTNAME = '123.45.67.89:3000'; // Substitua pelo IP público da sua VM
const SESSION_DIR = path.join(__dirname, 'tokens');

// Middleware para logar o corpo bruto da requisição e cabeçalhos
app.use(express.raw({ type: '*/*' }), (req, res, next) => {
  console.log(`[${INSTANCE_ID}] Cabeçalhos da requisição:`, req.headers);
  if (req.body && req.body.length > 0) {
    const bodyString = req.body.toString();
    console.log(`[${INSTANCE_ID}] Corpo bruto da requisição recebido:`, bodyString);
    if (req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(bodyString);
      } catch (error) {
        console.error(`[${INSTANCE_ID}] Erro ao parsear JSON:`, error.message);
        return res.status(400).json({ error: 'JSON inválido: ' + error.message });
      }
    } else {
      console.log(`[${INSTANCE_ID}] Content-Type não é application/json:`, req.headers['content-type']);
      return res.status(400).json({ error: 'Content-Type deve ser application/json' });
    }
  } else {
    console.log(`[${INSTANCE_ID}] Corpo bruto da requisição vazio.`);
  }
  next();
});

app.use(cors());

const PROTOCOL = HOSTNAME.includes('localhost') ? 'http' : 'https';
const QR_CODE_URL = `${PROTOCOL}://${HOSTNAME}/qrcode`;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--headless'],
    timeout: 120000
  }
});

let qrCodeData = null;
let isClientReady = false;
let lastQrGenerationTime = 0;
const QR_CODE_EXPIRY = 2 * 60 * 1000;
const contactsWithDoctor = new Map();

async function initializeClient() {
  try {
    client.on('qr', (qr) => {
      const now = Date.now();
      if (now - lastQrGenerationTime > QR_CODE_EXPIRY || !qrCodeData) {
        qrCodeData = qr;
        lastQrGenerationTime = now;
        console.log(`[${INSTANCE_ID}] Novo QR Code gerado! Acesse o QR code em: ${QR_CODE_URL}`);
      } else {
        console.log(`[${INSTANCE_ID}] QR Code recente ainda válido, ignorando novo evento.`);
      }
    });

    client.on('ready', () => {
      isClientReady = true;
      qrCodeData = null;
      lastQrGenerationTime = 0;
      console.log(`[${INSTANCE_ID}] Cliente WhatsApp-Web.js pronto!`);
    });

    client.on('authenticated', () => {
      console.log(`[${INSTANCE_ID}] Cliente autenticado com sucesso!`);
    });

    client.on('auth_failure', (msg) => {
      console.error(`[${INSTANCE_ID}] Falha na autenticação:`, msg);
      isClientReady = false;
      qrCodeData = null;
      lastQrGenerationTime = 0;
    });

    client.on('disconnected', (reason) => {
      console.log(`[${INSTANCE_ID}] Cliente desconectado:`, reason);
      isClientReady = false;
      qrCodeData = null;
      lastQrGenerationTime = 0;
      setTimeout(initializeClient, 20000);
    });

    client.on('message', async (message) => {
      console.log(`[${INSTANCE_ID}] Mensagem recebida:`, { from: message.from, type: message.type, body: message.body });

      let messageBody = message.body ? message.body.toLowerCase() : '';

      const doctorVariations = ['dr. eliah', 'dr eliah', 'doutor eliah', 'dr.eliah'];
      if (messageBody && doctorVariations.some(variation => messageBody.includes(variation))) {
        const contactId = message.from;
        contactsWithDoctor.set(contactId, Date.now());
        console.log(`[${INSTANCE_ID}] Mensagem com "Dr. Eliah" detectada de ${contactId}`);

        try {
          const response = await fetch('https://hook.us1.make.com/replace_with_your_make_webhook_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId, message: messageBody, instanceId: INSTANCE_ID })
          });
          console.log(`[${INSTANCE_ID}] Webhook enviado:`, response.status);
        } catch (error) {
          console.error(`[${INSTANCE_ID}] Erro ao enviar webhook:`, error);
        }
      }
    });

    console.log(`[${INSTANCE_ID}] Inicializando cliente WhatsApp...`);
    await client.initialize();
  } catch (error) {
    console.error(`[${INSTANCE_ID}] Erro ao inicializar cliente WhatsApp:`, error);
    setTimeout(initializeClient, 20000);
  }
}

initializeClient();

// Limpeza de contatos inativos
setInterval(() => {
  const now = Date.now();
  for (const [contactId, timestamp] of contactsWithDoctor) {
    if (now - timestamp > 30 * 60 * 1000) {
      contactsWithDoctor.delete(contactId);
      console.log(`[${INSTANCE_ID}] Contato ${contactId} removido da memória após 30 minutos.`);
    }
  }
}, 10 * 60 * 1000);

app.get('/', (req, res) => {
  console.log(`[${INSTANCE_ID}] Requisição recebida no endpoint / (keep-alive)`, { ip: req.ip, timestamp: new Date().toISOString() });
  res.json({ message: `Servidor rodando (instância: ${INSTANCE_ID})` });
});

app.get('/qrcode', async (req, res) => {
  console.log(`[${INSTANCE_ID}] Rota /qrcode acessada. Estado atual:`, { isClientReady, qrCodeDataAvailable: !!qrCodeData });

  if (isClientReady) {
    console.log(`[${INSTANCE_ID}] Cliente já está conectado, QR code não é necessário.`);
    return res.status(200).json({ message: 'Cliente já está conectado ao WhatsApp.' });
  }

  const now = Date.now();
  if (!qrCodeData || (now - lastQrGenerationTime > QR_CODE_EXPIRY)) {
    console.log(`[${INSTANCE_ID}] QR Code expirado ou não disponível. Aguardando novo QR code...`);
    qrCodeData = null;
    lastQrGenerationTime = 0;
    return res.status(500).json({ error: 'QR Code não disponível ou expirado. Aguarde um novo QR code.' });
  }

  try {
    console.log(`[${INSTANCE_ID}] Gerando imagem do QR Code...`);
    const qrCodeImage = await qrcode.toDataURL(qrCodeData);
    console.log(`[${INSTANCE_ID}] Imagem do QR Code gerada com sucesso.`);
    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(qrCodeImage.split(',')[1], 'base64'));
  } catch (error) {
    console.error(`[${INSTANCE_ID}] Erro ao gerar imagem do QR Code:`, error);
    res.status(500).json({ error: 'Erro ao gerar imagem do QR Code' });
  }
});

app.post('/send', async (req, res) => {
  console.log(`[${INSTANCE_ID}] Requisição recebida na rota /send. Corpo da requisição:`, req.body);

  if (!isClientReady) {
    console.log(`[${INSTANCE_ID}] Cliente WhatsApp não está pronto.`);
    return res.status(500).json({ error: 'Cliente WhatsApp não está pronto' });
  }

  let messages = [];

  try {
    if (req.body.messages && Array.isArray(req.body.messages)) {
      messages = req.body.messages.map(item => ({
        number: item.telefone,
        message: item.message
      }));
    } else if (req.body.dados && req.body.cobranca) {
      messages = req.body.dados.map(item => ({
        number: item['Telefone para Envio'],
        message: req.body.cobranca
      }));
    } else if (Array.isArray(req.body)) {
      messages = req.body;
    } else {
      console.log(`[${INSTANCE_ID}] Formato de requisição inválido:`, req.body);
      return res.status(400).json({ error: 'Formato de requisição inválido' });
    }
  } catch (error) {
    console.error(`[${INSTANCE_ID}] Erro ao processar corpo da requisição:`, error);
    return res.status(400).json({ error: 'Erro ao processar corpo da requisição: JSON inválido' });
  }

  try {
    for (const msg of messages) {
      const phoneNumber = msg.number.replace(/\D/g, '');
      const chatId = `${phoneNumber}@c.us`;
      console.log(`[${INSTANCE_ID}] Tentando enviar mensagem para ${chatId}: ${msg.message}`);
      await client.sendMessage(chatId, msg.message);
      console.log(`[${INSTANCE_ID}] Mensagem enviada para ${phoneNumber}`);
      const delay = Math.floor(Math.random() * (30000 - 25000 + 1)) + 25000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    res.json({ success: true, message: 'Mensagens enviadas com sucesso' });
  } catch (error) {
    console.error(`[${INSTANCE_ID}] Erro ao enviar mensagens:`, error);
    res.status(500).json({ error: 'Erro ao enviar mensagens' });
  }
});

app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] Servidor rodando na porta ${PORT}`);
});

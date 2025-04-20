const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fetch = require('node-fetch');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());
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

// Função para inicializar o cliente com retentativas
async function initializeClient() {
  try {
    client.on('qr', (qr) => {
      const now = Date.now();
      // Só atualiza o QR code se o anterior expirou ou é o primeiro
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

    client.on('disconnected', (reason) => {
      console.log('Cliente desconectado:', reason);
      isClientReady = false;
      qrCodeData = null;
      lastQrGenerationTime = 0;
      setTimeout(initializeClient, 15000); // Tenta reconectar após 15 segundos
    });

    client.on('message', async (message) => {
      console.log('Mensagem recebida:', message.body);
      const messageBody = message.body ? message.body.toLowerCase() : '';
      const doctorVariations = ['dr. eliah', 'dr eliah', 'doutor eliah', 'dr.eliah'];

      if (doctorVariations.some(variation => messageBody.includes(variation))) {
        const contactId = message.from;
        contactsWithDoctor.set(contactId, Date.now());
        console.log(`Mensagem com "Dr. Eliah" detectada de ${contactId}`);

        fetch('https://hook.us1.make.com/replace_with_your_make_webhook_url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId, message: message.body })
        })
          .then(response => console.log('Webhook enviado:', response.status))
          .catch(error => console.error('Erro ao enviar webhook:', error));
      }
    });

    await client.initialize();
  } catch (error) {
    console.error('Erro ao inicializar cliente WhatsApp:', error);
    setTimeout(initializeClient, 15000); // Tenta novamente após 15 segundos
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
  console.log('Requisição recebida no endpoint / (keep-alive)');
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

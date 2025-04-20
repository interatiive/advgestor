const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let qrCodeData = null;
const contactsWithDoctor = new Map();

client.on('qr', (qr) => {
  qrCodeData = qr;
  console.log('QR Code gerado');
});

client.on('ready', () => {
  console.log('Cliente WhatsApp-Web.js pronto!');
});

client.on('message', async (message) => {
  const messageBody = message.body ? message.body.toLowerCase() : '';
  const doctorVariations = ['dr. eliah', 'dr eliah', 'doutor eliah', 'dr.eliah'];

  if (doctorVariations.some(variation => messageBody.includes(variation))) {
    const contactId = message.from;
    contactsWithDoctor.set(contactId, Date.now());

    fetch('https://hook.us1.make.com/replace_with_your_make_webhook_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, message: message.body })
    })
      .then(response => console.log('Webhook enviado:', response.status))
      .catch(error => console.error('Erro ao enviar webhook:', error));
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [contactId, timestamp] of contactsWithDoctor) {
    if (now - timestamp > 30 * 60 * 1000) {
      contactsWithDoctor.delete(contactId);
      console.log(`Contato ${contactId} removido da memória após 30 minutos.`);
    }
  }
}, 10 * 60 * 1000);

client.initialize();

app.get('/', (req, res) => {
  res.json({ message: 'Servidor rodando' });
});

app.get('/qrcode', (req, res) => {
  if (!qrCodeData) {
    return res.status(500).json({ error: 'QR Code não disponível' });
  }

  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(qrCodeData)}`;
  res.redirect(qrCodeUrl);
});

app.post('/send', async (req, res) => {
  let messages = [];

  if (req.body.dados && req.body.cobranca) {
    messages = req.body.dados.map(item => ({
      number: item['Telefone para Envio'],
      message: req.body.cobranca
    }));
  } else if (Array.isArray(req.body)) {
    messages = req.body;
  } else {
    return res.status(400).json({ error: 'Formato de requisição inválido' });
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

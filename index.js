const express = require('express');
const venom = require('venom-bot');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Variáveis globais
global.client = null;

// Função para gerar delay aleatório (25 a 30 segundos)
const getRandomDelay = () => Math.floor(Math.random() * (30 - 25 + 1)) + 25) * 1000;

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
          resolve({ success: false, number: cleanNumber, error: 'Número não registrado' });
          return;
        }
        const sentMessage = await global.client.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message }, { timeout: 60_000 });
        console.log(`Mensagem enviada para ${cleanNumber}`);
        resolve({ success: true, number: cleanNumber });
      } catch (error) {
        resolve({ success: false, number: cleanNumber, error: error.message });
      }
    }, delay);
  });
};

// Endpoint para enviar mensagens
app.post('/send', async (req, res) => {
  let messages = req.body;

  // Verificar formato do Wix (com "dados" e "cobrança")
  if (messages.dados) {
    try {
      const parsedData = JSON.parse(messages.dados);
      if (!parsedData.messages || !Array.isArray(parsedData.messages)) {
        console.log('Requisição inválida: "dados" deve conter um array em "messages"');
        return res.status(400).json({ error: 'Payload inválido: "dados" deve conter um array em "messages"' });
      }
      messages = parsedData.messages;
    } catch (error) {
      console.log('Requisição inválida: erro ao parsear "dados"', error.message);
      return res.status(400).json({ error: 'Payload inválido: erro ao parsear "dados"' });
    }
  }

  // Verificar se o corpo (ou "messages" extraído) é um array
  if (!Array.isArray(messages)) {
    console.log('Requisição inválida: o corpo deve ser um array de mensagens');
    return res.status(400).json({ error: 'O corpo da requisição deve ser um array de mensagens' });
  }

  // Validar formato de cada mensagem
  for (const msg of messages) {
    if (!msg.telefone || !msg.message) {
      console.log('Mensagem inválida: "telefone" e "message" são obrigatórios', msg);
      return res.status(400).json({ error: 'Mensagem inválida: "telefone" e "message" são obrigatórios' });
    }
  }

  console.log(`Recebidas ${messages.length} mensagens para envio`);
  const results = await Promise.all(messages.map((msg, index) => sendMessageWithDelay(msg, index * getRandomDelay())));
  res.json({ message: 'Enviando mensagens', results });
});

// Endpoint para QR Code
app.get('/qrcode', (req, res) => {
  if (global.client) {
    return res.json({ message: 'Cliente já conectado. Desconecte primeiro.' });
  }

  venom.create({
    session: 'session-name',
    multidevice: true
  })
  .then(client => {
    global.client = client;
    client.onStateChange(state => {
      console.log('Estado do WhatsApp:', state);
    });
    res.json({ message: 'QR Code gerado. Verifique o terminal.' });
  })
  .catch(error => {
    console.error('Erro ao gerar QR Code:', error);
    res.status(500).json({ error: 'Erro ao gerar QR Code' });
  });
});

// Endpoint keep-alive
app.get('/', (req, res) => res.json({ message: 'Servidor rodando' }));

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Gerar QR Code no terminal
venom.create({
  session: 'session-name',
  multidevice: true
})
.then(client => {
  global.client = client;
  client.onStateChange(state => {
    console.log('Estado do WhatsApp:', state);
  });
})
.catch(error => {
  console.error('Erro ao iniciar cliente WhatsApp:', error);
});

const express = require('express');
const venom = require('venom-bot');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

// Variáveis globais
global.client = null;

// Memória para o Dr. Eliah: { número: timestamp da última mensagem }
const conversationMemory = new Map();

// Carrega as variações do "Dr. Eliah" das variáveis de ambiente
const DR_ELIAH_VARIATIONS = process.env.DR_ELIAH_VARIATIONS
  ? process.env.DR_ELIAH_VARIATIONS.split(',').map(v => v.trim())
  : ['Dr. Eliah', 'Dr Eliah', 'dr. eliah', 'dr eliah']; // Fallback para testes locais

// Cria uma regex para detectar as variações (case-insensitive)
const drEliahRegex = new RegExp(
  DR_ELIAH_VARIATIONS.map(v => v.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('|'),
  'i'
);

// Função para gerar delay aleatório (25 a 30 segundos)
const getRandomDelay = () => Math.floor(Math.random() * (30 - 25 + 1) + 25) * 1000;

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

// Função para enviar webhook ao Make
const sendWebhookToMake = async (number, message) => {
  try {
    const response = await fetch('https://hook.us1.make.com/2malcal6a3uugbp748jl8rziqnc39jci', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number,
        message,
        source: 'DrEliah',
      }),
    });
    if (response.ok) {
      console.log(`Webhook enviado ao Make para o número ${number}`);
    } else {
      console.error(`Erro ao enviar webhook para o Make: ${response.statusText}`);
    }
  } catch (error) {
    console.error(`Erro na requisição ao Make: ${error.message}`);
  }
};

// Função para verificar inatividade e limpar memória
const checkInactivity = () => {
  const currentTime = Date.now();
  for (const [number, lastMessageTime] of conversationMemory.entries()) {
    const timeDiff = (currentTime - lastMessageTime) / 1000 / 60; // Diferença em minutos
    if (timeDiff >= 30) {
      conversationMemory.delete(number);
      console.log(`Conversa com ${number} encerrada por inatividade (30 minutos)`);
    }
  }
};

// Configura o intervalo para verificar inatividade a cada 10 minutos
setInterval(checkInactivity, 10 * 60 * 1000); // 10 minutos em milissegundos

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
    const cleanNumber = msg.telefone.toString().replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10) {
      console.log('Número de telefone inválido:', msg.telefone);
      return res.status(400).json({ error: 'Número de telefone inválido' });
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
    setupMessageListener(client);
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

// Função para configurar o listener de mensagens (Dr. Eliah)
const setupMessageListener = (client) => {
  client.onMessage(async (message) => {
    if (message.isGroupMsg) return; // Ignora mensagens de grupo

    const number = message.from.split('@')[0]; // Extrai o número de telefone
    const text = message.body || '';

    // Verifica se a mensagem contém uma variação do "Dr. Eliah"
    const isDrEliahMessage = drEliahRegex.test(text);

    // Atualiza o timestamp da última mensagem se for uma mensagem do Dr. Eliah ou se o número já está na memória
    if (isDrEliahMessage || conversationMemory.has(number)) {
      conversationMemory.set(number, Date.now());
      console.log(`Mensagem recebida de ${number}: ${text}`);

      // Envia webhook ao Make
      await sendWebhookToMake(number, text);
    }
  });
};

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Gerar QR Code no terminal e configurar listener
venom.create({
  session: 'session-name',
  multidevice: true
})
.then(client => {
  global.client = client;
  setupMessageListener(client);
  client.onStateChange(state => {
    console.log('Estado do WhatsApp:', state);
  });
})
.catch(error => {
  console.error('Erro ao iniciar cliente WhatsApp:', error);
});

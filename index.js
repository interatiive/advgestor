const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Rota para enviar mensagem (GET e POST)
app.get('/send', async (req, res) => {
  const { number, message } = req.query;
  console.log(`Requisição GET recebida na rota /send: { number: ${number}, message: ${message} }`);
  try {
    await global.client.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    console.log(`Mensagem enviada com sucesso para: ${number}`);
    res.json({ success: true, message: `Mensagem enviada pra ${number}` });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ success: false, error: 'Erro ao enviar mensagem' });
  }
});

app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  console.log(`Requisição POST recebida na rota /send: { number: ${number}, message: ${message} }`);
  try {
    await global.client.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    console.log(`Mensagem enviada com sucesso para: ${number}`);
    res.json({ success: true, message: `Mensagem enviada pra ${number}` });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ success: false, error: 'Erro ao enviar mensagem' });
  }
});

// Rota simples pra "ping"
app.get('/ping', (req, res) => {
  console.log('Ping recebido! Servidor está ativo.');
  res.send('Pong!');
});

// Função para conectar ao WhatsApp
const connectToWhatsApp = async () => {
  const authDir = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) {
      console.log('QR Code (texto):', qr);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('Conectado ao WhatsApp com sucesso!');
      global.client = sock;
    }
    if (connection === 'close') {
      console.log('Desconectado! Reconectando...');
      setTimeout(connectToWhatsApp, 5000);
    }
  });
};

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

// Conecta ao WhatsApp
connectToWhatsApp();

// Função para "pingar" a si mesmo a cada 12 minutos
const keepAlive = async () => {
  const url = 'https://whatsapp-api-render-pqn2.onrender.com/ping';
  try {
    const response = await fetch(url);
    const text = await response.text();
    console.log(`Keep-alive ping: ${text}`);
  } catch (error) {
    console.error('Erro ao fazer keep-alive ping:', error);
  }
};

// Executa o ping a cada 14 minutos (720000 ms)
setInterval(keepAlive, 14 * 60 * 1000);

const express = require('express');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Rota para enviar mensagem
app.get('/send', async (req, res) => {
  const { number, message } = req.query;
  console.log(`Requisição recebida na rota /send: { number: ${number}, message: ${message} }`);
  try {
    await global.client.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    console.log(`Mensagem enviada com sucesso para: ${number}`);
    res.json({ success: true, message: `Mensagem enviada pra ${number}` });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ success: false, error: 'Erro ao enviar mensagem' });
  }
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});

connectToWhatsApp();

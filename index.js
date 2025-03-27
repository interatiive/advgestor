const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baileys');
const qrcode = require('qrcode-terminal');
const crypto = require('crypto');

global.crypto = global.crypto || crypto.webcrypto || crypto;

const app = express();
const port = process.env.PORT || 3000;

let sock;

async function connectToWhatsApp() {
  console.log('Iniciando conexão com o WhatsApp...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  console.log('Credenciais carregadas:', state.creds ? 'Sim' : 'Não');
  if (state.creds) console.log('Detalhes das credenciais:', JSON.stringify(state.creds));

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    defaultQueryTimeoutMs: undefined,
    logger: require('pino')({ level: 'debug' }),
    browser: ['WhatsApp API', 'Chrome', '105'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('QR code gerado! Escaneie abaixo:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('Conectado ao WhatsApp com sucesso!');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('Desconectado! Motivo:', lastDisconnect?.error);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('Tentando reconectar em 5 segundos...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('Sessão encerrada. Gere um novo QR code.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

app.get('/send', async (req, res) => {
  const { number, message } = req.query;
  if (!number || !message) {
    return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
  }

  try {
    console.log('Verificando conexão antes de enviar...');
    if (!sock || !sock.user) {
      console.log('Socket não conectado. Reconectando...');
      await connectToWhatsApp();
      await new Promise((resolve) => {
        sock.ev.on('connection.update', (update) => {
          if (update.connection === 'open') resolve();
        });
      });
      console.log('Reconexão concluída.');
    }

    const chatId = `${number}@s.whatsapp.net`;
    await sock.sendMessage(chatId, { text: message });
    res.json({ success: true, message: `Mensagem enviada pra ${number}` });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagem', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
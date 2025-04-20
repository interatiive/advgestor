const express = require('express');
const venom = require('venom-bot');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

let client;
let qrCodeLink = ''; // Armazena o link da imagem do QR code

// Mapa para armazenar números que mencionaram "Dr. Eliah"
const drEliahNumbers = new Map();

// Função para enviar webhook ao Make
async function sendWebhook(number) {
    const url = 'https://hook.eu2.make.com/dxohgafm8v7e9e9h5l3pkbvgnvkhq0x4';
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number })
        });
        console.log(`Webhook enviado para o número ${number}`);
    } catch (error) {
        console.error(`Erro ao enviar webhook para o número ${number}:`, error);
    }
}

// Função para verificar e remover números inativos
function checkInactiveNumbers() {
    const now = Date.now();
    for (const [number, lastActive] of drEliahNumbers.entries()) {
        if (now - lastActive > 30 * 60 * 1000) { // 30 minutos
            drEliahNumbers.delete(number);
            console.log(`Número ${number} removido por inatividade.`);
        }
    }
}

// Verificação de inatividade a cada 10 minutos
setInterval(checkInactiveNumbers, 10 * 60 * 1000);

// Inicializa o cliente do WhatsApp e captura o QR code
venom
    .create({
        session: 'session-name',
        multidevice: true,
        puppeteerOptions: {
            executablePath: '/usr/bin/google-chrome', // Caminho do Chrome instalado manualmente
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necessário para rodar no Render
        }
    })
    .then((clientInstance) => {
        client = clientInstance;
        console.log('Cliente WhatsApp iniciado com sucesso!');

        // Monitora mensagens recebidas
        client.onMessage(async (message) => {
            if (message.body && message.isGroupMsg === false) {
                const number = message.from.split('@')[0];
                const bodyLower = message.body.toLowerCase();
                const drEliahVariations = ['dr. eliah', 'dr eliah', 'dreliah'];

                if (drEliahVariations.some(variation => bodyLower.includes(variation))) {
                    if (!drEliahNumbers.has(number)) {
                        drEliahNumbers.set(number, Date.now());
                        console.log(`Número ${number} adicionado por mencionar "Dr. Eliah".`);
                        await sendWebhook(number);
                    } else {
                        drEliahNumbers.set(number, Date.now()); // Atualiza o tempo de atividade
                    }
                }
            }
        });

        // Captura o QR code
        client.onQR((qr) => {
            console.log('QR Code gerado (texto):', qr);

            // Gera um link de imagem usando a API do qrserver
            const encodedQr = encodeURIComponent(qr);
            qrCodeLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodedQr}`;
            console.log('Link do QR Code:', qrCodeLink);
        });

        // Monitora o estado da conexão
        client.onStateChange((state) => {
            console.log('Estado do WhatsApp:', state);
            if (state === 'CONNECTED') {
                qrCodeLink = ''; // Limpa o link do QR code quando conectado
                console.log('Conexão com o WhatsApp estabelecida. QR Code não é mais necessário.');
            }
        });
    })
    .catch((error) => {
        console.error('Erro ao iniciar cliente WhatsApp:', error);
    });

// Endpoint para obter o link do QR code
app.get('/qrcode', (req, res) => {
    if (qrCodeLink) {
        res.redirect(qrCodeLink); // Redireciona diretamente para a imagem do QR code
    } else {
        res.send('QR Code não está disponível. O WhatsApp pode já estar conectado, ou aguarde alguns segundos e tente novamente.');
    }
});

// Endpoint keep-alive
app.get('/', (req, res) => {
    res.json({ message: 'Servidor rodando' });
});

// Função para gerar um delay aleatório entre 25 e 30 segundos
function getRandomDelay() {
    return Math.floor(Math.random() * (30000 - 25000 + 1)) + 25000;
}

// Função para enviar mensagem com delay
async function sendMessageWithDelay(client, number, message) {
    try {
        const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
        await client.sendText(formattedNumber, message);
        console.log(`Mensagem enviada para ${number}: ${message}`);
    } catch (error) {
        console.error(`Erro ao enviar mensagem para ${number}:`, error);
    }
}

// Endpoint para enviar mensagens
app.post('/send', async (req, res) => {
    if (!client) {
        return res.status(500).json({ error: 'Cliente WhatsApp não inicializado' });
    }

    let messages = [];
    const { dados, cobranca } = req.body;

    if (dados && cobranca) {
        // Formato Wix: { dados: [{ Nome: "X", Telefone: "Y" }], cobranca: "Mensagem" }
        messages = dados.map(item => ({
            number: item.Telefone,
            message: cobranca.replace(/{Nome}/g, item.Nome)
        }));
    } else if (Array.isArray(req.body)) {
        // Formato array: [{ number: "55...", message: "Texto" }]
        messages = req.body;
    } else {
        return res.status(400).json({ error: 'Formato de dados inválido' });
    }

    try {
        for (const msg of messages) {
            await sendMessageWithDelay(client, msg.number, msg.message);
            const delay = getRandomDelay();
            console.log(`Aguardando ${delay / 1000} segundos antes da próxima mensagem...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        res.json({ success: true, message: 'Mensagens enviadas com sucesso!' });
    } catch (error) {
        console.error('Erro ao enviar mensagens:', error);
        res.status(500).json({ error: 'Erro ao enviar mensagens' });
    }
});

// Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

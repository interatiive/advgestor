# Use uma imagem base do Node.js
FROM node:18-slim

# Define o diretório de trabalho
WORKDIR /usr/src/app

# Instala dependências do sistema
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libasound2 \
    libxshmfence1 \
    libxfixes3 \
    libxss1 \
    libxtst6 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Instala uma versão específica do Chromium (Chrome 104, revisão r1045629)
RUN wget -O /tmp/chromium.zip https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Linux_x64%2F1045629%2Fchrome-linux.zip?alt=media \
    && unzip /tmp/chromium.zip -d /usr/local/ \
    && mv /usr/local/chrome-linux /usr/local/chromium \
    && ln -sf /usr/local/chromium/chrome /usr/bin/chromium \
    && rm /tmp/chromium.zip \
    && chmod +x /usr/bin/chromium

# Copia package.json e package-lock.json (se existir)
COPY package*.json ./

# Limpa o cache do npm e instala dependências
RUN npm cache clean --force && npm install

# Copia o restante dos arquivos
COPY . .

# Expõe a porta
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["npm", "start"]

# Use uma imagem base do Node.js
FROM node:18

# Define o diretório de trabalho
WORKDIR /usr/src/app

# Instala dependências do sistema necessárias para o Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && wget -q -O /tmp/chrome-key.asc https://dl-ssl.google.com/linux/linux_signing_key.pub \
    && gpg --dearmor < /tmp/chrome-key.asc > /etc/apt/trusted.gpg.d/google-chrome.gpg \
    && rm /tmp/chrome-key.asc \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y \
    google-chrome-stable \
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
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copia package.json e package-lock.json (se existir)
COPY package*.json ./

# Limpa o cache do npm e instala dependências
RUN npm cache clean --force && rm -rf node_modules && npm install --legacy-peer-deps

# Instala git (conforme mencionado anteriormente)
RUN apt-get update && apt-get install -y git

# Copia o restante dos arquivos
COPY . .

# Expõe a porta
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["npm", "start"]

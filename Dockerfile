# Use uma imagem base do Node.js
FROM node:18

# Define o diretório de trabalho
WORKDIR /usr/src/app

# Instala dependências do sistema necessárias para o Chrome/Puppeteer
RUN apt-get update && apt-get install -y \
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

# Limpa o cache e instala dependências
RUN npm cache clean --force && npm install

# Instala git (conforme mencionado anteriormente)
RUN apt-get update && apt-get install -y git

# Copia o restante dos arquivos
COPY . .

# Expõe a porta
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["npm", "start"]

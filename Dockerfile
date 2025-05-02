# Use uma imagem base do Node.js
 FROM node:18
 FROM node:18-slim
 
 # Define o diretório de trabalho
 WORKDIR /usr/src/app
 
 # Instala dependências do sistema, ferramentas de compilação e FFmpeg
 # Instala dependências do sistema
 RUN apt-get update && apt-get install -y \
     wget \
     ca-certificates \
 @@ -27,10 +27,6 @@ RUN apt-get update && apt-get install -y \
     libxfixes3 \
     libxss1 \
     libxtst6 \
     ffmpeg \
     build-essential \
     g++ \
     make \
     && apt-get clean && rm -rf /var/lib/apt/lists/*
 
 # Instala uma versão específica do Chromium (Chrome 104, revisão r1045629)
 @@ -45,10 +41,7 @@ RUN wget -O /tmp/chromium.zip https://www.googleapis.com/download/storage/v1/b/c
 COPY package*.json ./
 
 # Limpa o cache do npm e instala dependências
 RUN npm cache clean --force && rm -rf node_modules && npm install
 
 # Instala git (conforme mencionado anteriormente)
 RUN apt-get update && apt-get install -y git
 RUN npm cache clean --force && npm install
 
 # Copia o restante dos arquivos
 COPY . .

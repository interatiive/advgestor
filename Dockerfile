# Usar a imagem base do Node.js
FROM node:16

# Instalar o exiftool
RUN apt-get update && apt-get install -y exiftool

# Atualizar o npm para a versão mais recente
RUN npm install -g npm@11.3.0

# Definir o diretório de trabalho
WORKDIR /usr/src/app

# Copiar os arquivos do projeto
COPY package*.json ./
RUN npm install
COPY . .

# Expor a porta
EXPOSE 3000

# Iniciar a aplicação
CMD ["npm", "start"]

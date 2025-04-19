Use uma imagem base do Node.js
FROM node:18

Define o diretório de trabalho
WORKDIR /usr/src/app

Copia package.json e package-lock.json (se existir)
COPY package*.json ./

Instala dependências
RUN npm install

Instala git (conforme mencionado anteriormente)
RUN apt-get update && apt-get install -y git

Copia o restante dos arquivos
COPY . .

Expõe a porta
EXPOSE 3000

Comando para iniciar o servidor
CMD ["npm", "start"]

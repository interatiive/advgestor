# Usando uma imagem base leve do Node.js
FROM node:18-alpine

# Definindo o diretório de trabalho
WORKDIR /app

# Copiando package.json e package-lock.json (se existir)
COPY package*.json ./

# Instalando dependências
RUN npm install --production

# Copiando o código da aplicação
COPY index.js .

# Expondo a porta configurada pelo Render
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "index.js"]

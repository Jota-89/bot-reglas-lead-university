FROM node:18-alpine

WORKDIR /app

# Instalar Firebase CLI
RUN npm install -g firebase-tools

# Copiar archivos de configuración
COPY package.json ./
COPY firebase.json ./
COPY .env ./

# Copiar el PDF del reglamento
COPY functions/Reglamento.pdf ./functions/

# Instalar dependencias principales
RUN npm install

# Copiar functions y sus dependencias
COPY functions/ ./functions/
RUN cd functions && npm install

# Copiar archivos públicos
COPY public/ ./public/

# Exponer puertos
EXPOSE 4000 5000 5001 9099

# Comando para ejecutar emuladores
CMD ["firebase", "emulators:start", "--project", "demo-bot"]
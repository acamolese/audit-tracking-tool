FROM node:18-slim

# Installa dipendenze per Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package files
COPY package*.json ./

# Installa dipendenze Node
RUN npm install

# Installa Playwright Chromium
RUN npx playwright install chromium

# Copia codice
COPY . .

# Esponi porta
EXPOSE 3000

# Avvia server
CMD ["node", "server.js"]

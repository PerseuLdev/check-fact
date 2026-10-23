FROM node:24-bookworm-slim
ENV NODE_ENV=production PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 \
    CHECK_FACT_PYTHON=/opt/verifica-venv/bin/python HF_HOME=/models \
    HOST=0.0.0.0 PORT=4311
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/verifica-venv
WORKDIR /app
COPY requirements.txt ./
RUN /opt/verifica-venv/bin/pip install --no-cache-dir -r requirements.txt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY web-server.mjs ./
RUN mkdir -p /models && chown -R node:node /models /app
USER node
EXPOSE 4311
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:4311/healthz',{headers:{host:new URL(process.env.APP_PUBLIC_ORIGIN||'http://127.0.0.1:4311').host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "web-server.mjs"]

FROM public.ecr.aws/docker/library/node@sha256:e0e989b967dacc279681ed81774b2ce9eeebbb0efb8e0c427573235bebf1eda1

WORKDIR /app
COPY server.mjs ./
COPY public ./public
RUN node --check server.mjs && node --check public/app.js && node --check public/change.js

ENV HOST=0.0.0.0 PORT=5001 QWEN_CHAT_COMPLETIONS_URL=""
EXPOSE 5001
USER node
CMD ["node", "server.mjs"]

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN mkdir -p data && chmod 777 data
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "start"]

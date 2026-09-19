FROM node:18-bookworm-slim

RUN apt-get update -y && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.js /app/
COPY package.json /app/
COPY radio-list.json /app/
COPY run.sh /app/
RUN chmod a+x /app/run.sh
RUN npm install
ENTRYPOINT [ "/app/run.sh" ]

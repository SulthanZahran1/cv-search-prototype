FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS gobuild
WORKDIR /app
COPY go.mod ./
COPY api ./api
RUN go build -o /out/cv-search ./api

FROM alpine:3.22
RUN apk add --no-cache ca-certificates poppler-utils
WORKDIR /app
COPY --from=gobuild /out/cv-search /app/cv-search
COPY --from=webbuild /app/web/dist /app/web/dist
ENV PORT=8095 DATA_DIR=/data
EXPOSE 8095
CMD ["/app/cv-search"]

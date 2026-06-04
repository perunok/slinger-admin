FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY go.sum ./
COPY api ./api
RUN go build -o /out/api ./api/cmd/api && \
    go build -o /out/worker ./api/cmd/worker && \
    go build -o /out/realtime ./api/cmd/realtime

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/api /app/api
COPY --from=build /out/worker /app/worker
COPY --from=build /out/realtime /app/realtime
EXPOSE 8080 8081
CMD ["/app/api"]

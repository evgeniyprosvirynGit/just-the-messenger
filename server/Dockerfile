FROM golang:1.27.4-alpine3.24 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/planet-chat ./

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/planet-chat /planet-chat
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/planet-chat"]

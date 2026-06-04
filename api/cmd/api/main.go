package main

import (
	"log"
	"net/http"
	"os"

	"slinger-cloud-api/api/internal/server"
	"slinger-cloud-api/api/internal/store"
)

func main() {
	addr := env("SLINGER_API_ADDR", ":8080")
	st := store.New()
	srv := server.New(st)

	log.Printf("slinger api listening on %s", addr)
	if err := http.ListenAndServe(addr, srv); err != nil {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

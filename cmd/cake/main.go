package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cake/internal/cake"
)

func main() {
	config, err := cake.LoadConfig("config.json")
	if err != nil {
		log.Fatal(err)
	}

	app, err := cake.NewApp(config)
	if err != nil {
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:              config.Hostname + ":" + fmt.Sprint(config.Port),
		Handler:           app,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		log.Printf("Media directory: %s", config.MediaDir)
		log.Printf("Library cache: %s", config.LibraryFile)
		log.Printf("Listening on http://%s", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

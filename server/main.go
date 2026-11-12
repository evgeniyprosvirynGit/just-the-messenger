package main

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/nats-io/nats.go"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type application struct {
	db         *sql.DB
	nats       *nats.Conn
	hub        *Hub
	googleAuth *googleAuthClient
	logger     *slog.Logger
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		runHealthcheck()
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	databaseURL := env("DATABASE_URL", "postgres://planet_chat:local-only-change-me@postgres:5432/planet_chat?sslmode=disable")
	natsURL := env("NATS_URL", "nats://nats:4222")
	address := env("HTTP_ADDR", ":8080")

	db, err := connectDatabase(ctx, databaseURL, logger)
	if err != nil {
		logger.Error("connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	broker, err := connectNATS(ctx, natsURL, logger)
	if err != nil {
		logger.Error("connect to NATS", "error", err)
		os.Exit(1)
	}
	defer broker.Close()

	if err := runMigrations(ctx, db); err != nil {
		logger.Error("run migrations", "error", err)
		os.Exit(1)
	}

	googleAuth, err := newGoogleAuthClient(googleAuthSettings{
		ClientID:            env("GOOGLE_CLIENT_ID", ""),
		ClientSecret:        env("GOOGLE_CLIENT_SECRET", ""),
		RedirectURL:         env("GOOGLE_REDIRECT_URL", ""),
		IssuerURL:           env("GOOGLE_OIDC_ISSUER", googleIssuerURL),
		AllowInsecureIssuer: env("GOOGLE_OIDC_ALLOW_INSECURE", "false") == "true",
	})
	if err != nil {
		logger.Error("configure Google sign-in", "error", err)
		os.Exit(1)
	}

	app := &application{db: db, nats: broker, googleAuth: googleAuth, logger: logger}
	app.hub = NewHub(broker, logger)
	if err := app.hub.startFriendshipBroadcast(); err != nil {
		logger.Error("start friendship event broadcast", "error", err)
		os.Exit(1)
	}
	if err := app.hub.startPresenceBroadcast(ctx); err != nil {
		logger.Error("start online presence broadcast", "error", err)
		os.Exit(1)
	}
	app.startOutboxPublisher(ctx)
	app.startExpiredMessageCleanup(ctx)

	server := &http.Server{
		Addr:              address,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("api listening", "address", address)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server stopped", "error", err)
			os.Exit(1)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("http shutdown", "error", err)
	}
}

func runHealthcheck() {
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get("http://127.0.0.1:8080/readyz")
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		os.Exit(1)
	}
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", a.ready)
	mux.HandleFunc("GET /api/auth/google/config", a.googleAuthConfig)
	mux.HandleFunc("GET /api/auth/google/start", a.startGoogleAuth)
	mux.HandleFunc("GET /api/auth/google/callback", a.googleAuthCallback)
	mux.HandleFunc("POST /api/auth/logout", a.logout)
	mux.HandleFunc("GET /api/guest-session", a.getGuestSession)
	mux.HandleFunc("POST /api/guest-session", a.createGuestSession)
	mux.HandleFunc("GET /api/account/settings", a.getAccountSettings)
	mux.HandleFunc("PUT /api/account/settings", a.updateAccountSettings)
	mux.HandleFunc("GET /api/messages", a.listMessages)
	mux.HandleFunc("POST /api/messages", a.createMessage)
	mux.HandleFunc("GET /api/follows", a.listFollows)
	mux.HandleFunc("PUT /api/follows/{profileId}", a.createFollow)
	mux.HandleFunc("DELETE /api/follows/{profileId}", a.deleteFollow)
	mux.HandleFunc("GET /api/friendships", a.listFriendships)
	mux.HandleFunc("GET /api/friend-requests", a.listFriendRequests)
	mux.HandleFunc("GET /api/friend-requests/unread-count", a.friendRequestUnreadCount)
	mux.HandleFunc("PUT /api/friend-requests/read", a.markFriendRequestsRead)
	mux.HandleFunc("POST /api/friend-requests", a.createFriendRequest)
	mux.HandleFunc("PUT /api/friend-requests/{requestId}/accept", a.acceptFriendRequest)
	mux.HandleFunc("PUT /api/friend-requests/{requestId}/decline", a.declineFriendRequest)
	mux.HandleFunc("DELETE /api/friend-requests/{requestId}", a.cancelFriendRequest)
	mux.HandleFunc("DELETE /api/friends/{profileId}", a.removeFriend)
	mux.HandleFunc("GET /ws", a.websocket)
	return requestLogger(a.logger, mux)
}

func (a *application) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.PingContext(ctx); err != nil || !a.nats.IsConnected() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func connectDatabase(ctx context.Context, connectionString string, logger *slog.Logger) (*sql.DB, error) {
	db, err := sql.Open("pgx", connectionString)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)

	if err := retry(ctx, "postgres", logger, func() error {
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		return db.PingContext(pingCtx)
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func connectNATS(ctx context.Context, url string, logger *slog.Logger) (*nats.Conn, error) {
	var connection *nats.Conn
	err := retry(ctx, "nats", logger, func() error {
		var err error
		connection, err = nats.Connect(
			url,
			nats.Name("planet-chat-api"),
			nats.MaxReconnects(-1),
			nats.ReconnectWait(time.Second),
			nats.Timeout(3*time.Second),
			nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
				logger.Warn("NATS disconnected", "error", err)
			}),
			nats.ReconnectHandler(func(_ *nats.Conn) {
				logger.Info("NATS reconnected")
			}),
		)
		return err
	})
	if err != nil {
		return nil, err
	}
	return connection, nil
}

func runMigrations(ctx context.Context, db *sql.DB) error {
	entries, err := fs.Glob(migrationFiles, "migrations/*.sql")
	if err != nil {
		return err
	}
	for _, name := range entries {
		contents, err := migrationFiles.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := db.ExecContext(ctx, string(contents)); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(name), err)
		}
	}
	return nil
}

func retry(ctx context.Context, dependency string, logger *slog.Logger, operation func() error) error {
	delay := 400 * time.Millisecond
	for {
		if err := operation(); err == nil {
			return nil
		} else {
			logger.Warn("dependency not ready", "dependency", dependency, "error", err)
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for %s: %w", dependency, ctx.Err())
		case <-time.After(delay):
		}
		if delay < 4*time.Second {
			delay *= 2
		}
	}
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func requestLogger(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("http request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(started).Milliseconds())
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}

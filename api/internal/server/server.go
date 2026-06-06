package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"slinger-cloud-api/api/internal/model"
	"slinger-cloud-api/api/internal/store"
)

type Server struct {
	store *store.Store
	mux   *http.ServeMux
}

func New(st *store.Store) *Server {
	s := &Server{store: st, mux: http.NewServeMux()}
	s.mux.HandleFunc("/", s.handle)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/healthz" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/device":
		s.devicePage(w, r)
		return
	case r.Method == http.MethodPost && r.URL.Path == "/device/identify":
		s.deviceIdentify(w, r)
		return
	case r.Method == http.MethodPost && r.URL.Path == "/device/login":
		s.deviceLogin(w, r)
		return
	case r.Method == http.MethodGet && r.URL.Path == "/device/password":
		s.devicePasswordPage(w, r)
		return
	case r.Method == http.MethodPost && r.URL.Path == "/device/password":
		s.devicePasswordSubmit(w, r)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/v1/") {
		http.NotFound(w, r)
		return
	}

	user, err := s.currentUser(r)
	protected := !s.isPublicPath(r.URL.Path)
	if protected && err != nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "missing or invalid access token", nil)
		return
	}

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/device/start":
		s.deviceStart(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/device/poll":
		s.devicePoll(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/refresh":
		s.refresh(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/logout":
		s.logout(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/account/browser/start":
		s.browserStart(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/browser/login":
		s.browserLogin(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/account/browser/logout":
		s.browserLogout(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/account/me":
		s.me(w, user)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/workspaces":
		s.listWorkspaces(w, user)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/workspaces":
		s.createWorkspace(w, r, user)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/workspaces/resolve":
		s.resolveWorkspace(w, r, user)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/workspaces/publish":
		s.publishWorkspace(w, r, user)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/sync/clients/register":
		s.registerClient(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/workspaces/"):
		s.handleWorkspaceRoutes(w, r, user)
	case strings.HasPrefix(r.URL.Path, "/v1/invites/"):
		s.handleInviteRoutes(w, r, user)
	case strings.HasPrefix(r.URL.Path, "/v1/admin/"):
		s.handleAdminRoutes(w, r, user)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) isPublicPath(path string) bool {
	switch path {
	case "/v1/account/device/start",
		"/v1/account/device/poll",
		"/v1/account/refresh",
		"/v1/account/logout",
		"/v1/account/browser/start",
		"/v1/account/browser/login",
		"/v1/account/browser/logout":
		return true
	default:
		return false
	}
}

func (s *Server) currentUser(r *http.Request) (*model.User, error) {
	auth := r.Header.Get("Authorization")
	if auth != "" {
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
		token = strings.TrimSpace(token)
		claims, err := s.store.VerifyAccessToken(token)
		if err != nil {
			return nil, err
		}
		return s.store.UserByID(claims.UserID)
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		return s.store.UserFromSession(cookie.Value)
	}
	return nil, errors.New("missing auth")
}

func (s *Server) applyCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	allowed := env("SLINGER_ADMIN_DASHBOARD_URL", "http://localhost:5174")
	if origin != allowed {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, OPTIONS")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":       code,
			"message":    message,
			"details":    details,
			"request_id": "",
		},
	})
}

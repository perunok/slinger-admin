package server

import (
	"net/http"
	"time"

	"slinger-cloud-api/api/internal/model"
)

const sessionCookieName = "slinger_session"

func (s *Server) browserStart(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"login_url":      "/v1/auth/browser/login",
		"logout_url":     "/v1/auth/browser/logout",
		"session_cookie": sessionCookieName,
	})
}

func (s *Server) browserLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email        string             `json:"email"`
		DisplayName  string             `json:"display_name"`
		PlatformRole model.PlatformRole `json:"platform_role"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	if req.PlatformRole == "" {
		req.PlatformRole = model.PlatformRolePlatformAdmin
	}
	user := s.store.UpsertUser(req.Email, req.DisplayName, req.PlatformRole)
	sessionToken := s.store.CreateBrowserSession(user.ID)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure(),
		Expires:  time.Now().Add(7 * 24 * time.Hour),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"user": user,
	})
}

func (s *Server) browserLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.store.RevokeSession(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func cookieSecure() bool {
	return env("SLINGER_COOKIE_SECURE", "false") == "true"
}

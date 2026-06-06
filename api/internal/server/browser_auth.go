package server

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"slinger-cloud-api/api/internal/model"
)

const sessionCookieName = "slinger_session"

func (s *Server) browserStart(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"login_url":      "/v1/account/browser/login",
		"logout_url":     "/v1/account/browser/logout",
		"session_cookie": sessionCookieName,
	})
}

func (s *Server) browserLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "username and password are required", nil)
		return
	}
	user, err := s.store.AuthenticateUser(req.Username, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", "invalid username or password", nil)
		return
	}
	if user.MustChangePassword {
		writeError(w, http.StatusForbidden, "password_change_required", "change the default password through the device login flow first", nil)
		return
	}
	if err := s.requirePlatformAdmin(user); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "admin access required", nil)
		return
	}
	s.setBrowserSessionCookie(w, user.ID)
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

func (s *Server) setBrowserSessionCookie(w http.ResponseWriter, userID string) {
	sessionToken := s.store.CreateBrowserSession(userID)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cookieSecure(),
		Expires:  time.Now().Add(7 * 24 * time.Hour),
	})
}

func (s *Server) currentBrowserSessionUser(r *http.Request) (*model.User, error) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return nil, err
	}
	return s.store.UserFromSession(cookie.Value)
}

func (s *Server) devicePage(w http.ResponseWriter, r *http.Request) {
	userCode := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("user_code")))
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	callbackURL := strings.TrimSpace(r.URL.Query().Get("callback_url"))
	if userCode == "" {
		s.renderDeviceMessagePage(w, http.StatusBadRequest, "Device Login", "Missing user code.", "", false, "")
		return
	}
	flow, err := s.store.DeviceFlowByUserCode(userCode)
	if err != nil {
		s.renderDeviceMessagePage(w, http.StatusNotFound, "Device Login", "Device login request not found.", "", false, "")
		return
	}
	if time.Now().After(flow.ExpiresAt) {
		s.renderDeviceMessagePage(w, http.StatusGone, "Device Login", "This device login request has expired. Start over from the desktop app.", "", false, "")
		return
	}
	if flow.Status == "approved" {
		s.renderDeviceMessagePage(w, http.StatusOK, "Device Login", "Desktop sign-in is complete. You can return to the app.", "", true, callbackURL)
		return
	}
	user, _ := s.currentBrowserSessionUser(r)
	if user != nil {
		if user.MustChangePassword {
			s.renderChangePasswordPage(w, userCode, user.Email, "", "", callbackURL)
			return
		}
		if _, err := s.store.ApproveDeviceFlow(userCode, user.ID); err == nil {
			s.renderDeviceMessagePage(w, http.StatusOK, "Device Login", "Desktop sign-in is complete. You can return to the app.", "", true, callbackURL)
			return
		}
	}
	if email == "" {
		s.renderDeviceIdentifyPage(w, userCode, "", "", callbackURL)
		return
	}
	s.renderDeviceLoginPage(w, userCode, email, "", callbackURL)
}

func (s *Server) deviceIdentify(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		s.renderDeviceIdentifyPage(w, "", "", "Invalid form submission.", "")
		return
	}
	userCode := strings.ToUpper(strings.TrimSpace(r.FormValue("user_code")))
	email := strings.TrimSpace(r.FormValue("email"))
	callbackURL := strings.TrimSpace(r.FormValue("callback_url"))
	if userCode == "" || email == "" {
		s.renderDeviceIdentifyPage(w, userCode, email, "User code and email are required.", callbackURL)
		return
	}
	flow, err := s.store.DeviceFlowByUserCode(userCode)
	if err != nil || time.Now().After(flow.ExpiresAt) {
		s.renderDeviceMessagePage(w, http.StatusGone, "Device Login", "This device login request is no longer valid. Start over from the desktop app.", "", false, "")
		return
	}
	if _, err := s.store.UserByEmail(email); err != nil {
		s.renderDeviceIdentifyPage(w, userCode, email, "No account exists for that email.", callbackURL)
		return
	}
	http.Redirect(w, r, deviceFlowURL(userCode, email, callbackURL), http.StatusSeeOther)
}

func (s *Server) deviceLogin(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		s.renderDeviceLoginPage(w, "", "", "Invalid form submission.", "")
		return
	}
	userCode := strings.ToUpper(strings.TrimSpace(r.FormValue("user_code")))
	email := strings.TrimSpace(r.FormValue("email"))
	password := r.FormValue("password")
	callbackURL := strings.TrimSpace(r.FormValue("callback_url"))
	if userCode == "" || email == "" || password == "" {
		s.renderDeviceLoginPage(w, userCode, email, "User code, email, and password are required.", callbackURL)
		return
	}
	flow, err := s.store.DeviceFlowByUserCode(userCode)
	if err != nil || time.Now().After(flow.ExpiresAt) {
		s.renderDeviceMessagePage(w, http.StatusGone, "Device Login", "This device login request is no longer valid. Start over from the desktop app.", "", false, "")
		return
	}
	user, err := s.store.AuthenticateUserByEmail(email, password)
	if err != nil {
		s.renderDeviceLoginPage(w, userCode, email, "Invalid email or password.", callbackURL)
		return
	}
	s.setBrowserSessionCookie(w, user.ID)
	if user.MustChangePassword {
		http.Redirect(w, r, devicePasswordURL(userCode, callbackURL), http.StatusSeeOther)
		return
	}
	if _, err := s.store.ApproveDeviceFlow(userCode, user.ID); err != nil {
		s.renderDeviceLoginPage(w, userCode, email, err.Error(), callbackURL)
		return
	}
	s.renderDeviceMessagePage(w, http.StatusOK, "Device Login", "Desktop sign-in is complete. You can return to the app.", "", true, callbackURL)
}

func (s *Server) devicePasswordPage(w http.ResponseWriter, r *http.Request) {
	userCode := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("user_code")))
	callbackURL := strings.TrimSpace(r.URL.Query().Get("callback_url"))
	user, err := s.currentBrowserSessionUser(r)
	if err != nil || user == nil {
		http.Redirect(w, r, deviceFlowURL(userCode, "", callbackURL), http.StatusSeeOther)
		return
	}
	if !user.MustChangePassword {
		if _, err := s.store.ApproveDeviceFlow(userCode, user.ID); err == nil {
			s.renderDeviceMessagePage(w, http.StatusOK, "Password Updated", "Desktop sign-in is complete. You can return to the app.", "", true, callbackURL)
			return
		}
	}
	s.renderChangePasswordPage(w, userCode, user.Email, "", "", callbackURL)
}

func (s *Server) devicePasswordSubmit(w http.ResponseWriter, r *http.Request) {
	user, err := s.currentBrowserSessionUser(r)
	if err != nil || user == nil {
		http.Redirect(w, r, "/device", http.StatusSeeOther)
		return
	}
	if err := r.ParseForm(); err != nil {
		s.renderChangePasswordPage(w, "", user.Email, "", "Invalid form submission.", "")
		return
	}
	userCode := strings.ToUpper(strings.TrimSpace(r.FormValue("user_code")))
	password := r.FormValue("new_password")
	confirm := r.FormValue("confirm_password")
	callbackURL := strings.TrimSpace(r.FormValue("callback_url"))
	if userCode == "" {
		s.renderChangePasswordPage(w, "", user.Email, "", "Missing user code.", callbackURL)
		return
	}
	if len(password) < 8 {
		s.renderChangePasswordPage(w, userCode, user.Email, "", "Password must be at least 8 characters.", callbackURL)
		return
	}
	if password != confirm {
		s.renderChangePasswordPage(w, userCode, user.Email, "", "Passwords do not match.", callbackURL)
		return
	}
	updated, err := s.store.UpdatePassword(user.ID, password, true)
	if err != nil {
		s.renderChangePasswordPage(w, userCode, user.Email, "", "Unable to update password.", callbackURL)
		return
	}
	if _, err := s.store.ApproveDeviceFlow(userCode, updated.ID); err != nil {
		s.renderChangePasswordPage(w, userCode, updated.Email, "", err.Error(), callbackURL)
		return
	}
	s.renderDeviceMessagePage(w, http.StatusOK, "Password Updated", "Password changed and desktop sign-in approved. You can return to the app.", "", true, callbackURL)
}

func deviceFlowURL(userCode, email, callbackURL string) string {
	query := url.Values{}
	query.Set("user_code", userCode)
	if strings.TrimSpace(email) != "" {
		query.Set("email", email)
	}
	if strings.TrimSpace(callbackURL) != "" {
		query.Set("callback_url", callbackURL)
	}
	return "/device?" + query.Encode()
}

func devicePasswordURL(userCode, callbackURL string) string {
	query := url.Values{}
	query.Set("user_code", userCode)
	if strings.TrimSpace(callbackURL) != "" {
		query.Set("callback_url", callbackURL)
	}
	return "/device/password?" + query.Encode()
}

func callbackHiddenInput(callbackURL string) string {
	if strings.TrimSpace(callbackURL) == "" {
		return ""
	}
	return `<input type="hidden" name="callback_url" value="` + html.EscapeString(callbackURL) + `" />`
}

func deviceSuccessAction(callbackURL string) string {
	if strings.TrimSpace(callbackURL) == "" {
		return ""
	}
	escapedURL := html.EscapeString(callbackURL)
	return fmt.Sprintf(`<p><a href="%s">Return to the desktop app</a></p><script>window.setTimeout(function(){ window.location.replace(%q); }, 600);</script>`, escapedURL, callbackURL)
}

func (s *Server) renderDeviceIdentifyPage(w http.ResponseWriter, userCode, email, message, callbackURL string) {
	body := fmt.Sprintf(`
<form method="post" action="/device/identify" class="card">
  <div class="eyebrow">Desktop Access</div>
  <h1>Enter your email</h1>
  <p>Start with the email address your administrator used when creating your account.</p>
  %s
  <input type="hidden" name="user_code" value="%s" />
  %s
  <label>User code</label>
  <input value="%s" readonly />
  <label>Email</label>
  <input name="email" value="%s" type="email" autocomplete="email" />
  <button type="submit">Continue</button>
</form>`, renderInlineMessage(message), html.EscapeString(userCode), callbackHiddenInput(callbackURL), html.EscapeString(userCode), html.EscapeString(email))
	renderHTML(w, http.StatusOK, "Device Login", body)
}

func (s *Server) renderDeviceLoginPage(w http.ResponseWriter, userCode, email, message, callbackURL string) {
	body := fmt.Sprintf(`
<form method="post" action="/device/login" class="card">
  <div class="eyebrow">Desktop Access</div>
  <h1>Sign in to continue</h1>
  <p>Use the account created by your administrator. If this is your first login, you will be asked to change the default password.</p>
  %s
  <input type="hidden" name="user_code" value="%s" />
  <input type="hidden" name="email" value="%s" />
  %s
  <label>User code</label>
  <input value="%s" readonly />
  <label>Email</label>
  <input value="%s" type="email" readonly />
  <label>Password</label>
  <input name="password" type="password" autocomplete="current-password" />
  <button type="submit">Continue</button>
</form>`, renderInlineMessage(message), html.EscapeString(userCode), html.EscapeString(email), callbackHiddenInput(callbackURL), html.EscapeString(userCode), html.EscapeString(email))
	renderHTML(w, http.StatusOK, "Device Login", body)
}

func (s *Server) renderChangePasswordPage(w http.ResponseWriter, userCode, email, title, message, callbackURL string) {
	if title == "" {
		title = "Change default password"
	}
	body := fmt.Sprintf(`
<form method="post" action="/device/password" class="card">
  <div class="eyebrow">Password Update</div>
  <h1>%s</h1>
  <p>Your administrator set a default password. Replace it now to complete desktop sign-in.</p>
  %s
  <input type="hidden" name="user_code" value="%s" />
  %s
  <label>Email</label>
  <input value="%s" type="email" readonly />
  <label>New password</label>
  <input name="new_password" type="password" autocomplete="new-password" />
  <label>Confirm password</label>
  <input name="confirm_password" type="password" autocomplete="new-password" />
  <button type="submit">Save password</button>
</form>`, html.EscapeString(title), renderInlineMessage(message), html.EscapeString(userCode), callbackHiddenInput(callbackURL), html.EscapeString(email))
	renderHTML(w, http.StatusOK, "Change Password", body)
}

func (s *Server) renderDeviceMessagePage(w http.ResponseWriter, status int, title, message, action string, success bool, callbackURL string) {
	className := "card"
	if success {
		className += " success"
	}
	if success {
		action += deviceSuccessAction(callbackURL)
	}
	body := fmt.Sprintf(`
<section class="%s">
  <div class="eyebrow">Desktop Access</div>
  <h1>%s</h1>
  <p>%s</p>
  %s
</section>`, className, html.EscapeString(title), html.EscapeString(message), action)
	renderHTML(w, status, title, body)
}

func renderInlineMessage(message string) string {
	if strings.TrimSpace(message) == "" {
		return ""
	}
	return `<div class="message">` + html.EscapeString(message) + `</div>`
}

func renderHTML(w http.ResponseWriter, status int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>%s</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font-family: "Segoe UI", sans-serif; background: #f3f0e8; color: #1f2933; display: grid; place-items: center; padding: 24px; }
    .card { width: min(420px, 100%%); background: #fffdf8; border: 1px solid #d9d0bf; border-radius: 16px; padding: 24px; box-shadow: 0 20px 50px rgba(31, 41, 51, 0.08); }
    .success { border-color: #9ac6a3; }
    .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #9a5b2a; margin-bottom: 10px; }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
    p { margin: 0 0 16px; color: #52606d; line-height: 1.5; }
    label { display: block; margin: 14px 0 6px; font-size: 14px; font-weight: 600; }
    input { width: 100%%; border: 1px solid #cbd2d9; border-radius: 10px; padding: 11px 12px; font: inherit; background: #fff; }
    button { width: 100%%; margin-top: 18px; border: 0; border-radius: 10px; padding: 12px; font: inherit; font-weight: 700; background: #9a5b2a; color: #fff; cursor: pointer; }
    .message { margin-bottom: 14px; border-radius: 10px; padding: 10px 12px; background: #fff1e6; color: #9a3412; font-size: 14px; }
  </style>
</head>
<body>%s</body>
</html>`, html.EscapeString(title), body)
}

func cookieSecure() bool {
	return env("SLINGER_COOKIE_SECURE", "false") == "true"
}

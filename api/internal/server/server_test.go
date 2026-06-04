package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"slinger-cloud-api/api/internal/store"
)

func TestDeviceFlowWorkspaceLifecycle(t *testing.T) {
	srv := New(store.New())
	adminToken := deviceLogin(t, srv, "slinger-admin-dashboard", "Bootstrap Admin")

	createResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Acme Core API",
		"slug": "acme-core-api",
	})
	if createResp.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", createResp.Code, createResp.Body.String())
	}

	meResp := doJSON(t, srv, http.MethodGet, "/v1/me", adminToken, nil)
	if meResp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", meResp.Code)
	}

	adminHealth := doJSON(t, srv, http.MethodGet, "/v1/admin/health", adminToken, nil)
	if adminHealth.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", adminHealth.Code)
	}
}

func TestBrowserSessionAuth(t *testing.T) {
	srv := New(store.New())
	login := doJSON(t, srv, http.MethodPost, "/v1/auth/browser/login", "", map[string]any{
		"email":         "admin@example.com",
		"display_name":  "Admin",
		"platform_role": "platform_admin",
	})
	if login.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func deviceLogin(t *testing.T, srv *Server, clientName, deviceName string) string {
	t.Helper()
	start := doJSON(t, srv, http.MethodPost, "/v1/auth/device/start", "", map[string]any{
		"client_name": clientName,
		"device_name": deviceName,
	})
	if start.Code != http.StatusOK {
		t.Fatalf("device start failed: %d %s", start.Code, start.Body.String())
	}
	var started map[string]any
	decodeBody(t, start, &started)
	poll := doJSON(t, srv, http.MethodPost, "/v1/auth/device/poll", "", map[string]any{
		"device_code": started["device_code"],
	})
	if poll.Code != http.StatusOK {
		t.Fatalf("device poll failed: %d %s", poll.Code, poll.Body.String())
	}
	var payload map[string]any
	decodeBody(t, poll, &payload)
	return payload["access_token"].(string)
}

func doJSON(t *testing.T, srv *Server, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	return rr
}

func decodeBody(t *testing.T, rr *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(rr.Body.Bytes(), target); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
}

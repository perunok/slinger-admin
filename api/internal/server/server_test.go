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
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	createResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Acme Core API",
		"slug": "acme-core-api",
	})
	if createResp.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", createResp.Code, createResp.Body.String())
	}

	duplicateSlugResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Another API",
		"slug": "acme-core-api",
	})
	if duplicateSlugResp.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for duplicate workspace slug, got %d: %s", duplicateSlugResp.Code, duplicateSlugResp.Body.String())
	}

	duplicateNameResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Acme Core API",
		"slug": "acme-core-api-2",
	})
	if duplicateNameResp.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for duplicate workspace name, got %d: %s", duplicateNameResp.Code, duplicateNameResp.Body.String())
	}

	meResp := doJSON(t, srv, http.MethodGet, "/v1/account/me", adminToken, nil)
	if meResp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", meResp.Code)
	}

	adminHealth := doJSON(t, srv, http.MethodGet, "/v1/admin/health", adminToken, nil)
	if adminHealth.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", adminHealth.Code)
	}
}

func TestBrowserSessionAuth(t *testing.T) {
	srv := New(newTestStore(t))
	login := doJSON(t, srv, http.MethodPost, "/v1/account/browser/login", "", map[string]any{
		"username": "bootstrap-admin",
		"password": "test-pass",
	})
	if login.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	req := httptest.NewRequest(http.MethodGet, "/v1/account/me", nil)
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDashboardBrowserLoginRejectsOrdinaryUser(t *testing.T) {
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	createUser := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "alice",
		"email":         "alice@example.com",
		"display_name":  "Alice",
		"password":      "Default123",
		"platform_role": "user",
	})
	if createUser.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating user, got %d: %s", createUser.Code, createUser.Body.String())
	}

	login := doJSON(t, srv, http.MethodPost, "/v1/account/browser/login", "", map[string]any{
		"username": "alice",
		"password": "Default123",
	})
	if login.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", login.Code, login.Body.String())
	}
}

func TestAdminUserCreationRejectsDuplicateUsernameAndEmail(t *testing.T) {
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	first := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "alice",
		"email":         "alice@example.com",
		"display_name":  "Alice",
		"password":      "Default123",
		"platform_role": "user",
	})
	if first.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating user, got %d: %s", first.Code, first.Body.String())
	}

	duplicateUsername := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "alice",
		"email":         "alice-2@example.com",
		"display_name":  "Alice Two",
		"password":      "Default123",
		"platform_role": "user",
	})
	if duplicateUsername.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for duplicate username, got %d: %s", duplicateUsername.Code, duplicateUsername.Body.String())
	}

	duplicateEmail := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "alice-two",
		"email":         "alice@example.com",
		"display_name":  "Alice Two",
		"password":      "Default123",
		"platform_role": "user",
	})
	if duplicateEmail.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for duplicate email, got %d: %s", duplicateEmail.Code, duplicateEmail.Body.String())
	}
}

func TestWorkspaceAdminModerationAndResolution(t *testing.T) {
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	createUser := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "alice",
		"email":         "alice@example.com",
		"display_name":  "Alice",
		"password":      "Default123",
		"platform_role": "user",
	})
	if createUser.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating user, got %d: %s", createUser.Code, createUser.Body.String())
	}

	createWorkspace := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Hosted Workspace",
		"slug": "hosted-workspace",
	})
	if createWorkspace.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating workspace, got %d: %s", createWorkspace.Code, createWorkspace.Body.String())
	}
	var workspacePayload map[string]any
	decodeBody(t, createWorkspace, &workspacePayload)
	workspace := workspacePayload["workspace"].(map[string]any)
	workspaceID := workspace["id"].(string)

	inviteResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/invites", adminToken, map[string]any{
		"email": "alice@example.com",
		"role":  "editor",
	})
	if inviteResp.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating invite, got %d: %s", inviteResp.Code, inviteResp.Body.String())
	}
	var invitePayload map[string]any
	decodeBody(t, inviteResp, &invitePayload)
	if invitePayload["action"].(string) != "added" {
		t.Fatalf("expected existing user add to return action=added, got %v", invitePayload["action"])
	}

	createInviteResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/invites", adminToken, map[string]any{
		"email": "newuser@example.com",
		"role":  "viewer",
	})
	if createInviteResp.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating invite, got %d: %s", createInviteResp.Code, createInviteResp.Body.String())
	}
	var createInvitePayload map[string]any
	decodeBody(t, createInviteResp, &createInvitePayload)
	if createInvitePayload["action"].(string) != "invited" {
		t.Fatalf("expected missing user add to return action=invited, got %v", createInvitePayload["action"])
	}
	inviteID := createInvitePayload["invite"].(map[string]any)["id"].(string)

	invitesResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/settings/invites", adminToken, nil)
	if invitesResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing invites, got %d: %s", invitesResp.Code, invitesResp.Body.String())
	}

	revokeResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/invites/"+inviteID+"/revoke", adminToken, map[string]any{})
	if revokeResp.Code != http.StatusOK {
		t.Fatalf("expected 200 revoking invite, got %d: %s", revokeResp.Code, revokeResp.Body.String())
	}

	aliceToken := browserDeviceLogin(t, srv, "alice", "Default123", true)
	joinResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/join-requests", aliceToken, map[string]any{
		"message":        "Need access",
		"requested_role": "viewer",
	})
	if joinResp.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating join request, got %d: %s", joinResp.Code, joinResp.Body.String())
	}
	var joinPayload map[string]any
	decodeBody(t, joinResp, &joinPayload)
	joinID := joinPayload["join_request"].(map[string]any)["id"].(string)

	listJoinResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/settings/join-requests", adminToken, nil)
	if listJoinResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing join requests, got %d: %s", listJoinResp.Code, listJoinResp.Body.String())
	}

	rejectResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/join-requests/"+joinID+"/reject", adminToken, map[string]any{})
	if rejectResp.Code != http.StatusOK {
		t.Fatalf("expected 200 rejecting join request, got %d: %s", rejectResp.Code, rejectResp.Body.String())
	}

	hostResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/hosts", adminToken, map[string]any{
		"host": "acme.sling.example.com",
		"kind": "dedicated_subdomain",
	})
	if hostResp.Code != http.StatusOK {
		t.Fatalf("expected 200 adding host, got %d: %s", hostResp.Code, hostResp.Body.String())
	}

	resolveResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/resolve?host=acme.sling.example.com", adminToken, nil)
	if resolveResp.Code != http.StatusOK {
		t.Fatalf("expected 200 resolving workspace by host, got %d: %s", resolveResp.Code, resolveResp.Body.String())
	}

	adminDetailResp := doJSON(t, srv, http.MethodGet, "/v1/admin/workspaces/"+workspaceID, adminToken, nil)
	if adminDetailResp.Code != http.StatusOK {
		t.Fatalf("expected 200 getting workspace detail, got %d: %s", adminDetailResp.Code, adminDetailResp.Body.String())
	}

	userWorkspaceCreate := doJSON(t, srv, http.MethodPost, "/v1/workspaces", aliceToken, map[string]any{
		"name": "Forbidden Workspace",
		"slug": "forbidden-workspace",
	})
	if userWorkspaceCreate.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for user workspace creation, got %d: %s", userWorkspaceCreate.Code, userWorkspaceCreate.Body.String())
	}
}

func TestSyncPushMaterializesWorkspaceResources(t *testing.T) {
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	createWorkspace := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Publish Target",
		"slug": "publish-target",
	})
	if createWorkspace.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating workspace, got %d: %s", createWorkspace.Code, createWorkspace.Body.String())
	}
	var workspacePayload map[string]any
	decodeBody(t, createWorkspace, &workspacePayload)
	workspaceID := workspacePayload["workspace"].(map[string]any)["id"].(string)

	pushResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/sync/push", adminToken, map[string]any{
		"client_id":       "client-1",
		"base_checkpoint": 0,
		"operations": []map[string]any{
			{
				"operation_id":  "op-col",
				"resource_type": "collection",
				"resource_id":   "col-local-1",
				"op":            "upsert",
				"base_version":  0,
				"payload": map[string]any{
					"name": "Imported Collection",
				},
			},
			{
				"operation_id":  "op-req",
				"resource_type": "request",
				"resource_id":   "req-local-1",
				"op":            "upsert",
				"base_version":  0,
				"payload": map[string]any{
					"collection_id": "col-local-1",
					"name":          "List Users",
					"method":        "GET",
					"url":           "https://example.com/users",
					"document_json": `{"name":"List Users"}`,
				},
			},
			{
				"operation_id":  "op-env",
				"resource_type": "environment",
				"resource_id":   "env-local-1",
				"op":            "upsert",
				"base_version":  0,
				"payload": map[string]any{
					"name": "Production",
				},
			},
			{
				"operation_id":  "op-var",
				"resource_type": "environment_variable",
				"resource_id":   "var-local-1",
				"op":            "upsert",
				"base_version":  0,
				"payload": map[string]any{
					"environment_id": "env-local-1",
					"key":            "base_url",
					"value":          "https://example.com",
					"is_secret":      false,
				},
			},
		},
	})
	if pushResp.Code != http.StatusOK {
		t.Fatalf("expected 200 pushing operations, got %d: %s", pushResp.Code, pushResp.Body.String())
	}

	collectionsResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/collections", adminToken, nil)
	if collectionsResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing collections, got %d: %s", collectionsResp.Code, collectionsResp.Body.String())
	}
	var collectionsPayload map[string]any
	decodeBody(t, collectionsResp, &collectionsPayload)
	if len(collectionsPayload["items"].([]any)) != 1 {
		t.Fatalf("expected 1 collection after sync push, got %v", collectionsPayload["items"])
	}

	requestsResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/collections/col-local-1/requests", adminToken, nil)
	if requestsResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing requests, got %d: %s", requestsResp.Code, requestsResp.Body.String())
	}
	var requestsPayload map[string]any
	decodeBody(t, requestsResp, &requestsPayload)
	if len(requestsPayload["items"].([]any)) != 1 {
		t.Fatalf("expected 1 request after sync push, got %v", requestsPayload["items"])
	}

	environmentsResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/environments", adminToken, nil)
	if environmentsResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing environments, got %d: %s", environmentsResp.Code, environmentsResp.Body.String())
	}
	var environmentsPayload map[string]any
	decodeBody(t, environmentsResp, &environmentsPayload)
	if len(environmentsPayload["items"].([]any)) != 1 {
		t.Fatalf("expected 1 environment after sync push, got %v", environmentsPayload["items"])
	}

	variablesResp := doJSON(t, srv, http.MethodGet, "/v1/workspaces/"+workspaceID+"/environments/env-local-1/variables", adminToken, nil)
	if variablesResp.Code != http.StatusOK {
		t.Fatalf("expected 200 listing variables, got %d: %s", variablesResp.Code, variablesResp.Body.String())
	}
	var variablesPayload map[string]any
	decodeBody(t, variablesResp, &variablesPayload)
	if len(variablesPayload["items"].([]any)) != 1 {
		t.Fatalf("expected 1 variable after sync push, got %v", variablesPayload["items"])
	}
}

func TestEditorCanPublishToLinkedRemoteWorkspace(t *testing.T) {
	srv := New(newTestStore(t))
	adminToken := browserDeviceLogin(t, srv, "bootstrap-admin", "test-pass", false)

	createUser := doJSON(t, srv, http.MethodPost, "/v1/admin/users", adminToken, map[string]any{
		"username":      "ed",
		"email":         "ed@example.com",
		"display_name":  "Editor User",
		"password":      "Default123",
		"platform_role": "user",
	})
	if createUser.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating user, got %d: %s", createUser.Code, createUser.Body.String())
	}

	createWorkspace := doJSON(t, srv, http.MethodPost, "/v1/workspaces", adminToken, map[string]any{
		"name": "Remote Workspace",
		"slug": "remote-workspace",
	})
	if createWorkspace.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating workspace, got %d: %s", createWorkspace.Code, createWorkspace.Body.String())
	}
	var workspacePayload map[string]any
	decodeBody(t, createWorkspace, &workspacePayload)
	workspaceID := workspacePayload["workspace"].(map[string]any)["id"].(string)

	addEditor := doJSON(t, srv, http.MethodPost, "/v1/workspaces/"+workspaceID+"/settings/invites", adminToken, map[string]any{
		"email": "ed@example.com",
		"role":  "editor",
	})
	if addEditor.Code != http.StatusCreated {
		t.Fatalf("expected 201 adding editor, got %d: %s", addEditor.Code, addEditor.Body.String())
	}

	editorToken := browserDeviceLogin(t, srv, "ed", "Default123", true)
	publishResp := doJSON(t, srv, http.MethodPost, "/v1/workspaces/publish", editorToken, map[string]any{
		"local_workspace": map[string]any{
			"name":          "Different Local Name",
			"proposed_slug": "remote-workspace",
		},
		"remote_workspace_id": workspaceID,
		"publish_mode":        "attach_existing",
		"client": map[string]any{
			"client_id":   "desktop-client-1",
			"device_name": "Editor Laptop",
		},
	})
	if publishResp.Code != http.StatusOK {
		t.Fatalf("expected 200 publish as editor, got %d: %s", publishResp.Code, publishResp.Body.String())
	}
}

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	t.Setenv("SLINGER_ADMIN_BOOTSTRAP", `[{"username":"bootstrap-admin","password":"test-pass","email":"admin@example.com","display_name":"Bootstrap Admin","platform_role":"super_admin"}]`)
	return store.New()
}

func browserDeviceLogin(t *testing.T, srv *Server, username, password string, mustChangePassword bool) string {
	t.Helper()
	start := doJSON(t, srv, http.MethodPost, "/v1/account/device/start", "", map[string]any{
		"client_name": "slinger-desktop",
		"device_name": "Desktop",
	})
	if start.Code != http.StatusOK {
		t.Fatalf("device start failed: %d %s", start.Code, start.Body.String())
	}
	var started map[string]any
	decodeBody(t, start, &started)

	email := username + "@example.com"
	if username == "bootstrap-admin" {
		email = "admin@example.com"
	}

	identifyForm := bytes.NewBufferString("user_code=" + started["user_code"].(string) + "&email=" + email)
	identifyReq := httptest.NewRequest(http.MethodPost, "/device/identify", identifyForm)
	identifyReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	identifyResp := httptest.NewRecorder()
	srv.ServeHTTP(identifyResp, identifyReq)
	if identifyResp.Code != http.StatusSeeOther {
		t.Fatalf("expected redirect to email sign-in step, got %d: %s", identifyResp.Code, identifyResp.Body.String())
	}

	loginForm := bytes.NewBufferString("user_code=" + started["user_code"].(string) + "&email=" + email + "&password=" + password)
	loginReq := httptest.NewRequest(http.MethodPost, "/device/login", loginForm)
	loginReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	loginResp := httptest.NewRecorder()
	srv.ServeHTTP(loginResp, loginReq)

	if mustChangePassword {
		if loginResp.Code != http.StatusSeeOther {
			t.Fatalf("expected redirect to password page, got %d: %s", loginResp.Code, loginResp.Body.String())
		}
		cookie := loginResp.Result().Cookies()[0]
		changeForm := bytes.NewBufferString("user_code=" + started["user_code"].(string) + "&new_password=Changed123&confirm_password=Changed123")
		changeReq := httptest.NewRequest(http.MethodPost, "/device/password", changeForm)
		changeReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		changeReq.AddCookie(cookie)
		changeResp := httptest.NewRecorder()
		srv.ServeHTTP(changeResp, changeReq)
		if changeResp.Code != http.StatusOK {
			t.Fatalf("password change failed: %d %s", changeResp.Code, changeResp.Body.String())
		}
		password = "Changed123"
	} else {
		if loginResp.Code != http.StatusOK {
			t.Fatalf("device browser login failed: %d %s", loginResp.Code, loginResp.Body.String())
		}
	}

	poll := doJSON(t, srv, http.MethodPost, "/v1/account/device/poll", "", map[string]any{
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

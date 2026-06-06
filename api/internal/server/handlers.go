package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"slinger-cloud-api/api/internal/model"
)

func (s *Server) deviceStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientName string `json:"client_name"`
		DeviceName string `json:"device_name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	flow := s.store.DeviceStart(req.ClientName, req.DeviceName)
	writeJSON(w, http.StatusOK, map[string]any{
		"device_code":               flow.DeviceCode,
		"user_code":                 flow.UserCode,
		"verification_uri":          strings.TrimRight(env("SLINGER_BASE_URL", "http://localhost:8080"), "/") + "/device",
		"verification_uri_complete": strings.TrimRight(env("SLINGER_BASE_URL", "http://localhost:8080"), "/") + "/device?user_code=" + flow.UserCode,
		"expires_in":                600,
		"interval":                  5,
	})
}

func (s *Server) devicePoll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		DeviceCode string `json:"device_code"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	user, _, err := s.store.DevicePoll(req.DeviceCode)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", err.Error(), nil)
		return
	}
	if user == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "pending"})
		return
	}
	access, err := s.store.CreateAccessToken(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error(), nil)
		return
	}
	refresh := s.store.CreateRefreshToken(user.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "approved",
		"access_token":  access,
		"refresh_token": refresh,
		"expires_in":    3600,
		"token_type":    "Bearer",
		"user":          user,
	})
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	user, err := s.store.RefreshUser(req.RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated", err.Error(), nil)
		return
	}
	access, err := s.store.CreateAccessToken(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"refresh_token": req.RefreshToken,
		"expires_in":    3600,
		"token_type":    "Bearer",
	})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	s.store.RevokeRefreshToken(req.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, user *model.User) {
	memberships := []map[string]any{}
	for _, ws := range s.store.WorkspacesForUser(user) {
		memberships = append(memberships, map[string]any{
			"workspace_id": ws.ID,
			"role":         ws.Role,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":                  user,
		"workspace_memberships": memberships,
	})
}

func (s *Server) listWorkspaces(w http.ResponseWriter, user *model.User) {
	views := s.store.WorkspacesForUser(user)
	items := make([]map[string]any, 0, len(views))
	for _, view := range views {
		items = append(items, map[string]any{
			"id": view.ID, "slug": view.Slug, "name": view.Name, "role": view.Role,
			"host_mode": view.HostMode, "created_at": view.CreatedAt, "updated_at": view.UpdatedAt, "version": view.Version,
		})
	}
	writeJSON(w, http.StatusOK, paged(items, nil))
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request, user *model.User) {
	if err := s.requirePlatformAdmin(user); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "admin access required", nil)
		return
	}
	var req struct {
		Name        string `json:"name"`
		Slug        string `json:"slug"`
		Description string `json:"description"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	if req.Slug == "" {
		req.Slug = slugify(req.Name)
	}
	workspace, err := s.store.CreateWorkspace(user, req.Name, req.Slug, req.Description)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	membership, _ := s.store.Membership(workspace.ID, user.ID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"workspace":  workspace,
		"membership": map[string]any{"role": membership.Role},
	})
}

func (s *Server) resolveWorkspace(w http.ResponseWriter, r *http.Request, user *model.User) {
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspace_id"))
	slug := strings.TrimSpace(r.URL.Query().Get("slug"))
	host := strings.TrimSpace(r.URL.Query().Get("host"))

	var (
		workspace *model.Workspace
		err       error
	)
	switch {
	case workspaceID != "":
		workspace, err = s.store.WorkspaceByID(workspaceID)
	case slug != "":
		workspace, err = s.store.WorkspaceBySlug(slug)
	case host != "":
		workspace, err = s.store.WorkspaceByHost(host)
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "workspace_id, slug, or host is required", nil)
		return
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
		return
	}
	if _, _, err := s.requireWorkspaceAccess(user, workspace.ID); err != nil {
		writeError(w, http.StatusForbidden, "workspace_access_denied", err.Error(), map[string]any{"workspace_id": workspace.ID})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": workspace})
}

func (s *Server) publishWorkspace(w http.ResponseWriter, r *http.Request, user *model.User) {
	var req struct {
		LocalWorkspace struct {
			Name         string `json:"name"`
			ProposedSlug string `json:"proposed_slug"`
		} `json:"local_workspace"`
		RemoteWorkspaceID string `json:"remote_workspace_id"`
		PublishMode       string `json:"publish_mode"`
		Client            struct {
			ClientID   string `json:"client_id"`
			DeviceName string `json:"device_name"`
		} `json:"client"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	var workspace *model.Workspace
	var membership *model.Membership
	if req.PublishMode == "attach_existing" {
		if req.RemoteWorkspaceID != "" {
			if existing, err := s.store.WorkspaceByID(req.RemoteWorkspaceID); err == nil {
				workspace = existing
			}
		}
		if workspace == nil {
			if existing, err := s.store.WorkspaceBySlug(req.LocalWorkspace.ProposedSlug); err == nil {
				workspace = existing
			}
		}
		if workspace != nil {
			_, resolvedMembership, err := s.requireWorkspaceAccess(user, workspace.ID)
			if err != nil {
				writeError(w, http.StatusForbidden, "workspace_access_denied", "caller must already have access", nil)
				return
			}
			if !hasAnyWorkspaceRole(resolvedMembership, model.WorkspaceRoleOwner, model.WorkspaceRoleAdmin, model.WorkspaceRoleEditor) {
				writeError(w, http.StatusForbidden, "forbidden", "editor access or higher is required", nil)
				return
			}
			membership = resolvedMembership
		}
	}
	if workspace == nil {
		writeError(w, http.StatusBadRequest, "workspace_required", "select an existing workspace created by an admin", nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workspace":      workspace,
		"membership":     map[string]any{"role": membership.Role},
		"sync_bootstrap": map[string]any{"client_id": req.Client.ClientID, "checkpoint": 0},
	})
}

func (s *Server) handleInviteRoutes(w http.ResponseWriter, r *http.Request, user *model.User) {
	parts := splitPath(r.URL.Path)
	if len(parts) != 4 || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	inviteID := parts[2]
	if parts[1] == "invites" && parts[3] == "accept" {
		s.acceptInvite(w, r, inviteID)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) acceptInvite(w http.ResponseWriter, r *http.Request, inviteID string) {
	var req struct {
		InviteToken string `json:"invite_token"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	if req.InviteToken == "" {
		writeError(w, http.StatusBadRequest, "invite_invalid", "missing invite token", nil)
		return
	}
	membership, invite, err := s.store.AcceptInvite(inviteID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invite_invalid", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workspace_id": invite.WorkspaceID,
		"membership":   map[string]any{"role": membership.Role},
	})
}

func (s *Server) handleAdminRoutes(w http.ResponseWriter, r *http.Request, user *model.User) {
	if err := s.requirePlatformAdmin(user); err != nil {
		writeError(w, http.StatusForbidden, "forbidden", "admin access required", nil)
		return
	}
	parts := splitPath(r.URL.Path)
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/stats":
		users := s.store.Users()
		workspaces := s.store.Workspaces()
		auditLogs := s.store.AuditLogs()
		writeJSON(w, http.StatusOK, map[string]any{
			"users":           len(users),
			"workspaces":      len(workspaces),
			"audit_logs":      len(auditLogs),
			"platform_admins": countPlatformAdmins(users),
		})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/users":
		users := s.store.Users()
		items := make([]*model.User, 0, len(users))
		for _, u := range users {
			items = append(items, u)
		}
		writeJSON(w, http.StatusOK, paged(items, nil))
	case r.Method == http.MethodPost && r.URL.Path == "/v1/admin/users":
		var req struct {
			Username     string             `json:"username"`
			Email        string             `json:"email"`
			DisplayName  string             `json:"display_name"`
			Password     string             `json:"password"`
			PlatformRole model.PlatformRole `json:"platform_role"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		if req.Username == "" || req.Email == "" || req.Password == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "username, email, and password are required", nil)
			return
		}
		u, err := s.store.UpsertUser(req.Username, req.Email, req.DisplayName, req.PlatformRole, req.Password, true)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"user": u})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/workspaces":
		views := s.store.WorkspacesForUser(user)
		items := make([]map[string]any, 0, len(views))
		for _, view := range views {
			items = append(items, map[string]any{
				"id": view.ID, "slug": view.Slug, "name": view.Name, "role": view.Role,
				"host_mode": view.HostMode, "created_at": view.CreatedAt, "updated_at": view.UpdatedAt, "version": view.Version,
			})
		}
		writeJSON(w, http.StatusOK, paged(items, nil))
	case len(parts) == 4 && r.Method == http.MethodGet && parts[0] == "v1" && parts[1] == "admin" && parts[2] == "workspaces":
		workspaceID := parts[3]
		workspace, _, err := s.requireWorkspaceAccess(user, workspaceID)
		if err != nil {
			writeError(w, http.StatusForbidden, "workspace_access_denied", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"workspace": workspace,
			"summary":   s.store.WorkspaceSummary(workspaceID),
		})
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/audit-logs":
		writeJSON(w, http.StatusOK, paged(s.store.AuditLogs(), nil))
	case r.Method == http.MethodGet && r.URL.Path == "/v1/admin/health":
		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "ok",
			"services":  map[string]string{"api": "ok", "postgres": "ok", "redis": "ok", "realtime": "ok"},
			"timestamp": s.store.Now(),
		})
	default:
		http.NotFound(w, r)
	}
}

func countPlatformAdmins(users []*model.User) int {
	total := 0
	for _, user := range users {
		if user.PlatformRole == model.PlatformRoleSuperAdmin || user.PlatformRole == model.PlatformRolePlatformAdmin {
			total++
		}
	}
	return total
}

func (s *Server) handleWorkspaceRoutes(w http.ResponseWriter, r *http.Request, user *model.User) {
	parts := splitPath(r.URL.Path)
	if len(parts) < 3 {
		http.NotFound(w, r)
		return
	}
	workspaceID := parts[2]
	if len(parts) == 5 && parts[3] == "settings" && parts[4] == "join-requests" && r.Method == http.MethodPost {
		workspace, err := s.store.WorkspaceByID(workspaceID)
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
			return
		}
		s.handleJoinRequestRoutes(w, r, user, workspace, nil, []string{parts[0], parts[1], parts[2], parts[4]})
		return
	}
	workspace, membership, err := s.requireWorkspaceAccess(user, workspaceID)
	if err != nil {
		writeError(w, http.StatusForbidden, "workspace_access_denied", err.Error(), map[string]any{"workspace_id": workspaceID})
		return
	}

	if len(parts) == 3 {
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"workspace": workspace, "membership": map[string]any{"role": membership.Role}})
		case http.MethodPatch:
			s.patchWorkspace(w, r, workspace)
		default:
			http.NotFound(w, r)
		}
		return
	}

	switch parts[3] {
	case "audit-logs":
		if r.Method == http.MethodGet && len(parts) == 4 {
			writeJSON(w, http.StatusOK, paged(s.store.AuditLogsForWorkspace(workspace.ID), nil))
			return
		}
		http.NotFound(w, r)
	case "collections":
		s.handleCollectionRoutes(w, r, user, workspace, membership, parts)
	case "folders":
		s.handleFolderRoutes(w, r, user, workspace, membership, parts)
	case "requests":
		s.handleRequestRoutes(w, r, user, workspace, membership, parts)
	case "environments":
		s.handleEnvironmentRoutes(w, r, user, workspace, membership, parts)
	case "sync":
		s.handleSyncRoutes(w, r, user, workspace, parts)
	case "realtime":
		s.handleRealtimeRoutes(w, r, user, workspace, parts)
	case "collab":
		s.handleCollabRoutes(w, r, user, workspace, parts)
	case "settings":
		s.handleWorkspaceSettingsRoutes(w, r, user, workspace, membership, parts)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleWorkspaceSettingsRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if len(parts) < 5 {
		http.NotFound(w, r)
		return
	}

	switch parts[4] {
	case "members":
		settingsParts := append([]string{parts[0], parts[1], parts[2], parts[4]}, parts[5:]...)
		s.handleMembersRoutes(w, r, user, workspace, membership, settingsParts)
	case "invites":
		switch {
		case r.Method == http.MethodGet && len(parts) == 5:
			s.listInvites(w, user, workspace, membership)
		case r.Method == http.MethodPost && len(parts) == 5:
			s.createInvite(w, r, user, workspace)
		case r.Method == http.MethodPost && len(parts) == 7 && parts[6] == "revoke":
			s.revokeInvite(w, user, workspace, membership, parts[5])
		default:
			http.NotFound(w, r)
		}
	case "join-requests":
		settingsParts := append([]string{parts[0], parts[1], parts[2], parts[4]}, parts[5:]...)
		s.handleJoinRequestRoutes(w, r, user, workspace, membership, settingsParts)
	case "hosts":
		settingsParts := append([]string{parts[0], parts[1], parts[2], parts[4]}, parts[5:]...)
		s.handleHostRoutes(w, r, user, workspace, membership, settingsParts)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) canManageMembers(user *model.User, membership *model.Membership) bool {
	return user.PlatformRole == model.PlatformRoleSuperAdmin || user.PlatformRole == model.PlatformRolePlatformAdmin
}

func (s *Server) canEditContent(user *model.User, membership *model.Membership) bool {
	return s.canManageMembers(user, membership) || membership.Role == model.WorkspaceRoleEditor
}

func (s *Server) patchWorkspace(w http.ResponseWriter, r *http.Request, workspace *model.Workspace) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Version     int    `json:"version"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	updated, err := s.store.UpdateWorkspace(workspace.ID, req.Version, ptrIf(req.Name), ptrIf(req.Description))
	if err != nil {
		if err.Error() == "version_mismatch" {
			writeError(w, http.StatusConflict, "version_mismatch", "resource version does not match", nil)
			return
		}
		writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": updated})
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace) {
	membership, _ := s.store.Membership(workspace.ID, user.ID)
	if !s.canManageMembers(user, membership) {
		writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
		return
	}
	var req struct {
		Email string              `json:"email"`
		Role  model.WorkspaceRole `json:"role"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	member, invite, err := s.store.AddWorkspaceUserByEmail(workspace.ID, user, req.Email, req.Role)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
		return
	}
	response := map[string]any{}
	if member != nil {
		response["membership"] = member
		response["action"] = "added"
		writeJSON(w, http.StatusCreated, response)
		return
	}
	response["invite"] = invite
	response["action"] = "invited"
	writeJSON(w, http.StatusCreated, response)
}

func (s *Server) listInvites(w http.ResponseWriter, user *model.User, workspace *model.Workspace, membership *model.Membership) {
	if !s.canManageMembers(user, membership) {
		writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
		return
	}
	writeJSON(w, http.StatusOK, paged(s.store.Invites(workspace.ID), nil))
}

func (s *Server) revokeInvite(w http.ResponseWriter, user *model.User, workspace *model.Workspace, membership *model.Membership, inviteID string) {
	if !s.canManageMembers(user, membership) {
		writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
		return
	}
	invite, err := s.store.InviteByID(inviteID)
	if err != nil || invite.WorkspaceID != workspace.ID {
		writeError(w, http.StatusNotFound, "not_found", "invite not found", nil)
		return
	}
	updated, err := s.store.RevokeInvite(inviteID)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invite": updated})
}

func (s *Server) handleMembersRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if len(parts) == 4 && r.Method == http.MethodGet {
		items := s.store.Members(workspace.ID)
		writeJSON(w, http.StatusOK, paged(items, nil))
		return
	}
	if len(parts) == 5 && r.Method == http.MethodPatch {
		if !s.canManageMembers(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		memberID := parts[4]
		var req struct {
			Role    model.WorkspaceRole `json:"role"`
			Version int                 `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		updated, err := s.store.UpdateMembership(memberID, req.Version, req.Role)
		if err != nil {
			if err.Error() == "version_mismatch" {
				writeError(w, http.StatusConflict, "version_mismatch", "resource version does not match", nil)
				return
			}
			writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"member": updated})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleJoinRequestRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if len(parts) == 4 && r.Method == http.MethodGet {
		if !s.canManageMembers(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		writeJSON(w, http.StatusOK, paged(s.store.JoinRequests(workspace.ID), nil))
		return
	}
	if len(parts) == 4 && r.Method == http.MethodPost {
		var req struct {
			Message       string              `json:"message"`
			RequestedRole model.WorkspaceRole `json:"requested_role"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		joinRequest := s.store.CreateJoinRequest(workspace.ID, user, req.Message, req.RequestedRole)
		writeJSON(w, http.StatusCreated, map[string]any{"join_request": joinRequest})
		return
	}
	if len(parts) == 6 && parts[5] == "approve" && r.Method == http.MethodPost {
		if !s.canManageMembers(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		joinRequestID := parts[4]
		var req struct {
			Role    model.WorkspaceRole `json:"role"`
			Version int                 `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		m, _, err := s.store.ApproveJoinRequest(joinRequestID, req.Role)
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"membership": m})
		return
	}
	if len(parts) == 6 && parts[5] == "reject" && r.Method == http.MethodPost {
		if !s.canManageMembers(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		joinRequestID := parts[4]
		req, err := s.store.JoinRequestByID(joinRequestID)
		if err != nil || req.WorkspaceID != workspace.ID {
			writeError(w, http.StatusNotFound, "not_found", "join request not found", nil)
			return
		}
		rejected, err := s.store.RejectJoinRequest(joinRequestID)
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"join_request": rejected})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleCollectionRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if r.Method == http.MethodGet && len(parts) == 4 {
		writeJSON(w, http.StatusOK, paged(s.store.Collections(workspace.ID), nil))
		return
	}
	if r.Method == http.MethodPost && len(parts) == 4 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"collection": s.store.CreateCollection(workspace.ID, req.Name)})
		return
	}
	if r.Method == http.MethodPatch && len(parts) == 5 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name    string `json:"name"`
			Version int    `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		updated, err := s.store.UpdateCollection(parts[4], req.Version, req.Name)
		if err != nil {
			writeError(w, http.StatusConflict, "version_mismatch", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"collection": updated})
		return
	}
	if len(parts) == 6 && parts[5] == "folders" {
		s.handleFolderRoutes(w, r, user, workspace, membership, []string{parts[0], parts[1], parts[2], "collections", parts[4], "folders"})
		return
	}
	if len(parts) == 6 && parts[5] == "requests" {
		s.handleRequestRoutes(w, r, user, workspace, membership, []string{parts[0], parts[1], parts[2], "collections", parts[4], "requests"})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleFolderRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if r.Method == http.MethodGet && len(parts) == 6 {
		writeJSON(w, http.StatusOK, paged(s.store.FoldersByCollection(parts[4]), nil))
		return
	}
	if r.Method == http.MethodPost && len(parts) == 6 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			ParentFolderID *string `json:"parent_folder_id"`
			Name           string  `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"folder": s.store.CreateFolder(workspace.ID, parts[4], req.Name, req.ParentFolderID)})
		return
	}
	if r.Method == http.MethodPatch && len(parts) == 5 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name           string  `json:"name"`
			ParentFolderID *string `json:"parent_folder_id"`
			Version        int     `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		updated, err := s.store.UpdateFolder(parts[4], req.Version, req.Name, req.ParentFolderID)
		if err != nil {
			writeError(w, http.StatusConflict, "version_mismatch", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"folder": updated})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleRequestRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if r.Method == http.MethodGet && len(parts) == 6 {
		writeJSON(w, http.StatusOK, paged(s.store.RequestsByCollection(parts[4]), nil))
		return
	}
	if r.Method == http.MethodPost && len(parts) == 6 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			FolderID     *string `json:"folder_id"`
			Name         string  `json:"name"`
			Method       string  `json:"method"`
			URL          string  `json:"url"`
			DocumentJSON string  `json:"document_json"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"request": s.store.CreateRequest(workspace.ID, parts[4], req.FolderID, req.Name, req.Method, req.URL, req.DocumentJSON)})
		return
	}
	if r.Method == http.MethodGet && len(parts) == 5 {
		req, err := s.store.RequestByID(parts[4])
		if err != nil {
			writeError(w, http.StatusNotFound, "not_found", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request": req})
		return
	}
	if r.Method == http.MethodPatch && len(parts) == 5 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name         string `json:"name"`
			Method       string `json:"method"`
			URL          string `json:"url"`
			DocumentJSON string `json:"document_json"`
			Version      int    `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		updated, err := s.store.UpdateRequest(parts[4], req.Version, req.Name, req.Method, req.URL, req.DocumentJSON)
		if err != nil {
			writeError(w, http.StatusConflict, "version_mismatch", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"request": updated})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleEnvironmentRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if r.Method == http.MethodGet && len(parts) == 4 {
		writeJSON(w, http.StatusOK, paged(s.store.Environments(workspace.ID), nil))
		return
	}
	if r.Method == http.MethodPost && len(parts) == 4 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"environment": s.store.CreateEnvironment(workspace.ID, req.Name)})
		return
	}
	if r.Method == http.MethodPatch && len(parts) == 5 {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Name    string `json:"name"`
			Version int    `json:"version"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		updated, err := s.store.UpdateEnvironment(parts[4], req.Version, req.Name)
		if err != nil {
			writeError(w, http.StatusConflict, "version_mismatch", err.Error(), nil)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"environment": updated})
		return
	}
	if r.Method == http.MethodGet && len(parts) == 6 && parts[5] == "variables" {
		writeJSON(w, http.StatusOK, paged(s.store.Variables(parts[4]), nil))
		return
	}
	if r.Method == http.MethodPut && len(parts) == 7 && parts[5] == "variables" {
		if !s.canEditContent(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Value    *string `json:"value"`
			IsSecret bool    `json:"is_secret"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		variable := s.store.PutVariable(parts[4], parts[6], req.Value, req.IsSecret)
		writeJSON(w, http.StatusOK, map[string]any{"variable": variable})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleSyncRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, parts []string) {
	if r.Method == http.MethodPost && len(parts) == 5 && parts[4] == "push" {
		var req struct {
			ClientID       string                `json:"client_id"`
			BaseCheckpoint int                   `json:"base_checkpoint"`
			Operations     []model.SyncOperation `json:"operations"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		accepted, rejected, checkpoint := s.store.PushOperations(workspace.ID, req.Operations, req.BaseCheckpoint)
		writeJSON(w, http.StatusOK, map[string]any{"accepted": accepted, "rejected": rejected, "checkpoint": checkpoint})
		return
	}
	if r.Method == http.MethodGet && len(parts) == 5 && parts[4] == "pull" {
		after, _ := strconv.Atoi(r.URL.Query().Get("after_checkpoint"))
		ops, checkpoint := s.store.PullOperations(workspace.ID, after)
		writeJSON(w, http.StatusOK, map[string]any{"operations": ops, "checkpoint": checkpoint})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) registerClient(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientName    string `json:"client_name"`
		ClientVersion string `json:"client_version"`
		DeviceName    string `json:"device_name"`
		Platform      string `json:"platform"`
	}
	_ = decodeJSON(r, &req)
	writeJSON(w, http.StatusOK, map[string]any{"client": s.store.ClientRegister()})
}

func (s *Server) handleRealtimeRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, parts []string) {
	if r.Method == http.MethodPost && len(parts) == 5 && parts[4] == "token" {
		var req struct {
			Channels []string `json:"channels"`
		}
		_ = decodeJSON(r, &req)
		writeJSON(w, http.StatusOK, map[string]any{
			"token":      signedListToken(user.ID, req.Channels),
			"expires_in": 900,
			"channels":   req.Channels,
		})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleCollabRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, parts []string) {
	if r.Method == http.MethodPost && len(parts) == 6 && parts[4] == "rooms" && parts[5] == "token" {
		var req struct {
			RoomKey string `json:"room_key"`
		}
		_ = decodeJSON(r, &req)
		writeJSON(w, http.StatusOK, map[string]any{
			"token":      signedListToken(user.ID, []string{req.RoomKey}),
			"room_key":   req.RoomKey,
			"expires_in": 900,
		})
		return
	}
	http.NotFound(w, r)
}

func (s *Server) handleHostRoutes(w http.ResponseWriter, r *http.Request, user *model.User, workspace *model.Workspace, membership *model.Membership, parts []string) {
	if r.Method == http.MethodGet && len(parts) == 4 {
		writeJSON(w, http.StatusOK, paged(s.store.Hosts(workspace.ID), nil))
		return
	}
	if r.Method == http.MethodPost && len(parts) == 4 {
		if !s.canManageMembers(user, membership) {
			writeError(w, http.StatusForbidden, "forbidden", "insufficient workspace role", nil)
			return
		}
		var req struct {
			Host string         `json:"host"`
			Kind model.HostKind `json:"kind"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), nil)
			return
		}
		host := s.store.WorkspaceHost(workspace.ID, req.Host, req.Kind)
		if req.Kind == model.HostKindCustomDomain {
			writeJSON(w, http.StatusOK, map[string]any{
				"host": host,
				"verification": map[string]any{
					"dns_record_type":  "TXT",
					"dns_record_name":  "_slinger-verify." + req.Host,
					"dns_record_value": "verify-" + strings.TrimPrefix(host.ID, "hst_"),
				},
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"host": host})
		return
	}
	http.NotFound(w, r)
}

func splitPath(path string) []string {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

func decodeJSON(r *http.Request, target any) error {
	if r.Body == nil {
		return errors.New("missing body")
	}
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	return nil
}

func paged[T any](items []T, next *string) map[string]any {
	if next == nil {
		next = ptr("")
	}
	return map[string]any{
		"items": items,
		"page": map[string]any{
			"next_cursor": nil,
			"has_more":    false,
		},
	}
}

func ptr[T any](v T) *T { return &v }

func ptrIf(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

func slugify(value string) string {
	value = strings.ToLower(value)
	value = strings.ReplaceAll(value, " ", "-")
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "workspace"
	}
	return out
}

func signedListToken(userID string, channels []string) string {
	b, _ := json.Marshal(map[string]any{"user_id": userID, "channels": channels})
	return "rt_" + base64.RawURLEncoding.EncodeToString(b)
}

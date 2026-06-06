package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"slinger-cloud-api/api/internal/model"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  platform_role TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL DEFAULT '',
  password_iterations BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sync_sha TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private',
  default_role_for_requests TEXT NOT NULL DEFAULT 'viewer',
  host_mode TEXT NOT NULL DEFAULT 'shared',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  invited_by_user_id TEXT REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  requested_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  collection_id TEXT NOT NULL REFERENCES collections(id),
  parent_folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  collection_id TEXT NOT NULL REFERENCES collections(id),
  folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS variables (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  key TEXT NOT NULL,
  value TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  UNIQUE (environment_id, key)
);

CREATE TABLE IF NOT EXISTS workspace_hosts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  host TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  tls_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS device_flows (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  device_name TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  poll_count BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  checkpoint BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_operations (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  op TEXT NOT NULL,
  base_version BIGINT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  resulting_version BIGINT NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON memberships(workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_workspace ON sync_operations(workspace_id, resulting_version);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sync_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_iterations BIGINT NOT NULL DEFAULT 0;
UPDATE users SET username = COALESCE(username, split_part(email, '@', 1) || '_' || substr(id, 1, 8)) WHERE username IS NULL OR username = '';
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
`

func (s *Store) ensureSchema(ctx context.Context) error {
	if s.db == nil {
		return nil
	}
	_, err := s.db.Exec(ctx, schemaSQL)
	return err
}

func (s *Store) loadFromDB(ctx context.Context) error {
	if s.db == nil {
		return nil
	}
	if err := s.loadUsers(ctx); err != nil {
		return err
	}
	if err := s.loadWorkspaces(ctx); err != nil {
		return err
	}
	if err := s.loadMemberships(ctx); err != nil {
		return err
	}
	if err := s.loadInvites(ctx); err != nil {
		return err
	}
	if err := s.loadJoinRequests(ctx); err != nil {
		return err
	}
	if err := s.loadCollections(ctx); err != nil {
		return err
	}
	if err := s.loadFolders(ctx); err != nil {
		return err
	}
	if err := s.loadRequests(ctx); err != nil {
		return err
	}
	if err := s.loadEnvironments(ctx); err != nil {
		return err
	}
	if err := s.loadVariables(ctx); err != nil {
		return err
	}
	if err := s.loadHosts(ctx); err != nil {
		return err
	}
	if err := s.loadAuditLogs(ctx); err != nil {
		return err
	}
	if err := s.loadRefreshTokens(ctx); err != nil {
		return err
	}
	if err := s.loadSessions(ctx); err != nil {
		return err
	}
	if err := s.loadDeviceFlows(ctx); err != nil {
		return err
	}
	if err := s.loadSyncState(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) loadUsers(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, username, email, display_name, platform_role, must_change_password, password_hash, password_salt, password_iterations, created_at, updated_at FROM users`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var u modelUserRow
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.DisplayName, &u.PlatformRole, &u.MustChangePassword, &u.PasswordHash, &u.PasswordSalt, &u.PasswordIterations, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return err
		}
		user := &model.User{
			ID:                 u.ID,
			Username:           u.Username,
			Email:              u.Email,
			DisplayName:        u.DisplayName,
			PlatformRole:       model.PlatformRole(u.PlatformRole),
			MustChangePassword: u.MustChangePassword,
			PasswordHash:       u.PasswordHash,
			PasswordSalt:       u.PasswordSalt,
			PasswordIterations: int(u.PasswordIterations),
			CreatedAt:          u.CreatedAt,
			UpdatedAt:          u.UpdatedAt,
		}
		s.users[user.ID] = user
		s.usersByUsername[strings.ToLower(user.Username)] = user.ID
		s.usersByEmail[strings.ToLower(user.Email)] = user.ID
	}
	return rows.Err()
}

type modelUserRow struct {
	ID                 string
	Username           string
	Email              string
	DisplayName        string
	PlatformRole       string
	MustChangePassword bool
	PasswordHash       string
	PasswordSalt       string
	PasswordIterations int64
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

func (s *Store) loadWorkspaces(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, slug, name, description, sync_sha, owner_user_id, visibility, default_role_for_requests, host_mode, created_at, updated_at, version FROM workspaces`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, slug, name, description, syncSHA, owner, visibility, defaultRole, hostMode string
			createdAt, updatedAt                                                           time.Time
			version                                                                        int
		)
		if err := rows.Scan(&id, &slug, &name, &description, &syncSHA, &owner, &visibility, &defaultRole, &hostMode, &createdAt, &updatedAt, &version); err != nil {
			return err
		}
		s.workspaces[id] = &model.Workspace{ID: id, Slug: slug, Name: name, Description: description, SyncSHA: syncSHA, OwnerUserID: owner, Visibility: model.Visibility(visibility), DefaultRoleForRequests: model.WorkspaceRole(defaultRole), HostMode: model.HostMode(hostMode), CreatedAt: createdAt, UpdatedAt: updatedAt, Version: version}
	}
	return rows.Err()
}

func (s *Store) loadMemberships(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id, user_id, email, display_name, role, status, joined_at, created_at, updated_at, version FROM memberships`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var m model.Membership
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.UserID, &m.Email, &m.DisplayName, &m.Role, &m.Status, &m.JoinedAt, &m.CreatedAt, &m.UpdatedAt, &m.Version); err != nil {
			return err
		}
		cp := m
		s.memberships[m.ID] = &cp
		s.ensureWorkspaceMembershipsLocked(m.WorkspaceID)
		s.membershipsByWorkspace[m.WorkspaceID][m.UserID] = m.ID
	}
	return rows.Err()
}

func (s *Store) loadInvites(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, email, role, status, invited_by_user_id, expires_at, created_at, updated_at, version FROM invites`, func(rows pgx.Rows) error {
		var invite model.Invite
		var invitedBy *string
		if err := rows.Scan(&invite.ID, &invite.WorkspaceID, &invite.Email, &invite.Role, &invite.Status, &invitedBy, &invite.ExpiresAt, &invite.CreatedAt, &invite.UpdatedAt, &invite.Version); err != nil {
			return err
		}
		if invitedBy != nil {
			invite.InvitedByUserID = *invitedBy
		}
		cp := invite
		s.invites[invite.ID] = &cp
		return nil
	})
}

func (s *Store) loadJoinRequests(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, requester_user_id, message, status, requested_role, created_at, updated_at, version FROM join_requests`, func(rows pgx.Rows) error {
		var jr model.JoinRequest
		if err := rows.Scan(&jr.ID, &jr.WorkspaceID, &jr.RequesterUserID, &jr.Message, &jr.Status, &jr.RequestedRole, &jr.CreatedAt, &jr.UpdatedAt, &jr.Version); err != nil {
			return err
		}
		cp := jr
		s.joinRequests[jr.ID] = &cp
		return nil
	})
}

func (s *Store) loadCollections(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, name, created_at, updated_at, version FROM collections`, func(rows pgx.Rows) error {
		var c model.Collection
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.Name, &c.CreatedAt, &c.UpdatedAt, &c.Version); err != nil {
			return err
		}
		cp := c
		s.collections[c.ID] = &cp
		return nil
	})
}

func (s *Store) loadFolders(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version FROM folders`, func(rows pgx.Rows) error {
		var f model.Folder
		var parent *string
		if err := rows.Scan(&f.ID, &f.WorkspaceID, &f.CollectionID, &parent, &f.Name, &f.CreatedAt, &f.UpdatedAt, &f.Version); err != nil {
			return err
		}
		f.ParentFolderID = parent
		cp := f
		s.folders[f.ID] = &cp
		return nil
	})
}

func (s *Store) loadRequests(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version FROM requests`, func(rows pgx.Rows) error {
		var r model.Request
		var folder *string
		if err := rows.Scan(&r.ID, &r.WorkspaceID, &r.CollectionID, &folder, &r.Name, &r.Method, &r.URL, &r.DocumentJSON, &r.CreatedAt, &r.UpdatedAt, &r.Version); err != nil {
			return err
		}
		r.FolderID = folder
		cp := r
		s.requests[r.ID] = &cp
		return nil
	})
}

func (s *Store) loadEnvironments(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, name, created_at, updated_at, version FROM environments`, func(rows pgx.Rows) error {
		var e model.Environment
		if err := rows.Scan(&e.ID, &e.WorkspaceID, &e.Name, &e.CreatedAt, &e.UpdatedAt, &e.Version); err != nil {
			return err
		}
		cp := e
		s.environments[e.ID] = &cp
		return nil
	})
}

func (s *Store) loadVariables(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, environment_id, key, value, is_secret, created_at, updated_at, version FROM variables`, func(rows pgx.Rows) error {
		var v model.Variable
		var value *string
		if err := rows.Scan(&v.ID, &v.EnvironmentID, &v.Key, &value, &v.IsSecret, &v.CreatedAt, &v.UpdatedAt, &v.Version); err != nil {
			return err
		}
		v.Value = value
		cp := v
		s.variables[v.ID] = &cp
		return nil
	})
}

func (s *Store) loadHosts(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, workspace_id, host, kind, status, tls_status, created_at, updated_at, version FROM workspace_hosts`, func(rows pgx.Rows) error {
		var h model.WorkspaceHost
		if err := rows.Scan(&h.ID, &h.WorkspaceID, &h.Host, &h.Kind, &h.Status, &h.TLSStatus, &h.CreatedAt, &h.UpdatedAt, &h.Version); err != nil {
			return err
		}
		cp := h
		s.hosts[h.ID] = &cp
		return nil
	})
}

func (s *Store) loadAuditLogs(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT id, actor_user_id, action, resource_type, resource_id, workspace_id, details, created_at FROM audit_logs`, func(rows pgx.Rows) error {
		var log model.AuditLog
		var actor, resourceType, resourceID, workspaceID *string
		var details []byte
		if err := rows.Scan(&log.ID, &actor, &log.Action, &resourceType, &resourceID, &workspaceID, &details, &log.CreatedAt); err != nil {
			return err
		}
		if actor != nil {
			log.ActorUserID = *actor
		}
		if resourceType != nil {
			log.ResourceType = *resourceType
		}
		if resourceID != nil {
			log.ResourceID = *resourceID
		}
		if workspaceID != nil {
			log.WorkspaceID = *workspaceID
		}
		_ = json.Unmarshal(details, &log.Details)
		s.auditLogs = append(s.auditLogs, log)
		return nil
	})
}

func (s *Store) loadRefreshTokens(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT token, user_id FROM refresh_tokens`, func(rows pgx.Rows) error {
		var token, userID string
		if err := rows.Scan(&token, &userID); err != nil {
			return err
		}
		s.refreshTokens[token] = userID
		return nil
	})
}

func (s *Store) loadSessions(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT token, user_id FROM sessions`, func(rows pgx.Rows) error {
		var token, userID string
		if err := rows.Scan(&token, &userID); err != nil {
			return err
		}
		s.sessions[token] = userID
		return nil
	})
}

func (s *Store) loadDeviceFlows(ctx context.Context) error {
	return s.loadSimpleTable(ctx, `SELECT device_code, user_code, client_name, device_name, status, user_id, created_at, expires_at, poll_count FROM device_flows`, func(rows pgx.Rows) error {
		var flow model.DeviceFlow
		var userID *string
		if err := rows.Scan(&flow.DeviceCode, &flow.UserCode, &flow.ClientName, &flow.DeviceName, &flow.Status, &userID, &flow.CreatedAt, &flow.ExpiresAt, &flow.PollCount); err != nil {
			return err
		}
		if userID != nil {
			flow.UserID = *userID
		}
		cp := flow
		s.deviceFlows[flow.DeviceCode] = &cp
		return nil
	})
}

func (s *Store) loadSyncState(ctx context.Context) error {
	if err := s.loadSimpleTable(ctx, `SELECT workspace_id, checkpoint FROM sync_checkpoints`, func(rows pgx.Rows) error {
		var workspaceID string
		var checkpoint int
		if err := rows.Scan(&workspaceID, &checkpoint); err != nil {
			return err
		}
		s.checkpoints[workspaceID] = checkpoint
		return nil
	}); err != nil {
		return err
	}
	return s.loadSimpleTable(ctx, `SELECT operation_id, workspace_id, resource_type, resource_id, op, base_version, payload, resulting_version, occurred_at FROM sync_operations`, func(rows pgx.Rows) error {
		var op model.SyncOperation
		var payload []byte
		if err := rows.Scan(&op.OperationID, &op.WorkspaceID, &op.ResourceType, &op.ResourceID, &op.Op, &op.BaseVersion, &payload, &op.ResultingVersion, &op.OccurredAt); err != nil {
			return err
		}
		_ = json.Unmarshal(payload, &op.Payload)
		s.operations[op.WorkspaceID] = append(s.operations[op.WorkspaceID], op)
		return nil
	})
}

func (s *Store) loadSimpleTable(ctx context.Context, query string, fn func(rows pgx.Rows) error) error {
	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) persistUser(ctx context.Context, user *model.User) {
	if s.db == nil || user == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO users (id, username, email, display_name, platform_role, must_change_password, password_hash, password_salt, password_iterations, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email, display_name = EXCLUDED.display_name, platform_role = EXCLUDED.platform_role, must_change_password = EXCLUDED.must_change_password, password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt, password_iterations = EXCLUDED.password_iterations, updated_at = EXCLUDED.updated_at`,
		user.ID, user.Username, user.Email, user.DisplayName, user.PlatformRole, user.MustChangePassword, user.PasswordHash, user.PasswordSalt, user.PasswordIterations, user.CreatedAt, user.UpdatedAt)
}

func (s *Store) persistWorkspace(ctx context.Context, workspace *model.Workspace) {
	if s.db == nil || workspace == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO workspaces (id, slug, name, description, sync_sha, owner_user_id, visibility, default_role_for_requests, host_mode, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, description = EXCLUDED.description, sync_sha = EXCLUDED.sync_sha, owner_user_id = EXCLUDED.owner_user_id, visibility = EXCLUDED.visibility, default_role_for_requests = EXCLUDED.default_role_for_requests, host_mode = EXCLUDED.host_mode, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		workspace.ID, workspace.Slug, workspace.Name, workspace.Description, workspace.SyncSHA, workspace.OwnerUserID, workspace.Visibility, workspace.DefaultRoleForRequests, workspace.HostMode, workspace.CreatedAt, workspace.UpdatedAt, workspace.Version)
	_, _ = s.db.Exec(ctx, `INSERT INTO sync_checkpoints (workspace_id, checkpoint) VALUES ($1, COALESCE((SELECT checkpoint FROM sync_checkpoints WHERE workspace_id = $1), 0))
ON CONFLICT (workspace_id) DO NOTHING`, workspace.ID)
}

func (s *Store) persistMembership(ctx context.Context, membership *model.Membership) {
	if s.db == nil || membership == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO memberships (id, workspace_id, user_id, email, display_name, role, status, joined_at, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role, status = EXCLUDED.status, joined_at = EXCLUDED.joined_at, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		membership.ID, membership.WorkspaceID, membership.UserID, membership.Email, membership.DisplayName, membership.Role, membership.Status, membership.JoinedAt, membership.CreatedAt, membership.UpdatedAt, membership.Version)
}

func (s *Store) persistInvite(ctx context.Context, invite *model.Invite) {
	if s.db == nil || invite == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO invites (id, workspace_id, email, role, status, invited_by_user_id, expires_at, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		invite.ID, invite.WorkspaceID, invite.Email, invite.Role, invite.Status, nullString(invite.InvitedByUserID), invite.ExpiresAt, invite.CreatedAt, invite.UpdatedAt, invite.Version)
}

func (s *Store) persistJoinRequest(ctx context.Context, req *model.JoinRequest) {
	if s.db == nil || req == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO join_requests (id, workspace_id, requester_user_id, message, status, requested_role, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		req.ID, req.WorkspaceID, req.RequesterUserID, req.Message, req.Status, req.RequestedRole, req.CreatedAt, req.UpdatedAt, req.Version)
}

func (s *Store) persistCollection(ctx context.Context, c *model.Collection) {
	if s.db == nil || c == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO collections (id, workspace_id, name, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		c.ID, c.WorkspaceID, c.Name, c.CreatedAt, c.UpdatedAt, c.Version)
}

func (s *Store) persistFolder(ctx context.Context, f *model.Folder) {
	if s.db == nil || f == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO folders (id, workspace_id, collection_id, parent_folder_id, name, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (id) DO UPDATE SET parent_folder_id = EXCLUDED.parent_folder_id, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		f.ID, f.WorkspaceID, f.CollectionID, nullStringPtr(f.ParentFolderID), f.Name, f.CreatedAt, f.UpdatedAt, f.Version)
}

func (s *Store) persistRequest(ctx context.Context, r *model.Request) {
	if s.db == nil || r == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO requests (id, workspace_id, collection_id, folder_id, name, method, url, document_json, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (id) DO UPDATE SET folder_id = EXCLUDED.folder_id, name = EXCLUDED.name, method = EXCLUDED.method, url = EXCLUDED.url, document_json = EXCLUDED.document_json, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		r.ID, r.WorkspaceID, r.CollectionID, nullStringPtr(r.FolderID), r.Name, r.Method, r.URL, r.DocumentJSON, r.CreatedAt, r.UpdatedAt, r.Version)
}

func (s *Store) persistEnvironment(ctx context.Context, e *model.Environment) {
	if s.db == nil || e == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO environments (id, workspace_id, name, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		e.ID, e.WorkspaceID, e.Name, e.CreatedAt, e.UpdatedAt, e.Version)
}

func (s *Store) persistVariable(ctx context.Context, v *model.Variable) {
	if s.db == nil || v == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO variables (id, environment_id, key, value, is_secret, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		v.ID, v.EnvironmentID, v.Key, v.Value, v.IsSecret, v.CreatedAt, v.UpdatedAt, v.Version)
}

func (s *Store) persistHost(ctx context.Context, h *model.WorkspaceHost) {
	if s.db == nil || h == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO workspace_hosts (id, workspace_id, host, kind, status, tls_status, created_at, updated_at, version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (id) DO UPDATE SET host = EXCLUDED.host, kind = EXCLUDED.kind, status = EXCLUDED.status, tls_status = EXCLUDED.tls_status, updated_at = EXCLUDED.updated_at, version = EXCLUDED.version`,
		h.ID, h.WorkspaceID, h.Host, h.Kind, h.Status, h.TLSStatus, h.CreatedAt, h.UpdatedAt, h.Version)
}

func (s *Store) persistAuditLog(ctx context.Context, log model.AuditLog) {
	if s.db == nil {
		return
	}
	details, _ := json.Marshal(log.Details)
	_, _ = s.db.Exec(ctx, `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, workspace_id, details, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		log.ID, nullString(log.ActorUserID), log.Action, log.ResourceType, log.ResourceID, log.WorkspaceID, details, log.CreatedAt)
}

func (s *Store) persistRefreshToken(ctx context.Context, token, userID string) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO refresh_tokens (token, user_id, created_at) VALUES ($1,$2,$3)
ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`,
		token, userID, s.now())
}

func (s *Store) deleteRefreshToken(ctx context.Context, token string) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `DELETE FROM refresh_tokens WHERE token = $1`, token)
}

func (s *Store) persistSession(ctx context.Context, token, userID string) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)
ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`, token, userID, s.now())
}

func (s *Store) deleteSession(ctx context.Context, token string) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `DELETE FROM sessions WHERE token = $1`, token)
}

func (s *Store) deleteWorkspaceRecords(ctx context.Context, workspaceID string) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `DELETE FROM sync_operations WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM sync_checkpoints WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM audit_logs WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM workspace_hosts WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM join_requests WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM invites WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM memberships WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM variables WHERE environment_id IN (SELECT id FROM environments WHERE workspace_id = $1)`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM environments WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM requests WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM folders WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM collections WHERE workspace_id = $1`, workspaceID)
	_, _ = s.db.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, workspaceID)
}

func (s *Store) persistDeviceFlow(ctx context.Context, flow *model.DeviceFlow) {
	if s.db == nil || flow == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO device_flows (device_code, user_code, client_name, device_name, status, user_id, created_at, expires_at, poll_count)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (device_code) DO UPDATE SET status = EXCLUDED.status, user_id = EXCLUDED.user_id, poll_count = EXCLUDED.poll_count`,
		flow.DeviceCode, flow.UserCode, flow.ClientName, flow.DeviceName, flow.Status, nullString(flow.UserID), flow.CreatedAt, flow.ExpiresAt, flow.PollCount)
}

func (s *Store) persistSyncCheckpoint(ctx context.Context, workspaceID string, checkpoint int) {
	if s.db == nil {
		return
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO sync_checkpoints (workspace_id, checkpoint) VALUES ($1,$2)
ON CONFLICT (workspace_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint`, workspaceID, checkpoint)
}

func (s *Store) persistSyncOperation(ctx context.Context, op model.SyncOperation) {
	if s.db == nil {
		return
	}
	payload, _ := json.Marshal(op.Payload)
	_, _ = s.db.Exec(ctx, `INSERT INTO sync_operations (operation_id, workspace_id, resource_type, resource_id, op, base_version, payload, resulting_version, occurred_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (operation_id) DO UPDATE SET resulting_version = EXCLUDED.resulting_version, payload = EXCLUDED.payload`,
		op.OperationID, op.WorkspaceID, op.ResourceType, op.ResourceID, op.Op, op.BaseVersion, payload, op.ResultingVersion, op.OccurredAt)
}

func nullString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func nullStringPtr(v *string) any {
	if v == nil || *v == "" {
		return nil
	}
	return *v
}

func (s *Store) ensureLoaded() error {
	if s.db == nil {
		return nil
	}
	if len(s.users) == 0 && len(s.workspaces) == 0 {
		return errors.New("store not loaded")
	}
	return nil
}

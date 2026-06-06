package model

import "time"

type PlatformRole string

const (
	PlatformRoleSuperAdmin    PlatformRole = "super_admin"
	PlatformRolePlatformAdmin PlatformRole = "platform_admin"
	PlatformRoleUser          PlatformRole = "user"
)

type WorkspaceRole string

const (
	WorkspaceRoleOwner  WorkspaceRole = "owner"
	WorkspaceRoleAdmin  WorkspaceRole = "admin"
	WorkspaceRoleEditor WorkspaceRole = "editor"
	WorkspaceRoleViewer WorkspaceRole = "viewer"
)

type InviteStatus string

const (
	InviteStatusPending  InviteStatus = "pending"
	InviteStatusAccepted InviteStatus = "accepted"
	InviteStatusRejected InviteStatus = "rejected"
)

type JoinRequestStatus string

const (
	JoinRequestStatusPending  JoinRequestStatus = "pending"
	JoinRequestStatusApproved JoinRequestStatus = "approved"
	JoinRequestStatusRejected JoinRequestStatus = "rejected"
)

type Visibility string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPublic  Visibility = "public"
)

type HostMode string

const (
	HostModeShared             HostMode = "shared"
	HostModeDedicatedSubdomain HostMode = "dedicated_subdomain"
	HostModeCustomDomain       HostMode = "custom_domain"
)

type HostKind string

const (
	HostKindDedicatedSubdomain HostKind = "dedicated_subdomain"
	HostKindCustomDomain       HostKind = "custom_domain"
)

type HostStatus string

const (
	HostStatusActive              HostStatus = "active"
	HostStatusPendingVerification HostStatus = "pending_verification"
)

type TLSStatus string

const (
	TLSStatusPending TLSStatus = "pending"
	TLSStatusReady   TLSStatus = "ready"
)

type User struct {
	ID                 string       `json:"id"`
	Username           string       `json:"username"`
	Email              string       `json:"email"`
	DisplayName        string       `json:"display_name"`
	PlatformRole       PlatformRole `json:"platform_role"`
	MustChangePassword bool         `json:"must_change_password"`
	PasswordHash       string       `json:"-"`
	PasswordSalt       string       `json:"-"`
	PasswordIterations int          `json:"-"`
	CreatedAt          time.Time    `json:"created_at"`
	UpdatedAt          time.Time    `json:"updated_at"`
}

type Workspace struct {
	ID                     string        `json:"id"`
	Slug                   string        `json:"slug"`
	Name                   string        `json:"name"`
	Description            string        `json:"description,omitempty"`
	SyncSHA                string        `json:"sync_sha,omitempty"`
	OwnerUserID            string        `json:"owner_user_id"`
	Visibility             Visibility    `json:"visibility"`
	DefaultRoleForRequests WorkspaceRole `json:"default_role_for_requests,omitempty"`
	HostMode               HostMode      `json:"host_mode"`
	CreatedAt              time.Time     `json:"created_at"`
	UpdatedAt              time.Time     `json:"updated_at"`
	Version                int           `json:"version"`
}

type Membership struct {
	ID          string        `json:"id"`
	WorkspaceID string        `json:"workspace_id"`
	UserID      string        `json:"user_id"`
	Email       string        `json:"email"`
	DisplayName string        `json:"display_name"`
	Role        WorkspaceRole `json:"role"`
	Status      string        `json:"status"`
	JoinedAt    time.Time     `json:"joined_at,omitempty"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
	Version     int           `json:"version"`
}

type Invite struct {
	ID              string        `json:"id"`
	WorkspaceID     string        `json:"workspace_id"`
	Email           string        `json:"email"`
	Role            WorkspaceRole `json:"role"`
	Status          InviteStatus  `json:"status"`
	InvitedByUserID string        `json:"invited_by_user_id,omitempty"`
	ExpiresAt       time.Time     `json:"expires_at,omitempty"`
	CreatedAt       time.Time     `json:"created_at"`
	UpdatedAt       time.Time     `json:"updated_at"`
	Version         int           `json:"version"`
}

type JoinRequest struct {
	ID              string            `json:"id"`
	WorkspaceID     string            `json:"workspace_id"`
	RequesterUserID string            `json:"requester_user_id"`
	Message         string            `json:"message,omitempty"`
	Status          JoinRequestStatus `json:"status"`
	RequestedRole   WorkspaceRole     `json:"requested_role"`
	CreatedAt       time.Time         `json:"created_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
	Version         int               `json:"version"`
}

type Collection struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspace_id"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Version     int       `json:"version"`
}

type Folder struct {
	ID             string    `json:"id"`
	WorkspaceID    string    `json:"workspace_id"`
	CollectionID   string    `json:"collection_id"`
	ParentFolderID *string   `json:"parent_folder_id"`
	Name           string    `json:"name"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	Version        int       `json:"version"`
}

type Request struct {
	ID           string    `json:"id"`
	WorkspaceID  string    `json:"workspace_id"`
	CollectionID string    `json:"collection_id"`
	FolderID     *string   `json:"folder_id"`
	Name         string    `json:"name"`
	Method       string    `json:"method"`
	URL          string    `json:"url"`
	DocumentJSON string    `json:"document_json"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Version      int       `json:"version"`
}

type Environment struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspace_id"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Version     int       `json:"version"`
}

type Variable struct {
	ID            string    `json:"id"`
	EnvironmentID string    `json:"environment_id"`
	Key           string    `json:"key"`
	Value         *string   `json:"value"`
	MaskedValue   string    `json:"masked_value,omitempty"`
	IsSecret      bool      `json:"is_secret"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Version       int       `json:"version"`
}

type Client struct {
	ClientID     string    `json:"client_id"`
	RegisteredAt time.Time `json:"registered_at"`
}

type SyncAccepted struct {
	OperationID      string `json:"operation_id"`
	ResourceID       string `json:"resource_id"`
	ResultingVersion int    `json:"resulting_version"`
}

type SyncRejected struct {
	OperationID string `json:"operation_id"`
	Reason      string `json:"reason"`
	Message     string `json:"message,omitempty"`
}

type SyncOperation struct {
	OperationID      string         `json:"operation_id"`
	WorkspaceID      string         `json:"workspace_id,omitempty"`
	ResourceType     string         `json:"resource_type"`
	ResourceID       string         `json:"resource_id"`
	Op               string         `json:"op"`
	BaseVersion      int            `json:"base_version,omitempty"`
	Payload          map[string]any `json:"payload"`
	ResultingVersion int            `json:"resulting_version,omitempty"`
	OccurredAt       time.Time      `json:"occurred_at"`
}

type WorkspaceHost struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspace_id"`
	Host        string     `json:"host"`
	Kind        HostKind   `json:"kind"`
	Status      HostStatus `json:"status"`
	TLSStatus   TLSStatus  `json:"tls_status"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	Version     int        `json:"version"`
}

type AuditLog struct {
	ID           string         `json:"id"`
	ActorUserID  string         `json:"actor_user_id,omitempty"`
	Action       string         `json:"action"`
	ResourceType string         `json:"resource_type,omitempty"`
	ResourceID   string         `json:"resource_id,omitempty"`
	WorkspaceID  string         `json:"workspace_id,omitempty"`
	Details      map[string]any `json:"details,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
}

type DeviceFlow struct {
	DeviceCode string
	UserCode   string
	ClientName string
	DeviceName string
	Status     string
	UserID     string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	PollCount  int
}

type AuthTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int
	TokenType    string
}

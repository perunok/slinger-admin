package store

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"slinger-cloud-api/api/internal/model"
)

type Claims struct {
	UserID       string             `json:"user_id"`
	Email        string             `json:"email"`
	DisplayName  string             `json:"display_name"`
	PlatformRole model.PlatformRole `json:"platform_role"`
	jwt.RegisteredClaims
}

const (
	accessTokenIssuer   = "slinger-cloud-api"
	accessTokenAudience = "slinger-cloud-api"
)

type Store struct {
	mu sync.RWMutex

	secret string
	now    func() time.Time
	db     *pgxpool.Pool

	users                  map[string]*model.User
	usersByUsername        map[string]string
	usersByEmail           map[string]string
	workspaces             map[string]*model.Workspace
	memberships            map[string]*model.Membership
	membershipsByWorkspace map[string]map[string]string
	invites                map[string]*model.Invite
	joinRequests           map[string]*model.JoinRequest
	collections            map[string]*model.Collection
	folders                map[string]*model.Folder
	requests               map[string]*model.Request
	environments           map[string]*model.Environment
	variables              map[string]*model.Variable
	clients                map[string]*model.Client
	hosts                  map[string]*model.WorkspaceHost
	auditLogs              []model.AuditLog
	deviceFlows            map[string]*model.DeviceFlow
	sessions               map[string]string
	refreshTokens          map[string]string
	operations             map[string][]model.SyncOperation
	checkpoints            map[string]int
}

func New() *Store {
	s := &Store{
		secret:                 os.Getenv("SLINGER_SIGNING_SECRET"),
		now:                    time.Now,
		users:                  map[string]*model.User{},
		usersByUsername:        map[string]string{},
		usersByEmail:           map[string]string{},
		workspaces:             map[string]*model.Workspace{},
		memberships:            map[string]*model.Membership{},
		membershipsByWorkspace: map[string]map[string]string{},
		invites:                map[string]*model.Invite{},
		joinRequests:           map[string]*model.JoinRequest{},
		collections:            map[string]*model.Collection{},
		folders:                map[string]*model.Folder{},
		requests:               map[string]*model.Request{},
		environments:           map[string]*model.Environment{},
		variables:              map[string]*model.Variable{},
		clients:                map[string]*model.Client{},
		hosts:                  map[string]*model.WorkspaceHost{},
		auditLogs:              []model.AuditLog{},
		deviceFlows:            map[string]*model.DeviceFlow{},
		sessions:               map[string]string{},
		refreshTokens:          map[string]string{},
		operations:             map[string][]model.SyncOperation{},
		checkpoints:            map[string]int{},
	}

	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		pool, err := connectPool(context.Background(), dbURL)
		if err != nil {
			panic(err)
		}
		s.db = pool
		if err := s.ensureSchema(context.Background()); err != nil {
			panic(err)
		}
		if err := s.loadFromDB(context.Background()); err != nil {
			panic(err)
		}
	}

	s.bootstrapAdmin()
	return s
}

func connectPool(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		pool, err := pgxpool.New(ctx, dbURL)
		if err != nil {
			lastErr = err
		} else if err = pool.Ping(ctx); err == nil {
			return pool, nil
		} else {
			lastErr = err
			pool.Close()
		}
		time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
	}
	return nil, lastErr
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

type bootstrapAdminConfig struct {
	Username     string             `json:"username"`
	Password     string             `json:"password"`
	Email        string             `json:"email"`
	DisplayName  string             `json:"display_name"`
	PlatformRole model.PlatformRole `json:"platform_role"`
}

func (s *Store) bootstrapAdmin() {
	if s.hasAdminLocked() {
		return
	}
	cfg := firstBootstrapConfig()
	if cfg == nil {
		return
	}
	if cfg.PlatformRole == "" {
		cfg.PlatformRole = model.PlatformRoleSuperAdmin
	}
	if cfg.Username == "" {
		cfg.Username = usernameFromEmail(cfg.Email)
	}
	if cfg.Username == "" || cfg.Password == "" {
		return
	}
	if cfg.DisplayName == "" {
		cfg.DisplayName = "Bootstrap Admin"
	}
	if cfg.Email == "" {
		cfg.Email = cfg.Username + "@slinger.local"
	}
	admin, err := s.UpsertUser(cfg.Username, cfg.Email, cfg.DisplayName, cfg.PlatformRole, cfg.Password, false)
	if err != nil {
		panic(err)
	}
	s.logLocked(admin.ID, "platform.bootstrap", "user", admin.ID, nil)
}

func firstBootstrapConfig() *bootstrapAdminConfig {
	raw := strings.TrimSpace(os.Getenv("SLINGER_ADMIN_BOOTSTRAP"))
	if raw != "" {
		var list []bootstrapAdminConfig
		if err := json.Unmarshal([]byte(raw), &list); err == nil && len(list) > 0 {
			return &list[0]
		}
		var single bootstrapAdminConfig
		if err := json.Unmarshal([]byte(raw), &single); err == nil {
			return &single
		}
	}
	legacyUsername := strings.TrimSpace(os.Getenv("SLINGER_ADMIN_USERNAME"))
	legacyPassword := strings.TrimSpace(os.Getenv("SLINGER_ADMIN_PASSWORD"))
	if legacyUsername == "" || legacyPassword == "" {
		return nil
	}
	return &bootstrapAdminConfig{
		Username:     legacyUsername,
		Password:     legacyPassword,
		Email:        env("SLINGER_ADMIN_EMAIL", legacyUsername+"@slinger.local"),
		DisplayName:  env("SLINGER_ADMIN_NAME", "Bootstrap Admin"),
		PlatformRole: model.PlatformRoleSuperAdmin,
	}
}

func (s *Store) Now() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.now()
}

func (s *Store) CreateAccessToken(user *model.User) (string, error) {
	claims := Claims{
		UserID:       user.ID,
		Email:        user.Email,
		DisplayName:  user.DisplayName,
		PlatformRole: user.PlatformRole,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    accessTokenIssuer,
			Subject:   user.ID,
			Audience:  jwt.ClaimStrings{accessTokenAudience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ID:        randomID("jti"),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(s.signingSecret()))
}

func (s *Store) VerifyAccessToken(token string) (*Claims, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(s.signingSecret()), nil
	}, jwt.WithAudience(accessTokenAudience), jwt.WithIssuer(accessTokenIssuer), jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func (s *Store) CreateRefreshToken(userID string) string {
	token := randomID("rt")
	s.mu.Lock()
	defer s.mu.Unlock()
	hashed := hashToken(token)
	s.refreshTokens[hashed] = userID
	s.persistRefreshToken(context.Background(), hashed, userID)
	return token
}

func (s *Store) CreateBrowserSession(userID string) string {
	token := randomID("ss")
	hashed := hashToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[hashed] = userID
	s.persistSession(context.Background(), hashed, userID)
	return token
}

func (s *Store) UserFromSession(token string) (*model.User, error) {
	s.mu.RLock()
	userID, ok := s.sessions[hashToken(token)]
	s.mu.RUnlock()
	if !ok {
		return nil, errors.New("invalid session")
	}
	return s.UserByID(userID)
}

func (s *Store) RevokeSession(token string) {
	hashed := hashToken(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, hashed)
	s.deleteSession(context.Background(), hashed)
}

func (s *Store) RefreshUser(token string) (*model.User, error) {
	s.mu.RLock()
	userID, ok := s.refreshTokens[hashToken(token)]
	s.mu.RUnlock()
	if !ok {
		return nil, errors.New("invalid refresh token")
	}
	return s.UserByID(userID)
}

func (s *Store) RevokeRefreshToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hashed := hashToken(token)
	delete(s.refreshTokens, hashed)
	s.deleteRefreshToken(context.Background(), hashed)
}

func (s *Store) DeviceStart(clientName, deviceName string) *model.DeviceFlow {
	flow := &model.DeviceFlow{
		DeviceCode: randomID("dc"),
		UserCode:   strings.ToUpper(randomCode(8)),
		ClientName: clientName,
		DeviceName: deviceName,
		Status:     "pending",
		CreatedAt:  s.now(),
		ExpiresAt:  s.now().Add(10 * time.Minute),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deviceFlows[flow.DeviceCode] = flow
	s.persistDeviceFlow(context.Background(), flow)
	return flow
}

func (s *Store) DevicePoll(deviceCode string) (*model.User, *model.DeviceFlow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	flow, ok := s.deviceFlows[deviceCode]
	if !ok {
		return nil, nil, errors.New("invalid_device_code")
	}
	if s.now().After(flow.ExpiresAt) {
		flow.Status = "expired"
		return nil, flow, errors.New("expired")
	}
	if flow.Status == "approved" && flow.UserID != "" {
		user := s.users[flow.UserID]
		return user, flow, nil
	}
	flow.PollCount++
	s.persistDeviceFlow(context.Background(), flow)
	return nil, flow, nil
}

func (s *Store) createUserLocked(username, email, displayName string, role model.PlatformRole, password string, mustChangePassword bool) (*model.User, error) {
	now := s.now()
	email = strings.TrimSpace(email)
	if username == "" {
		username = usernameFromEmail(email)
	}
	if username == "" {
		username = randomID("usr")
	}
	if _, exists := s.usersByUsername[strings.ToLower(username)]; exists {
		return nil, errors.New("username already exists")
	}
	if _, exists := s.usersByEmail[strings.ToLower(email)]; exists {
		return nil, errors.New("email already exists")
	}
	hash, salt, iterations := "", "", 0
	if password != "" {
		var err error
		hash, salt, iterations, err = hashPassword(password)
		if err != nil {
			return nil, err
		}
	}
	user := &model.User{
		ID:                 randomID("usr"),
		Username:           username,
		Email:              email,
		DisplayName:        displayName,
		PlatformRole:       role,
		MustChangePassword: mustChangePassword,
		PasswordHash:       hash,
		PasswordSalt:       salt,
		PasswordIterations: iterations,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	s.users[user.ID] = user
	s.usersByUsername[strings.ToLower(username)] = user.ID
	s.usersByEmail[strings.ToLower(email)] = user.ID
	s.persistUser(context.Background(), user)
	return user, nil
}

func (s *Store) UpsertUser(username, email, displayName string, role model.PlatformRole, password string, mustChangePassword bool) (*model.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	email = strings.TrimSpace(email)
	if username == "" {
		username = usernameFromEmail(email)
	}
	if _, exists := s.usersByUsername[strings.ToLower(username)]; exists {
		return nil, errors.New("username already exists")
	}
	if _, exists := s.usersByEmail[strings.ToLower(email)]; exists {
		return nil, errors.New("email already exists")
	}
	return s.createUserLocked(username, email, displayName, role, password, mustChangePassword)
}

func (s *Store) AuthenticateUser(username, password string) (*model.User, error) {
	s.mu.RLock()
	id, ok := s.usersByUsername[strings.ToLower(strings.TrimSpace(username))]
	if !ok {
		s.mu.RUnlock()
		return nil, errors.New("invalid credentials")
	}
	user := s.users[id]
	s.mu.RUnlock()
	if user == nil || user.PasswordHash == "" || user.PasswordSalt == "" || user.PasswordIterations <= 0 {
		return nil, errors.New("invalid credentials")
	}
	if !verifyPassword(password, user.PasswordSalt, user.PasswordIterations, user.PasswordHash) {
		return nil, errors.New("invalid credentials")
	}
	cp := *user
	return &cp, nil
}

func (s *Store) AuthenticateUserByEmail(email, password string) (*model.User, error) {
	s.mu.RLock()
	id, ok := s.usersByEmail[strings.ToLower(strings.TrimSpace(email))]
	if !ok {
		s.mu.RUnlock()
		return nil, errors.New("invalid credentials")
	}
	user := s.users[id]
	s.mu.RUnlock()
	if user == nil || user.PasswordHash == "" || user.PasswordSalt == "" || user.PasswordIterations <= 0 {
		return nil, errors.New("invalid credentials")
	}
	if !verifyPassword(password, user.PasswordSalt, user.PasswordIterations, user.PasswordHash) {
		return nil, errors.New("invalid credentials")
	}
	cp := *user
	return &cp, nil
}

func (s *Store) UpdatePassword(userID, password string, clearMustChange bool) (*model.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.users[userID]
	if !ok {
		return nil, errors.New("not found")
	}
	hash, salt, iterations, err := hashPassword(password)
	if err != nil {
		return nil, err
	}
	user.PasswordHash = hash
	user.PasswordSalt = salt
	user.PasswordIterations = iterations
	if clearMustChange {
		user.MustChangePassword = false
	}
	user.UpdatedAt = s.now()
	s.persistUser(context.Background(), user)
	cp := *user
	return &cp, nil
}

func (s *Store) hasAdminLocked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, user := range s.users {
		if user.PlatformRole == model.PlatformRoleSuperAdmin || user.PlatformRole == model.PlatformRolePlatformAdmin {
			return true
		}
	}
	return false
}

func usernameFromEmail(email string) string {
	email = strings.TrimSpace(email)
	if email == "" {
		return ""
	}
	if at := strings.Index(email, "@"); at > 0 {
		return strings.ToLower(strings.TrimSpace(email[:at]))
	}
	return strings.ToLower(email)
}

const passwordIterationsDefault = 120000

func hashPassword(password string) (string, string, int, error) {
	if password == "" {
		return "", "", 0, errors.New("password required")
	}
	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", "", 0, err
	}
	salt := base64.RawStdEncoding.EncodeToString(saltBytes)
	derived := pbkdf2SHA256([]byte(password), saltBytes, passwordIterationsDefault, 32)
	return base64.RawStdEncoding.EncodeToString(derived), salt, passwordIterationsDefault, nil
}

func verifyPassword(password, salt string, iterations int, expected string) bool {
	if password == "" || salt == "" || iterations <= 0 || expected == "" {
		return false
	}
	saltBytes, err := base64.RawStdEncoding.DecodeString(salt)
	if err != nil {
		return false
	}
	derived := pbkdf2SHA256([]byte(password), saltBytes, iterations, 32)
	return hmac.Equal([]byte(base64.RawStdEncoding.EncodeToString(derived)), []byte(expected))
}

func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	hashLen := sha256.Size
	blockCount := (keyLen + hashLen - 1) / hashLen
	derived := make([]byte, 0, blockCount*hashLen)
	for block := 1; block <= blockCount; block++ {
		t := pbkdf2Block(password, salt, iterations, block)
		derived = append(derived, t...)
	}
	return derived[:keyLen]
}

func pbkdf2Block(password, salt []byte, iterations, blockIndex int) []byte {
	mac := hmac.New(sha256.New, password)
	block := make([]byte, len(salt)+4)
	copy(block, salt)
	block[len(salt)] = byte(blockIndex >> 24)
	block[len(salt)+1] = byte(blockIndex >> 16)
	block[len(salt)+2] = byte(blockIndex >> 8)
	block[len(salt)+3] = byte(blockIndex)
	mac.Write(block)
	u := mac.Sum(nil)
	out := make([]byte, len(u))
	copy(out, u)
	for i := 1; i < iterations; i++ {
		mac = hmac.New(sha256.New, password)
		mac.Write(u)
		u = mac.Sum(nil)
		for j := range out {
			out[j] ^= u[j]
		}
	}
	return out
}

func (s *Store) UserByID(id string) (*model.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *u
	return &cp, nil
}

func (s *Store) UserByEmail(email string) (*model.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.usersByEmail[strings.ToLower(email)]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *s.users[id]
	return &cp, nil
}

func (s *Store) DeviceFlowByUserCode(userCode string) (*model.DeviceFlow, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	normalized := strings.ToUpper(strings.TrimSpace(userCode))
	for _, flow := range s.deviceFlows {
		if flow.UserCode != normalized {
			continue
		}
		cp := *flow
		return &cp, nil
	}
	return nil, errors.New("not found")
}

func (s *Store) ApproveDeviceFlow(userCode, userID string) (*model.DeviceFlow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized := strings.ToUpper(strings.TrimSpace(userCode))
	for _, flow := range s.deviceFlows {
		if flow.UserCode != normalized {
			continue
		}
		if s.now().After(flow.ExpiresAt) {
			flow.Status = "expired"
			s.persistDeviceFlow(context.Background(), flow)
			return nil, errors.New("expired")
		}
		flow.Status = "approved"
		flow.UserID = userID
		s.persistDeviceFlow(context.Background(), flow)
		cp := *flow
		return &cp, nil
	}
	return nil, errors.New("not found")
}

func (s *Store) Users() []*model.User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*model.User, 0, len(s.users))
	for _, u := range s.users {
		cp := *u
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) CreateWorkspace(owner *model.User, name, slug, description string) (*model.Workspace, error) {
	now := s.now()
	workspace := &model.Workspace{
		ID:                     randomID("wsp"),
		Slug:                   slug,
		Name:                   name,
		Description:            description,
		OwnerUserID:            owner.ID,
		Visibility:             model.VisibilityPrivate,
		DefaultRoleForRequests: model.WorkspaceRoleViewer,
		HostMode:               model.HostModeShared,
		CreatedAt:              now,
		UpdatedAt:              now,
		Version:                1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.workspaces {
		if existing.Name == name {
			return nil, errors.New("workspace name already exists")
		}
		if existing.Slug == slug {
			return nil, errors.New("workspace slug already exists")
		}
	}
	s.workspaces[workspace.ID] = workspace
	s.ensureWorkspaceMembershipsLocked(workspace.ID)
	m := s.upsertMembershipLocked(workspace.ID, owner, model.WorkspaceRoleOwner, "active")
	m.JoinedAt = now
	s.logLocked(owner.ID, "workspace.created", "workspace", workspace.ID, map[string]any{"slug": slug})
	s.persistWorkspace(context.Background(), workspace)
	s.persistMembership(context.Background(), m)
	return workspace, nil
}

func (s *Store) WorkspaceByID(id string) (*model.Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	workspace, ok := s.workspaces[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *workspace
	return &cp, nil
}

func (s *Store) WorkspaceBySlug(slug string) (*model.Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, workspace := range s.workspaces {
		if workspace.Slug == slug {
			cp := *workspace
			return &cp, nil
		}
	}
	return nil, errors.New("not found")
}

func (s *Store) WorkspaceByHost(host string) (*model.Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	host = strings.ToLower(strings.TrimSpace(host))
	for _, binding := range s.hosts {
		if strings.ToLower(binding.Host) != host {
			continue
		}
		workspace, ok := s.workspaces[binding.WorkspaceID]
		if !ok {
			return nil, errors.New("not found")
		}
		cp := *workspace
		return &cp, nil
	}
	return nil, errors.New("not found")
}

func (s *Store) Workspaces() []*model.Workspace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*model.Workspace, 0, len(s.workspaces))
	for _, workspace := range s.workspaces {
		cp := *workspace
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) UpdateWorkspace(id string, version int, name, description *string) (*model.Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace, ok := s.workspaces[id]
	if !ok {
		return nil, errors.New("not found")
	}
	if workspace.Version != version {
		return nil, errors.New("version_mismatch")
	}
	if name != nil {
		workspace.Name = *name
	}
	if description != nil {
		workspace.Description = *description
	}
	workspace.Version++
	workspace.UpdatedAt = s.now()
	s.persistWorkspace(context.Background(), workspace)
	cp := *workspace
	return &cp, nil
}

func (s *Store) WorkspacesForUser(user *model.User) []WorkspaceView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	views := []WorkspaceView{}
	for _, m := range s.memberships {
		if m.UserID != user.ID || m.Status != "active" {
			continue
		}
		workspace := s.workspaces[m.WorkspaceID]
		views = append(views, WorkspaceView{
			Workspace: *workspace,
			Role:      m.Role,
		})
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Workspace.CreatedAt.Before(views[j].Workspace.CreatedAt) })
	return views
}

type WorkspaceView struct {
	model.Workspace
	Role model.WorkspaceRole `json:"role"`
}

func (s *Store) Membership(workspaceID, userID string) (*model.Membership, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.membershipsByWorkspace[workspaceID][userID]
	if !ok {
		return nil, false
	}
	cp := *s.memberships[id]
	return &cp, true
}

func (s *Store) Members(workspaceID string) []*model.Membership {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Membership{}
	for _, m := range s.memberships {
		if m.WorkspaceID != workspaceID {
			continue
		}
		cp := *m
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) MemberByID(memberID string) (*model.Membership, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.memberships[memberID]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *m
	return &cp, nil
}

func (s *Store) UpdateMembership(memberID string, version int, role model.WorkspaceRole) (*model.Membership, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.memberships[memberID]
	if !ok {
		return nil, errors.New("not found")
	}
	if m.Version != version {
		return nil, errors.New("version_mismatch")
	}
	m.Role = role
	m.Version++
	m.UpdatedAt = s.now()
	s.persistMembership(context.Background(), m)
	cp := *m
	return &cp, nil
}

func (s *Store) UpsertMembership(workspaceID string, user *model.User, role model.WorkspaceRole, status string) *model.Membership {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upsertMembershipLocked(workspaceID, user, role, status)
}

func (s *Store) upsertMembershipLocked(workspaceID string, user *model.User, role model.WorkspaceRole, status string) *model.Membership {
	s.ensureWorkspaceMembershipsLocked(workspaceID)
	if id, ok := s.membershipsByWorkspace[workspaceID][user.ID]; ok {
		m := s.memberships[id]
		m.Role = role
		m.Status = status
		m.UpdatedAt = s.now()
		m.Version++
		return m
	}
	now := s.now()
	m := &model.Membership{
		ID:          randomID("mem"),
		WorkspaceID: workspaceID,
		UserID:      user.ID,
		Email:       user.Email,
		DisplayName: user.DisplayName,
		Role:        role,
		Status:      status,
		JoinedAt:    now,
		CreatedAt:   now,
		UpdatedAt:   now,
		Version:     1,
	}
	s.memberships[m.ID] = m
	s.membershipsByWorkspace[workspaceID][user.ID] = m.ID
	s.persistMembership(context.Background(), m)
	return m
}

func (s *Store) ensureWorkspaceMembershipsLocked(workspaceID string) {
	if s.membershipsByWorkspace[workspaceID] == nil {
		s.membershipsByWorkspace[workspaceID] = map[string]string{}
	}
}

func (s *Store) Invite(workspaceID string, inviter *model.User, email string, role model.WorkspaceRole) *model.Invite {
	now := s.now()
	invite := &model.Invite{
		ID:              randomID("inv"),
		WorkspaceID:     workspaceID,
		Email:           email,
		Role:            role,
		Status:          model.InviteStatusPending,
		InvitedByUserID: inviter.ID,
		ExpiresAt:       now.Add(7 * 24 * time.Hour),
		CreatedAt:       now,
		UpdatedAt:       now,
		Version:         1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.invites[invite.ID] = invite
	s.logLocked(inviter.ID, "invite.created", "invite", invite.ID, map[string]any{"workspace_id": workspaceID, "email": email})
	s.persistInvite(context.Background(), invite)
	return invite
}

func (s *Store) AddWorkspaceUserByEmail(workspaceID string, actor *model.User, email string, role model.WorkspaceRole) (*model.Membership, *model.Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return nil, nil, errors.New("email is required")
	}

	if userID, ok := s.usersByEmail[email]; ok {
		user := s.users[userID]
		membership := s.upsertMembershipLocked(workspaceID, user, role, "active")
		s.logLocked(actor.ID, "membership.added", "membership", membership.ID, map[string]any{"workspace_id": workspaceID, "email": user.Email})
		cp := *membership
		return &cp, nil, nil
	}

	now := s.now()
	invite := &model.Invite{
		ID:              randomID("inv"),
		WorkspaceID:     workspaceID,
		Email:           email,
		Role:            role,
		Status:          model.InviteStatusPending,
		InvitedByUserID: actor.ID,
		ExpiresAt:       now.Add(7 * 24 * time.Hour),
		CreatedAt:       now,
		UpdatedAt:       now,
		Version:         1,
	}
	s.invites[invite.ID] = invite
	s.logLocked(actor.ID, "invite.created", "invite", invite.ID, map[string]any{"workspace_id": workspaceID, "email": email})
	s.persistInvite(context.Background(), invite)
	cp := *invite
	return nil, &cp, nil
}

func (s *Store) InviteByID(id string) (*model.Invite, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	invite, ok := s.invites[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *invite
	return &cp, nil
}

func (s *Store) Invites(workspaceID string) []*model.Invite {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Invite{}
	for _, invite := range s.invites {
		if invite.WorkspaceID != workspaceID {
			continue
		}
		cp := *invite
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func (s *Store) AcceptInvite(inviteID string) (*model.Membership, *model.Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	invite, ok := s.invites[inviteID]
	if !ok {
		return nil, nil, errors.New("not found")
	}
	userID, ok := s.usersByEmail[strings.ToLower(invite.Email)]
	if !ok {
		return nil, nil, errors.New("invite_invalid")
	}
	user := s.users[userID]
	m := s.upsertMembershipLocked(invite.WorkspaceID, user, invite.Role, "active")
	invite.Status = model.InviteStatusAccepted
	invite.UpdatedAt = s.now()
	s.logLocked(user.ID, "invite.accepted", "membership", m.ID, map[string]any{"workspace_id": invite.WorkspaceID})
	s.persistInvite(context.Background(), invite)
	s.persistMembership(context.Background(), m)
	cpM := *m
	cpI := *invite
	return &cpM, &cpI, nil
}

func (s *Store) RevokeInvite(inviteID string) (*model.Invite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	invite, ok := s.invites[inviteID]
	if !ok {
		return nil, errors.New("not found")
	}
	invite.Status = model.InviteStatusRejected
	invite.Version++
	invite.UpdatedAt = s.now()
	s.persistInvite(context.Background(), invite)
	cp := *invite
	return &cp, nil
}

func (s *Store) CreateJoinRequest(workspaceID string, requester *model.User, message string, role model.WorkspaceRole) *model.JoinRequest {
	now := s.now()
	req := &model.JoinRequest{
		ID:              randomID("jqr"),
		WorkspaceID:     workspaceID,
		RequesterUserID: requester.ID,
		Message:         message,
		Status:          model.JoinRequestStatusPending,
		RequestedRole:   role,
		CreatedAt:       now,
		UpdatedAt:       now,
		Version:         1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.joinRequests[req.ID] = req
	s.persistJoinRequest(context.Background(), req)
	return req
}

func (s *Store) JoinRequestByID(id string) (*model.JoinRequest, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	req, ok := s.joinRequests[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *req
	return &cp, nil
}

func (s *Store) JoinRequests(workspaceID string) []*model.JoinRequest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.JoinRequest{}
	for _, req := range s.joinRequests {
		if req.WorkspaceID != workspaceID {
			continue
		}
		cp := *req
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func (s *Store) ApproveJoinRequest(joinRequestID string, role model.WorkspaceRole) (*model.Membership, *model.JoinRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.joinRequests[joinRequestID]
	if !ok {
		return nil, nil, errors.New("not found")
	}
	user := s.users[req.RequesterUserID]
	m := s.upsertMembershipLocked(req.WorkspaceID, user, role, "active")
	req.Status = model.JoinRequestStatusApproved
	req.UpdatedAt = s.now()
	s.persistJoinRequest(context.Background(), req)
	s.persistMembership(context.Background(), m)
	cpM := *m
	cpR := *req
	return &cpM, &cpR, nil
}

func (s *Store) RejectJoinRequest(joinRequestID string) (*model.JoinRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.joinRequests[joinRequestID]
	if !ok {
		return nil, errors.New("not found")
	}
	req.Status = model.JoinRequestStatusRejected
	req.Version++
	req.UpdatedAt = s.now()
	s.persistJoinRequest(context.Background(), req)
	cp := *req
	return &cp, nil
}

func (s *Store) Collections(workspaceID string) []*model.Collection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Collection{}
	for _, c := range s.collections {
		if c.WorkspaceID == workspaceID {
			cp := *c
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) CreateCollection(workspaceID, name string) *model.Collection {
	now := s.now()
	c := &model.Collection{
		ID:          randomID("col"),
		WorkspaceID: workspaceID,
		Name:        name,
		CreatedAt:   now,
		UpdatedAt:   now,
		Version:     1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.collections[c.ID] = c
	s.persistCollection(context.Background(), c)
	return c
}

func (s *Store) CollectionByID(id string) (*model.Collection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.collections[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *c
	return &cp, nil
}

func (s *Store) UpdateCollection(id string, version int, name string) (*model.Collection, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.collections[id]
	if !ok {
		return nil, errors.New("not found")
	}
	if c.Version != version {
		return nil, errors.New("version_mismatch")
	}
	c.Name = name
	c.Version++
	c.UpdatedAt = s.now()
	s.persistCollection(context.Background(), c)
	cp := *c
	return &cp, nil
}

func (s *Store) FoldersByCollection(collectionID string) []*model.Folder {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Folder{}
	for _, f := range s.folders {
		if f.CollectionID == collectionID {
			cp := *f
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) CreateFolder(workspaceID, collectionID, name string, parentFolderID *string) *model.Folder {
	now := s.now()
	f := &model.Folder{
		ID:             randomID("fld"),
		WorkspaceID:    workspaceID,
		CollectionID:   collectionID,
		ParentFolderID: parentFolderID,
		Name:           name,
		CreatedAt:      now,
		UpdatedAt:      now,
		Version:        1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.folders[f.ID] = f
	s.persistFolder(context.Background(), f)
	return f
}

func (s *Store) FolderByID(id string) (*model.Folder, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.folders[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *f
	return &cp, nil
}

func (s *Store) UpdateFolder(id string, version int, name string, parentFolderID *string) (*model.Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.folders[id]
	if !ok {
		return nil, errors.New("not found")
	}
	if f.Version != version {
		return nil, errors.New("version_mismatch")
	}
	f.Name = name
	f.ParentFolderID = parentFolderID
	f.Version++
	f.UpdatedAt = s.now()
	s.persistFolder(context.Background(), f)
	cp := *f
	return &cp, nil
}

func (s *Store) RequestsByCollection(collectionID string) []*model.Request {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Request{}
	for _, r := range s.requests {
		if r.CollectionID == collectionID {
			cp := *r
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) CreateRequest(workspaceID, collectionID string, folderID *string, name, method, url, doc string) *model.Request {
	now := s.now()
	r := &model.Request{
		ID:           randomID("req"),
		WorkspaceID:  workspaceID,
		CollectionID: collectionID,
		FolderID:     folderID,
		Name:         name,
		Method:       method,
		URL:          url,
		DocumentJSON: doc,
		CreatedAt:    now,
		UpdatedAt:    now,
		Version:      1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests[r.ID] = r
	s.persistRequest(context.Background(), r)
	return r
}

func (s *Store) RequestByID(id string) (*model.Request, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.requests[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *r
	return &cp, nil
}

func (s *Store) UpdateRequest(id string, version int, name, method, url, doc string) (*model.Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[id]
	if !ok {
		return nil, errors.New("not found")
	}
	if r.Version != version {
		return nil, errors.New("version_mismatch")
	}
	r.Name = name
	r.Method = method
	r.URL = url
	r.DocumentJSON = doc
	r.Version++
	r.UpdatedAt = s.now()
	s.persistRequest(context.Background(), r)
	cp := *r
	return &cp, nil
}

func (s *Store) Environments(workspaceID string) []*model.Environment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Environment{}
	for _, e := range s.environments {
		if e.WorkspaceID == workspaceID {
			cp := *e
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) CreateEnvironment(workspaceID, name string) *model.Environment {
	now := s.now()
	e := &model.Environment{
		ID:          randomID("env"),
		WorkspaceID: workspaceID,
		Name:        name,
		CreatedAt:   now,
		UpdatedAt:   now,
		Version:     1,
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.environments[e.ID] = e
	s.persistEnvironment(context.Background(), e)
	return e
}

func (s *Store) EnvironmentByID(id string) (*model.Environment, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.environments[id]
	if !ok {
		return nil, errors.New("not found")
	}
	cp := *e
	return &cp, nil
}

func (s *Store) UpdateEnvironment(id string, version int, name string) (*model.Environment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.environments[id]
	if !ok {
		return nil, errors.New("not found")
	}
	if e.Version != version {
		return nil, errors.New("version_mismatch")
	}
	e.Name = name
	e.Version++
	e.UpdatedAt = s.now()
	s.persistEnvironment(context.Background(), e)
	cp := *e
	return &cp, nil
}

func (s *Store) Variables(environmentID string) []*model.Variable {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.Variable{}
	for _, v := range s.variables {
		if v.EnvironmentID == environmentID {
			cp := *v
			if v.IsSecret && cp.Value != nil {
				cp.MaskedValue = "••••••••"
				cp.Value = nil
			}
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) PutVariable(environmentID, key string, value *string, isSecret bool) *model.Variable {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, v := range s.variables {
		if v.EnvironmentID == environmentID && v.Key == key {
			v.Value = value
			v.IsSecret = isSecret
			v.UpdatedAt = now
			v.Version++
			s.persistVariable(context.Background(), v)
			return v
		}
	}
	v := &model.Variable{
		ID:            randomID("var"),
		EnvironmentID: environmentID,
		Key:           key,
		Value:         value,
		IsSecret:      isSecret,
		CreatedAt:     now,
		UpdatedAt:     now,
		Version:       1,
	}
	s.variables[v.ID] = v
	s.persistVariable(context.Background(), v)
	return v
}

func (s *Store) ClientRegister() *model.Client {
	c := &model.Client{ClientID: randomID("cli"), RegisteredAt: s.now()}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients[c.ClientID] = c
	return c
}

func (s *Store) WorkspaceHost(workspaceID, host string, kind model.HostKind) *model.WorkspaceHost {
	now := s.now()
	w := &model.WorkspaceHost{
		ID:          randomID("hst"),
		WorkspaceID: workspaceID,
		Host:        host,
		Kind:        kind,
		Status:      model.HostStatusPendingVerification,
		TLSStatus:   model.TLSStatusPending,
		CreatedAt:   now,
		UpdatedAt:   now,
		Version:     1,
	}
	if kind == model.HostKindDedicatedSubdomain {
		w.Status = model.HostStatusActive
		w.TLSStatus = model.TLSStatusReady
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hosts[w.ID] = w
	s.persistHost(context.Background(), w)
	return w
}

func (s *Store) Hosts(workspaceID string) []*model.WorkspaceHost {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []*model.WorkspaceHost{}
	for _, h := range s.hosts {
		if h.WorkspaceID == workspaceID {
			cp := *h
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) WorkspaceSummary(workspaceID string) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	summary := map[string]int{
		"members":       0,
		"invites":       0,
		"join_requests": 0,
		"collections":   0,
		"folders":       0,
		"requests":      0,
		"environments":  0,
		"variables":     0,
		"hosts":         0,
		"audit_logs":    0,
	}
	for _, member := range s.memberships {
		if member.WorkspaceID == workspaceID {
			summary["members"]++
		}
	}
	for _, invite := range s.invites {
		if invite.WorkspaceID == workspaceID {
			summary["invites"]++
		}
	}
	for _, req := range s.joinRequests {
		if req.WorkspaceID == workspaceID {
			summary["join_requests"]++
		}
	}
	for _, collection := range s.collections {
		if collection.WorkspaceID == workspaceID {
			summary["collections"]++
		}
	}
	for _, folder := range s.folders {
		if folder.WorkspaceID == workspaceID {
			summary["folders"]++
		}
	}
	for _, req := range s.requests {
		if req.WorkspaceID == workspaceID {
			summary["requests"]++
		}
	}
	for _, environment := range s.environments {
		if environment.WorkspaceID == workspaceID {
			summary["environments"]++
			for _, variable := range s.variables {
				if variable.EnvironmentID == environment.ID {
					summary["variables"]++
				}
			}
		}
	}
	for _, host := range s.hosts {
		if host.WorkspaceID == workspaceID {
			summary["hosts"]++
		}
	}
	for _, log := range s.auditLogs {
		if log.WorkspaceID == workspaceID {
			summary["audit_logs"]++
		}
	}
	return summary
}

func (s *Store) AuditLogsForWorkspace(workspaceID string) []model.AuditLog {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []model.AuditLog{}
	for _, log := range s.auditLogs {
		if log.WorkspaceID == workspaceID {
			out = append(out, log)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) PushOperations(workspaceID string, operations []model.SyncOperation, baseCheckpoint int) ([]model.SyncAccepted, []model.SyncRejected, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.checkpoints[workspaceID]
	accepted := []model.SyncAccepted{}
	rejected := []model.SyncRejected{}
	if baseCheckpoint != current {
		for _, op := range operations {
			rejected = append(rejected, model.SyncRejected{OperationID: op.OperationID, Reason: "sync_conflict"})
		}
		return accepted, rejected, current
	}
	for _, op := range operations {
		current++
		if err := s.applySyncOperationLocked(workspaceID, op); err != nil {
			rejected = append(rejected, model.SyncRejected{OperationID: op.OperationID, Reason: err.Error()})
			current--
			continue
		}
		accepted = append(accepted, model.SyncAccepted{OperationID: op.OperationID, ResourceID: op.ResourceID, ResultingVersion: current})
		op.WorkspaceID = workspaceID
		op.ResultingVersion = current
		op.OccurredAt = s.now()
		s.operations[workspaceID] = append(s.operations[workspaceID], op)
		s.persistSyncOperation(context.Background(), op)
	}
	s.checkpoints[workspaceID] = current
	s.persistSyncCheckpoint(context.Background(), workspaceID, current)
	return accepted, rejected, current
}

func (s *Store) applySyncOperationLocked(workspaceID string, op model.SyncOperation) error {
	switch op.ResourceType {
	case "workspace":
		workspace, ok := s.workspaces[workspaceID]
		if !ok {
			return errors.New("workspace_not_found")
		}
		if name := stringFromPayload(op.Payload, "name"); name != "" {
			workspace.Name = name
		}
		workspace.Version = nextSyncVersion(workspace.Version, op.BaseVersion)
		workspace.UpdatedAt = s.now()
		s.persistWorkspace(context.Background(), workspace)
	case "collection":
		c, ok := s.collections[op.ResourceID]
		if ok {
			c.Name = stringFromPayload(op.Payload, "name")
			c.Version = nextSyncVersion(c.Version, op.BaseVersion)
			c.UpdatedAt = s.now()
			s.persistCollection(context.Background(), c)
			return nil
		}
		now := s.now()
		c = &model.Collection{
			ID:          op.ResourceID,
			WorkspaceID: workspaceID,
			Name:        stringFromPayload(op.Payload, "name"),
			CreatedAt:   now,
			UpdatedAt:   now,
			Version:     nextSyncVersion(0, op.BaseVersion),
		}
		s.collections[c.ID] = c
		s.persistCollection(context.Background(), c)
	case "folder":
		parentFolderID := stringPtrFromPayload(op.Payload, "parent_folder_id")
		collectionID := stringFromPayload(op.Payload, "collection_id")
		f, ok := s.folders[op.ResourceID]
		if ok {
			f.CollectionID = collectionID
			f.ParentFolderID = parentFolderID
			f.Name = stringFromPayload(op.Payload, "name")
			f.Version = nextSyncVersion(f.Version, op.BaseVersion)
			f.UpdatedAt = s.now()
			s.persistFolder(context.Background(), f)
			return nil
		}
		now := s.now()
		f = &model.Folder{
			ID:             op.ResourceID,
			WorkspaceID:    workspaceID,
			CollectionID:   collectionID,
			ParentFolderID: parentFolderID,
			Name:           stringFromPayload(op.Payload, "name"),
			CreatedAt:      now,
			UpdatedAt:      now,
			Version:        nextSyncVersion(0, op.BaseVersion),
		}
		s.folders[f.ID] = f
		s.persistFolder(context.Background(), f)
	case "request":
		folderID := stringPtrFromPayload(op.Payload, "folder_id")
		collectionID := stringFromPayload(op.Payload, "collection_id")
		req, ok := s.requests[op.ResourceID]
		if ok {
			req.CollectionID = collectionID
			req.FolderID = folderID
			req.Name = stringFromPayload(op.Payload, "name")
			req.Method = stringFromPayload(op.Payload, "method")
			req.URL = stringFromPayload(op.Payload, "url")
			req.DocumentJSON = stringFromPayload(op.Payload, "document_json")
			req.Version = nextSyncVersion(req.Version, op.BaseVersion)
			req.UpdatedAt = s.now()
			s.persistRequest(context.Background(), req)
			return nil
		}
		now := s.now()
		req = &model.Request{
			ID:           op.ResourceID,
			WorkspaceID:  workspaceID,
			CollectionID: collectionID,
			FolderID:     folderID,
			Name:         stringFromPayload(op.Payload, "name"),
			Method:       stringFromPayload(op.Payload, "method"),
			URL:          stringFromPayload(op.Payload, "url"),
			DocumentJSON: stringFromPayload(op.Payload, "document_json"),
			CreatedAt:    now,
			UpdatedAt:    now,
			Version:      nextSyncVersion(0, op.BaseVersion),
		}
		s.requests[req.ID] = req
		s.persistRequest(context.Background(), req)
	case "environment":
		env, ok := s.environments[op.ResourceID]
		if ok {
			env.Name = stringFromPayload(op.Payload, "name")
			env.Version = nextSyncVersion(env.Version, op.BaseVersion)
			env.UpdatedAt = s.now()
			s.persistEnvironment(context.Background(), env)
			return nil
		}
		now := s.now()
		env = &model.Environment{
			ID:          op.ResourceID,
			WorkspaceID: workspaceID,
			Name:        stringFromPayload(op.Payload, "name"),
			CreatedAt:   now,
			UpdatedAt:   now,
			Version:     nextSyncVersion(0, op.BaseVersion),
		}
		s.environments[env.ID] = env
		s.persistEnvironment(context.Background(), env)
	case "environment_variable":
		environmentID := stringFromPayload(op.Payload, "environment_id")
		key := stringFromPayload(op.Payload, "key")
		value := stringPtrFromPayload(op.Payload, "value")
		isSecret := boolFromPayload(op.Payload, "is_secret")
		for _, v := range s.variables {
			if v.ID == op.ResourceID {
				v.EnvironmentID = environmentID
				v.Key = key
				v.Value = value
				v.IsSecret = isSecret
				v.Version = nextSyncVersion(v.Version, op.BaseVersion)
				v.UpdatedAt = s.now()
				s.persistVariable(context.Background(), v)
				return nil
			}
		}
		now := s.now()
		v := &model.Variable{
			ID:            op.ResourceID,
			EnvironmentID: environmentID,
			Key:           key,
			Value:         value,
			IsSecret:      isSecret,
			CreatedAt:     now,
			UpdatedAt:     now,
			Version:       nextSyncVersion(0, op.BaseVersion),
		}
		s.variables[v.ID] = v
		s.persistVariable(context.Background(), v)
	default:
		return errors.New("unsupported_resource_type")
	}
	return nil
}

func nextSyncVersion(currentVersion, baseVersion int) int {
	if currentVersion <= 0 {
		if baseVersion > 0 {
			return baseVersion + 1
		}
		return 1
	}
	if baseVersion >= currentVersion {
		return baseVersion + 1
	}
	return currentVersion + 1
}

func stringFromPayload(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	value, ok := payload[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}

func stringPtrFromPayload(payload map[string]any, key string) *string {
	if payload == nil {
		return nil
	}
	value, ok := payload[key]
	if !ok || value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		return &typed
	default:
		str := fmt.Sprint(typed)
		return &str
	}
}

func boolFromPayload(payload map[string]any, key string) bool {
	if payload == nil {
		return false
	}
	value, ok := payload[key]
	if !ok || value == nil {
		return false
	}
	typed, ok := value.(bool)
	return ok && typed
}

func (s *Store) PullOperations(workspaceID string, afterCheckpoint int) ([]model.SyncOperation, int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	current := s.checkpoints[workspaceID]
	ops := s.operations[workspaceID]
	if afterCheckpoint >= current {
		return nil, current
	}
	out := make([]model.SyncOperation, 0, len(ops))
	for _, op := range ops {
		if op.ResultingVersion > afterCheckpoint {
			out = append(out, op)
		}
	}
	return out, current
}

func (s *Store) AddAudit(actorID, action, resourceType, resourceID, workspaceID string, details map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	log := model.AuditLog{
		ID:           randomID("aud"),
		ActorUserID:  actorID,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		WorkspaceID:  workspaceID,
		Details:      details,
		CreatedAt:    s.now(),
	}
	s.auditLogs = append(s.auditLogs, log)
	s.persistAuditLog(context.Background(), log)
}

func (s *Store) AuditLogs() []model.AuditLog {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.AuditLog, len(s.auditLogs))
	copy(out, s.auditLogs)
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *Store) signingSecret() string {
	if s.secret != "" {
		return s.secret
	}
	return "slinger-dev-secret"
}

func (s *Store) logLocked(actorID, action, resourceType, resourceID string, details map[string]any) {
	log := model.AuditLog{
		ID:           randomID("aud"),
		ActorUserID:  actorID,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		Details:      details,
		CreatedAt:    s.now(),
	}
	s.auditLogs = append(s.auditLogs, log)
	s.persistAuditLog(context.Background(), log)
}

func randomID(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	encoded := base64.RawURLEncoding.EncodeToString(b[:])
	if len(encoded) > 22 {
		encoded = encoded[:22]
	}
	return fmt.Sprintf("%s_%s", prefix, encoded)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomCode(n int) string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	encoded := strings.ToUpper(base32NoPadding(b[:]))
	if len(encoded) > n {
		encoded = encoded[:n]
	}
	if len(encoded) < n {
		encoded += strings.Repeat("X", n-len(encoded))
	}
	return encoded
}

func base32NoPadding(b []byte) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	var out strings.Builder
	var buffer uint
	var bitsLeft uint
	for _, c := range b {
		buffer <<= 8
		buffer |= uint(c)
		bitsLeft += 8
		for bitsLeft >= 5 {
			idx := (buffer >> (bitsLeft - 5)) & 31
			out.WriteByte(alphabet[idx])
			bitsLeft -= 5
		}
	}
	if bitsLeft > 0 {
		idx := (buffer << (5 - bitsLeft)) & 31
		out.WriteByte(alphabet[idx])
	}
	return out.String()
}

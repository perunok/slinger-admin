package server

import (
	"errors"

	"slinger-cloud-api/api/internal/model"
)

func (s *Server) requirePlatformAdmin(user *model.User) error {
	if user == nil {
		return errors.New("unauthenticated")
	}
	if user.PlatformRole != model.PlatformRoleSuperAdmin && user.PlatformRole != model.PlatformRolePlatformAdmin {
		return errors.New("forbidden")
	}
	return nil
}

func (s *Server) requireWorkspaceAccess(user *model.User, workspaceID string) (*model.Workspace, *model.Membership, error) {
	workspace, err := s.store.WorkspaceByID(workspaceID)
	if err != nil {
		return nil, nil, err
	}
	membership, ok := s.store.Membership(workspaceID, user.ID)
	if !ok || membership.Status != "active" {
		return nil, nil, errors.New("user has no access to workspace")
	}
	return workspace, membership, nil
}

func hasAnyWorkspaceRole(membership *model.Membership, allowed ...model.WorkspaceRole) bool {
	if membership == nil {
		return false
	}
	for _, role := range allowed {
		if membership.Role == role {
			return true
		}
	}
	return false
}

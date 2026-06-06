export type PlatformRole = 'super_admin' | 'platform_admin' | 'user';
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type HostKind = 'dedicated_subdomain' | 'custom_domain';

export type User = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  platform_role: PlatformRole;
  created_at: string;
};

export type Workspace = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  owner_user_id?: string;
  host_mode?: string;
  role?: WorkspaceRole;
  version?: number;
  created_at?: string;
  updated_at?: string;
};

export type Member = {
  id: string;
  email: string;
  display_name: string;
  role: WorkspaceRole;
  status: string;
  version: number;
};

export type Host = {
  id: string;
  host: string;
  kind: HostKind;
  status: string;
  tls_status: string;
};

export type Invite = {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expires_at?: string;
  created_at: string;
};

export type AddUserResponse = {
  action: 'added' | 'invited';
  membership?: Member;
  invite?: Invite;
};

export type JoinRequest = {
  id: string;
  requester_user_id?: string;
  requested_role: WorkspaceRole;
  message: string;
  status: string;
  created_at: string;
};

export type Stats = {
  users: number;
  workspaces: number;
  audit_logs: number;
  platform_admins: number;
};

export type WorkspaceSummary = Record<string, number>;

export type Route =
  | { name: 'users' }
  | { name: 'workspaces' }
  | { name: 'workspace-detail'; workspaceId: string };

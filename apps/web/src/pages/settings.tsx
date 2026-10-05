import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Lock, Mail, Plus, Trash2, Users } from 'lucide-react';
import { ORG_ROLES, type OrgRole } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk, useAction, useMembers, useOrganization, useTeams } from '@/api/queries';
import { useAuth } from '@/lib/auth';
import { formatDateTime, timeAgo, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/content';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { Avatar, Badge, Card, CardHeader, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, Page, PageHeader } from '@/components/ui/page';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/tabs';

export function SettingsPage() {
  useDocumentTitle('Settings');
  usePageContext({ title: 'Settings' });
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'workspace';
  return (
    <Page>
      <PageHeader title="Settings" />
      <TabsRoot value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList
          tabs={[
            { value: 'workspace', label: 'Workspace' },
            { value: 'members', label: 'Members' },
            { value: 'teams', label: 'Teams' },
            { value: 'profile', label: 'Profile' },
          ]}
        />
        <TabsContent value="workspace" className="pt-5">
          <Workspace />
        </TabsContent>
        <TabsContent value="members" className="pt-5">
          <MembersTab />
        </TabsContent>
        <TabsContent value="teams" className="pt-5">
          <TeamsTab />
        </TabsContent>
        <TabsContent value="profile" className="pt-5">
          <Profile />
        </TabsContent>
      </TabsRoot>
    </Page>
  );
}

function Workspace() {
  const { can } = useAuth();
  const { data: org, isLoading } = useOrganization();
  const [name, setName] = useState('');
  const [settings, setSettings] = useState({ fourEyesProduction: true, defaultTicketProvider: 'JIRA', logRetentionDays: 90 });
  useEffect(() => {
    if (org) {
      setName(org.name);
      setSettings(org.settings);
    }
  }, [org]);
  const save = useAction(() => api.patch('/organizations/current', { name, settings }), {
    success: 'Workspace saved',
    invalidate: [qk.org, qk.me],
  });
  if (isLoading || !org) return <Skeleton className="h-64" />;
  const manage = can('org:manage');
  return (
    <Card>
      <fieldset disabled={!manage} className="space-y-5 p-5">
        {org.isDemo && (
          <div className="demo-stripes rounded-md border border-warn/30 px-3 py-2 text-[12.5px] text-warn">
            This is a demo workspace — every run is simulated. Create or switch to a real workspace to connect your tools.
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Workspace name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Slug">
            <Input value={org.slug} disabled className="font-mono" />
          </Field>
        </div>
        <label className="flex items-start justify-between gap-4 rounded-md border border-line px-4 py-3">
          <span>
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <Lock className="size-3.5 text-accent" /> Four-eyes for production
            </span>
            <span className="mt-0.5 block text-[12px] text-fg-muted">
              The person who started a run can’t approve its production deployment — someone else with deploy permission must.
            </span>
          </span>
          <Switch
            checked={settings.fourEyesProduction}
            onCheckedChange={(v) => setSettings((s) => ({ ...s, fourEyesProduction: v }))}
            label="Four-eyes for production"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default ticket system">
            <Select
              value={settings.defaultTicketProvider}
              onChange={(e) => setSettings((s) => ({ ...s, defaultTicketProvider: e.target.value }))}
            >
              <option value="JIRA">Jira</option>
              <option value="TRELLO">Trello</option>
            </Select>
          </Field>
          <Field
            label="Log retention (days)"
            hint="Execution logs older than this are purged. Audit entries follow your compliance policy."
          >
            <Input
              type="number"
              min={7}
              max={3650}
              value={settings.logRetentionDays}
              onChange={(e) => setSettings((s) => ({ ...s, logRetentionDays: Number(e.target.value) }))}
            />
          </Field>
        </div>
      </fieldset>
      {manage && (
        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function MembersTab() {
  const { can, user } = useAuth();
  const { data, isLoading } = useMembers();
  const manage = can('members:manage');
  const [inviting, setInviting] = useState(false);
  const changeRole = useAction(
    (v: { id: string; role: OrgRole }) => api.patch(`/organizations/current/members/${v.id}`, { role: v.role }),
    { success: 'Role updated', invalidate: [qk.members] },
  );
  const remove = useAction((id: string) => api.del(`/organizations/current/members/${id}`), {
    success: 'Member removed',
    invalidate: [qk.members],
  });
  const revoke = useAction((id: string) => api.del(`/organizations/current/invitations/${id}`), {
    success: 'Invitation revoked',
    invalidate: [qk.members],
  });
  if (isLoading || !data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={`${data.members.length} members`}
          actions={
            manage && (
              <Button size="sm" variant="primary" icon={<Mail className="size-3.5" />} onClick={() => setInviting(true)}>
                Invite
              </Button>
            )
          }
        />
        <ul className="divide-y divide-line border-t border-line">
          {data.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar name={m.user.name} size={30} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">
                  {m.user.name} {m.user.id === user?.id && <span className="text-fg-subtle">(you)</span>}
                </div>
                <div className="text-[11.5px] text-fg-subtle">
                  {m.user.email} · joined {timeAgo(m.joinedAt)}
                </div>
              </div>
              <Select
                value={m.role}
                disabled={!manage || m.user.id === user?.id}
                onChange={(e) => changeRole.mutate({ id: m.id, role: e.target.value as OrgRole })}
                className="h-7 w-32 text-[12px]"
                aria-label="Role"
              >
                {ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {titleCase(r)}
                  </option>
                ))}
              </Select>
              {manage && m.user.id !== user?.id && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${m.user.name}`}
                  onClick={() => remove.mutate(m.id)}
                  icon={<Trash2 className="size-3.5" />}
                />
              )}
            </li>
          ))}
        </ul>
      </Card>
      {data.invitations.length > 0 && (
        <Card>
          <CardHeader title="Pending invitations" />
          <ul className="divide-y divide-line border-t border-line">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <Mail className="size-4 text-fg-subtle" />
                <span className="flex-1">{i.email}</span>
                <Badge>{titleCase(i.role)}</Badge>
                <span className="text-[11.5px] text-fg-subtle">expires {formatDateTime(i.expiresAt)}</span>
                {manage && (
                  <Button size="xs" variant="danger-ghost" onClick={() => revoke.mutate(i.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card className="p-4 text-[12px] text-fg-muted">
        <div className="mb-2 font-medium text-fg">Roles</div>
        <ul className="grid gap-1 sm:grid-cols-2">
          <li>
            <span className="font-medium text-fg">Owner</span> — everything, including billing and deleting the workspace.
          </li>
          <li>
            <span className="font-medium text-fg">Admin</span> — manage members, integrations, flows and production deploys.
          </li>
          <li>
            <span className="font-medium text-fg">Member</span> — run flows and deploy to non-production per project role.
          </li>
          <li>
            <span className="font-medium text-fg">Viewer</span> — read-only access to runs, projects and reports.
          </li>
        </ul>
      </Card>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('MEMBER');
  const invite = useAction(() => api.post<{ inviteUrl: string; email: string }>('/organizations/current/invitations', { email, role }), {
    invalidate: [qk.members],
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite to workspace"
      description="Share the one-time link with your teammate. It expires in 7 days."
      footer={
        invite.data ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={invite.isPending}
            disabled={!/^\S+@\S+\.\S+$/.test(email)}
            onClick={() => invite.mutate(undefined)}
          >
            Create invitation
          </Button>
        )
      }
    >
      {invite.data ? (
        <div className="space-y-2">
          <p className="text-[12.5px] text-fg-muted">Invitation for {invite.data.email}. This link is shown only once:</p>
          <div className="flex items-center gap-1 rounded-md border border-line bg-sunken px-2.5 py-1.5">
            <Mono className="flex-1 truncate text-fg">{invite.data.inviteUrl}</Mono>
            <CopyButton value={invite.data.inviteUrl} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {ORG_ROLES.filter((r) => r !== 'OWNER').map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function TeamsTab() {
  const { can } = useAuth();
  const teams = useTeams();
  const members = useMembers();
  const manage = can('members:manage');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = useAction(() => api.post('/organizations/current/teams', { name }), {
    success: 'Team created',
    invalidate: [qk.teams],
    onSuccess: () => (setCreating(false), setName('')),
  });
  const setMembers = useAction(
    (v: { id: string; userIds: string[] }) => api.put(`/organizations/current/teams/${v.id}/members`, { userIds: v.userIds }),
    { invalidate: [qk.teams] },
  );
  const remove = useAction((id: string) => api.del(`/organizations/current/teams/${id}`), {
    success: 'Team deleted',
    invalidate: [qk.teams],
  });
  if (teams.isLoading) return <Skeleton className="h-48" />;
  return (
    <div className="space-y-4">
      {!teams.data?.length && (
        <Card>
          <EmptyState
            compact
            icon={<Users />}
            title="No teams yet"
            description="Teams group people and projects, e.g. Platform or Payments."
          />
        </Card>
      )}
      {teams.data?.map((t) => {
        const ids = t.members.map((m) => m.userId);
        return (
          <Card key={t.id}>
            <CardHeader
              title={t.name}
              description={`${t.members.length} members · ${t._count.projects} projects${t.description ? ` · ${t.description}` : ''}`}
              actions={
                manage && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => remove.mutate(t.id)}
                    icon={<Trash2 className="size-3.5" />}
                  />
                )
              }
            />
            <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3">
              {members.data?.members.map((m) => {
                const on = ids.includes(m.user.id);
                return (
                  <button
                    key={m.user.id}
                    type="button"
                    disabled={!manage}
                    onClick={() => setMembers.mutate({ id: t.id, userIds: on ? ids.filter((x) => x !== m.user.id) : [...ids, m.user.id] })}
                    className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[12px] transition-colors ${on ? 'border-accent/50 bg-accent-soft' : 'border-line text-fg-muted opacity-60 hover:opacity-100'}`}
                    aria-pressed={on}
                  >
                    <Avatar name={m.user.name} size={20} />
                    {m.user.name}
                  </button>
                );
              })}
            </div>
          </Card>
        );
      })}
      {manage &&
        (creating ? (
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="max-w-xs" autoFocus />
            <Button variant="primary" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => create.mutate(undefined)}>
              Create
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
            New team
          </Button>
        ))}
    </div>
  );
}

function Profile() {
  const { user, logout } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const saveName = useAction(() => api.patch('/users/me', { name }), { success: 'Profile updated', invalidate: [qk.me] });
  // The server revokes every session for this user (including this one), so sign in again.
  const change = useAction(() => api.post('/auth/change-password', pw), {
    success: 'Password changed — all sessions were signed out. Please sign in again.',
    onSuccess: () => void logout(),
  });
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card>
        <CardHeader title="Profile" />
        <div className="space-y-4 border-t border-line p-4">
          <div className="flex items-center gap-3">
            <Avatar name={name} size={44} />
            <div className="text-[12.5px] text-fg-muted">{user?.email}</div>
          </div>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" loading={saveName.isPending} disabled={!name.trim()} onClick={() => saveName.mutate(undefined)}>
              Save
            </Button>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Password" />
        <form
          className="space-y-4 border-t border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate(undefined);
          }}
        >
          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
            />
          </Field>
          <Field label="New password" hint="At least 10 characters with upper-case, lower-case and a digit.">
            <Input
              type="password"
              autoComplete="new-password"
              value={pw.newPassword}
              onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={change.isPending} disabled={!pw.currentPassword || pw.newPassword.length < 10}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

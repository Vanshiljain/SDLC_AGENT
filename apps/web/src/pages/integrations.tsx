import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  Activity,
  BookText,
  Check,
  ExternalLink,
  GitBranch,
  KeyRound,
  LayoutList,
  MessageSquare,
  Plug,
  ServerCog,
  ShieldCheck,
  Ticket,
  Trash2,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { IntegrationProvider } from '@forgeline/shared';
import { api, errorMessage } from '@/api/client';
import { qk, useAction, useIntegrations, useProviders } from '@/api/queries';
import type { Integration, ProviderInfo } from '@/api/types';
import { useAuth } from '@/lib/auth';
import { timeAgo, titleCase, providerName } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/content';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/form';
import { Badge, Card, Mono, Skeleton, Spinner } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status';
import { Segmented } from '@/components/ui/tabs';

const ICONS: Record<string, LucideIcon> = {
  GITHUB: GitBranch,
  GITHUB_ACTIONS: Workflow,
  JIRA: Ticket,
  TRELLO: LayoutList,
  NOTION: BookText,
  CUSTOM_DEVOPS: ServerCog,
  SLACK: MessageSquare,
};
const slug = (p: IntegrationProvider) => p.toLowerCase().replace(/_/g, '-');

export function IntegrationsPage() {
  useDocumentTitle('Integrations');
  usePageContext({ title: 'Integrations' });
  const [params, setParams] = useSearchParams();
  const providers = useProviders();
  const integrations = useIntegrations();
  const { can } = useAuth();
  const [connecting, setConnecting] = useState<ProviderInfo | null>(null);

  // OAuth redirect results.
  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) toast.success(`${providerName(connected)} connected`);
    if (error) toast.error(`Connection failed: ${error}`);
    if (connected || error) setParams({}, { replace: true });
  }, [params, setParams]);

  return (
    <Page wide>
      <PageHeader
        title="Integrations"
        description="Forgeline acts in your tools on your behalf. Credentials are verified before they are stored, encrypted at rest, and never sent to the browser."
      />
      {providers.error || integrations.error ? (
        <ErrorState error={providers.error ?? integrations.error} onRetry={() => (void providers.refetch(), void integrations.refetch())} />
      ) : providers.isLoading || integrations.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.data?.map((p) => (
            <ProviderCard
              key={p.provider}
              provider={p}
              connections={(integrations.data ?? []).filter((i) => i.provider === p.provider)}
              canManage={can('integration:manage')}
              onConnect={() => setConnecting(p)}
            />
          ))}
        </div>
      )}
      {connecting && <ConnectDialog provider={connecting} onClose={() => setConnecting(null)} />}
    </Page>
  );
}

function ProviderCard({
  provider: p,
  connections,
  canManage,
  onConnect,
}: {
  provider: ProviderInfo;
  connections: Integration[];
  canManage: boolean;
  onConnect: () => void;
}) {
  const Icon = ICONS[p.provider] ?? Plug;
  const connected = connections.some((c) => c.status === 'CONNECTED');
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3 p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-sunken">
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold tracking-tight">{p.name}</span>
            {connected && (
              <Badge tone="ok" icon={<Check className="size-3" />}>
                Connected
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[12px] text-fg-muted">{p.description}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 px-4">
        {p.capabilities.slice(0, 6).map((c) => (
          <Badge key={c}>{c}</Badge>
        ))}
      </div>
      <div className="mt-auto">
        {connections.map((c) => (
          <ConnectionRow key={c.id} integration={c} canManage={canManage} webhookSupport={p.webhookSupport} />
        ))}
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          {canManage && (
            <Button size="sm" variant={connected ? 'ghost' : 'primary'} icon={<Plug className="size-3.5" />} onClick={onConnect}>
              {connected ? 'Add connection' : 'Connect'}
            </Button>
          )}
          <a
            href={p.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-fg-subtle hover:text-fg"
          >
            Docs <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </Card>
  );
}

function ConnectionRow({
  integration: i,
  canManage,
  webhookSupport,
}: {
  integration: Integration;
  canManage: boolean;
  webhookSupport: boolean;
}) {
  const [webhook, setWebhook] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const health = useAction(() => api.post<Integration>(`/integrations/${i.id}/health`), {
    success: (r) => `${r.name}: ${titleCase(r.healthStatus)}`,
    invalidate: [qk.integrations],
  });
  const remove = useAction(() => api.del(`/integrations/${i.id}`), {
    success: 'Disconnected — stored credentials were deleted',
    invalidate: [qk.integrations],
    onSuccess: () => setConfirm(false),
  });
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <StatusBadge status={i.status === 'CONNECTED' ? i.healthStatus : i.status} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{i.externalAccountName ?? i.name}</span>
        <Badge icon={i.authType === 'OAUTH2' ? <ShieldCheck className="size-3" /> : <KeyRound className="size-3" />}>
          {i.authType === 'OAUTH2' ? 'OAuth' : 'Token'}
        </Badge>
      </div>
      {i.healthMessage && <div className="mt-1 truncate text-[11.5px] text-fg-subtle">{i.healthMessage}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-auto text-[11px] text-fg-subtle">checked {timeAgo(i.lastHealthCheckAt)}</span>
        <Button
          size="xs"
          variant="ghost"
          icon={<Activity className="size-3" />}
          loading={health.isPending}
          onClick={() => health.mutate(undefined)}
        >
          Check
        </Button>
        {canManage && webhookSupport && (
          <Button size="xs" variant="ghost" icon={<Webhook className="size-3" />} onClick={() => setWebhook(true)}>
            Webhooks
          </Button>
        )}
        {canManage && (
          <Button size="xs" variant="danger-ghost" icon={<Trash2 className="size-3" />} onClick={() => setConfirm(true)}>
            Disconnect
          </Button>
        )}
      </div>
      {webhook && <WebhookDialog integration={i} onClose={() => setWebhook(false)} />}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${i.name}?`}
        description="Runs that need this integration will stop at the step that uses it. Stored credentials are deleted."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
              Disconnect
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] text-fg-muted">You can reconnect at any time.</p>
      </Dialog>
    </div>
  );
}

function ConnectDialog({ provider: p, onClose }: { provider: ProviderInfo; onClose: () => void }) {
  const methods = p.authMethods;
  const [method, setMethod] = useState(() => methods.find((m) => m.available)?.type ?? methods[0]!.type);
  const current = methods.find((m) => m.type === method)!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [redirecting, setRedirecting] = useState(false);
  const connect = useAction(
    () =>
      api.post<Integration>(`/integrations/${slug(p.provider)}/connect`, {
        credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== '')),
      }),
    {
      success: (i) => `${i.name} connected`,
      invalidate: [qk.integrations, qk.dashboard],
      onSuccess: onClose,
    },
  );
  const startOAuth = async () => {
    setRedirecting(true);
    try {
      const r = await api.post<{ authorizeUrl: string }>(`/integrations/${slug(p.provider)}/oauth/start`, { returnTo: '/integrations' });
      window.location.assign(r.authorizeUrl);
    } catch (err) {
      toast.error(errorMessage(err));
      setRedirecting(false);
    }
  };
  const missing = current.fields.some((f) => f.required && !values[f.name]?.trim());
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Connect ${p.name}`}
      description={p.description}
      footer={
        current.type === 'OAUTH2' ? (
          <Button variant="primary" loading={redirecting} disabled={!current.available} onClick={() => void startOAuth()}>
            Continue to {p.name}
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={connect.isPending}
            disabled={missing || !current.available}
            onClick={() => connect.mutate(undefined)}
          >
            Verify & connect
          </Button>
        )
      }
    >
      {methods.length > 1 && (
        <Segmented
          value={method}
          onChange={(v) => setMethod(v)}
          options={methods.map((m) => ({ value: m.type, label: m.type === 'OAUTH2' ? 'OAuth' : m.label }))}
          className="mb-4"
        />
      )}
      {!current.available ? (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          {current.unavailableReason ?? 'This method is not configured on the server.'}
        </p>
      ) : current.type === 'OAUTH2' ? (
        <p className="text-[13px] text-fg-muted">
          You’ll be redirected to {p.name} to approve access. Forgeline stores the resulting tokens encrypted and refreshes them
          automatically.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing) connect.mutate(undefined);
          }}
        >
          {current.fields.map((f) => (
            <Field key={f.name} label={f.label} required={f.required} hint={f.help}>
              <Input
                type={f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text'}
                autoComplete="off"
                placeholder={f.placeholder}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            </Field>
          ))}
          <p className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
            <ShieldCheck className="size-3.5" /> Verified against {p.name} before saving. Secrets are write-only.
          </p>
          <button type="submit" className="hidden" />
        </form>
      )}
    </Dialog>
  );
}

function WebhookDialog({ integration: i, onClose }: { integration: Integration; onClose: () => void }) {
  const [target, setTarget] = useState('');
  const enable = useAction(
    () =>
      api.post<{ url: string; events: string[]; registered: boolean; instructions: string | null; secret: string | null }>(
        `/integrations/${i.id}/webhooks`,
        i.provider === 'GITHUB' ? { repository: target || undefined } : i.provider === 'TRELLO' ? { boardId: target || undefined } : {},
      ),
    {},
  );
  const result = enable.data;
  const needsTarget = i.provider === 'GITHUB' || i.provider === 'TRELLO';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Webhooks · ${i.name}`}
      description="Inbound events can trigger flows (for example a Jira ticket moving to Ready for Development). Deliveries are signature-verified and de-duplicated."
      footer={
        !result && (
          <Button variant="primary" loading={enable.isPending} disabled={needsTarget && !target} onClick={() => enable.mutate(undefined)}>
            Enable webhook
          </Button>
        )
      }
    >
      {!result ? (
        needsTarget ? (
          <Field
            label={i.provider === 'GITHUB' ? 'Repository' : 'Board ID'}
            hint={i.provider === 'GITHUB' ? 'owner/name — the webhook is registered for you' : 'The Trello board to watch'}
          >
            <Input
              value={target}
              className="font-mono"
              onChange={(e) => setTarget(e.target.value)}
              placeholder={i.provider === 'GITHUB' ? 'acme/auth-service' : '5f2b…'}
            />
          </Field>
        ) : (
          <p className="text-[13px] text-fg-muted">
            Forgeline will create an endpoint and a signing secret for you to configure in {providerName(i.provider)}.
          </p>
        )
      ) : (
        <div className="space-y-3 text-[12.5px]">
          <div className="flex items-center gap-2">
            {result.registered ? <Badge tone="ok">Registered automatically</Badge> : <Badge tone="warn">Manual setup required</Badge>}
            <span className="text-fg-subtle">{result.events.join(', ')}</span>
          </div>
          {result.instructions && <p className="text-fg-muted">{result.instructions}</p>}
          <Field label="Endpoint URL">
            <div className="flex items-center gap-1 rounded-md border border-line bg-sunken px-2.5 py-1.5">
              <Mono className="flex-1 truncate text-fg">{result.url}</Mono>
              <CopyButton value={result.url} />
            </div>
          </Field>
          {result.secret && (
            <Field label="Signing secret" hint="Shown once. Store it in the provider’s webhook settings now.">
              <div className="flex items-center gap-1 rounded-md border border-warn/40 bg-warn-soft px-2.5 py-1.5">
                <Mono className="flex-1 truncate text-fg">{result.secret}</Mono>
                <CopyButton value={result.secret} />
              </div>
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Trello returns the token in the URL fragment; we post it with the state to finish the connection. */
export function TrelloCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const state = params.get('state');
    // Remove the token from the address bar/history immediately.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token || !state) return setError('Trello did not return an authorization token.');
    api
      .post('/integrations/trello/complete', { state, token })
      .then(() => navigate('/integrations?connected=TRELLO', { replace: true }))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [navigate, params]);
  return (
    <Page>
      {error ? (
        <EmptyState
          icon={<Plug />}
          title="Trello connection failed"
          description={error}
          action={<Button onClick={() => navigate('/integrations')}>Back to integrations</Button>}
        />
      ) : (
        <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-fg-muted">
          <Spinner /> Finishing Trello connection…
        </div>
      )}
    </Page>
  );
}

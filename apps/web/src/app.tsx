import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { queryClient } from '@/api/queries';
import { AuthProvider, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { AppShell } from '@/components/layout/app-shell';
import { TooltipProvider } from '@/components/ui/menu';
import { Spinner } from '@/components/ui/primitives';
import { CommandDialogHost } from '@/features/run-command';
import { RouteError } from '@/pages/route-error';

const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) =>
  lazy(async () => ({ default: (await load())[name] as React.ComponentType }));

const LoginPage = page(() => import('@/pages/auth'), 'LoginPage');
const RegisterPage = page(() => import('@/pages/auth'), 'RegisterPage');
const AcceptInvitePage = page(() => import('@/pages/auth'), 'AcceptInvitePage');
const DashboardPage = page(() => import('@/pages/dashboard'), 'DashboardPage');
const ChatPage = page(() => import('@/pages/chat'), 'ChatPage');
const ExecutionsPage = page(() => import('@/pages/executions'), 'ExecutionsPage');
const ExecutionDetailPage = page(() => import('@/pages/execution-detail'), 'ExecutionDetailPage');
const ApprovalsPage = page(() => import('@/pages/approvals'), 'ApprovalsPage');
const DeploymentsPage = page(() => import('@/pages/deployments'), 'DeploymentsPage');
const WorkflowsPage = page(() => import('@/pages/workflows'), 'WorkflowsPage');
const FlowBuilderPage = page(() => import('@/pages/flow-builder'), 'FlowBuilderPage');
const ProjectsPage = page(() => import('@/pages/projects'), 'ProjectsPage');
const ProjectDetailPage = page(() => import('@/pages/project-detail'), 'ProjectDetailPage');
const GraphPage = page(() => import('@/pages/graph'), 'GraphPage');
const KnowledgePage = page(() => import('@/pages/knowledge'), 'KnowledgePage');
const AgentsPage = page(() => import('@/pages/agents'), 'AgentsPage');
const TasksPage = page(() => import('@/pages/records'), 'TasksPage');
const CodeReviewsPage = page(() => import('@/pages/records'), 'CodeReviewsPage');
const CodeReviewDetailPage = page(() => import('@/pages/records'), 'CodeReviewDetailPage');
const QaPage = page(() => import('@/pages/records'), 'QaPage');
const DocumentsPage = page(() => import('@/pages/records'), 'DocumentsPage');
const DocumentDetailPage = page(() => import('@/pages/records'), 'DocumentDetailPage');
const AuditPage = page(() => import('@/pages/audit'), 'AuditPage');
const ObservabilityPage = page(() => import('@/pages/observability'), 'ObservabilityPage');
const IntegrationsPage = page(() => import('@/pages/integrations'), 'IntegrationsPage');
const TrelloCallbackPage = page(() => import('@/pages/integrations'), 'TrelloCallbackPage');
const SettingsPage = page(() => import('@/pages/settings'), 'SettingsPage');
const NotFoundPage = page(() => import('@/pages/route-error'), 'NotFoundPage');

function FullScreenLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="text-fg-subtle" />
    </div>
  );
}

function RequireAuth() {
  const { status, organization } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'anonymous') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!organization) return <FullScreenLoader />;
  return <AppShell />;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'authenticated') {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={next?.startsWith('/') ? next : '/dashboard'} replace />;
  }
  return <>{children}</>;
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullScreenLoader />}>{children}</Suspense>;
}

function Root() {
  return (
    <AuthProvider>
      <Lazy>
        <Outlet />
      </Lazy>
      <CommandDialogHost />
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      {
        path: '/login',
        element: (
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        ),
      },
      {
        path: '/register',
        element: (
          <PublicOnly>
            <RegisterPage />
          </PublicOnly>
        ),
      },
      { path: '/accept-invite', element: <AcceptInvitePage /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          {
            path: '/dashboard',
            element: (
              <Lazy>
                <DashboardPage />
              </Lazy>
            ),
          },
          {
            path: '/chat',
            element: (
              <Lazy>
                <ChatPage />
              </Lazy>
            ),
          },
          {
            path: '/chat/:conversationId',
            element: (
              <Lazy>
                <ChatPage />
              </Lazy>
            ),
          },
          {
            path: '/executions',
            element: (
              <Lazy>
                <ExecutionsPage />
              </Lazy>
            ),
          },
          {
            path: '/executions/:id',
            element: (
              <Lazy>
                <ExecutionDetailPage />
              </Lazy>
            ),
          },
          {
            path: '/approvals',
            element: (
              <Lazy>
                <ApprovalsPage />
              </Lazy>
            ),
          },
          {
            path: '/approvals/:id',
            element: (
              <Lazy>
                <ApprovalsPage />
              </Lazy>
            ),
          },
          {
            path: '/deployments',
            element: (
              <Lazy>
                <DeploymentsPage />
              </Lazy>
            ),
          },
          {
            path: '/workflows',
            element: (
              <Lazy>
                <WorkflowsPage />
              </Lazy>
            ),
          },
          {
            path: '/workflows/new',
            element: (
              <Lazy>
                <FlowBuilderPage />
              </Lazy>
            ),
          },
          {
            path: '/workflows/:id',
            element: (
              <Lazy>
                <FlowBuilderPage />
              </Lazy>
            ),
          },
          {
            path: '/projects',
            element: (
              <Lazy>
                <ProjectsPage />
              </Lazy>
            ),
          },
          {
            path: '/projects/:id',
            element: (
              <Lazy>
                <ProjectDetailPage />
              </Lazy>
            ),
          },
          {
            path: '/graph',
            element: (
              <Lazy>
                <GraphPage />
              </Lazy>
            ),
          },
          {
            path: '/knowledge',
            element: (
              <Lazy>
                <KnowledgePage />
              </Lazy>
            ),
          },
          {
            path: '/agents',
            element: (
              <Lazy>
                <AgentsPage />
              </Lazy>
            ),
          },
          {
            path: '/tasks',
            element: (
              <Lazy>
                <TasksPage />
              </Lazy>
            ),
          },
          {
            path: '/code-reviews',
            element: (
              <Lazy>
                <CodeReviewsPage />
              </Lazy>
            ),
          },
          {
            path: '/code-reviews/:id',
            element: (
              <Lazy>
                <CodeReviewDetailPage />
              </Lazy>
            ),
          },
          {
            path: '/qa',
            element: (
              <Lazy>
                <QaPage />
              </Lazy>
            ),
          },
          {
            path: '/documents',
            element: (
              <Lazy>
                <DocumentsPage />
              </Lazy>
            ),
          },
          {
            path: '/documents/:id',
            element: (
              <Lazy>
                <DocumentDetailPage />
              </Lazy>
            ),
          },
          {
            path: '/audit-logs',
            element: (
              <Lazy>
                <AuditPage />
              </Lazy>
            ),
          },
          {
            path: '/observability',
            element: (
              <Lazy>
                <ObservabilityPage />
              </Lazy>
            ),
          },
          {
            path: '/integrations',
            element: (
              <Lazy>
                <IntegrationsPage />
              </Lazy>
            ),
          },
          {
            path: '/integrations/trello/callback',
            element: (
              <Lazy>
                <TrelloCallbackPage />
              </Lazy>
            ),
          },
          {
            path: '/settings',
            element: (
              <Lazy>
                <SettingsPage />
              </Lazy>
            ),
          },
          {
            path: '*',
            element: (
              <Lazy>
                <NotFoundPage />
              </Lazy>
            ),
          },
        ],
      },
    ],
  },
]);

export function App() {
  const [theme] = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <RouterProvider router={router} />
        <Toaster
          theme={theme}
          position="bottom-right"
          toastOptions={{ className: '!bg-raised !border-line !text-fg !text-[13px] !shadow-pop' }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

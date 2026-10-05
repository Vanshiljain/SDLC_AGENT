import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Check, Hand, Loader2 } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/lib/auth';
import { useDocumentTitle } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { Wordmark } from '@/components/layout/logo';

const SHOW_DEMO_HINT = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN_HINT === 'true';

function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_minmax(440px,520px)]">
      <BrandPanel />
      <div className="flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Wordmark className="mb-10 lg:hidden" />
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
          <p className="mt-1.5 text-[13px] text-fg-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}

const DEMO_STEPS: [string, 'done' | 'live' | 'gate' | 'todo'][] = [
  ['Ticket AUTH-142 created', 'done'],
  ['Spec & plan grounded in repo', 'done'],
  ['Code generated · tests pass (1 self-heal)', 'done'],
  ['AI review · PR #87 opened', 'done'],
  ['CI + QA green', 'live'],
  ['Deploy to production', 'gate'],
];

function BrandPanel() {
  return (
    <div className="relative hidden overflow-hidden border-r border-line bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
      <div className="grid-dots absolute inset-0 opacity-60" />
      <div className="absolute -top-40 -left-40 size-[520px] rounded-full bg-accent/10 blur-3xl" />
      <div className="relative">
        <Wordmark />
      </div>
      <div className="relative max-w-md">
        <div className="label-caps mb-3 text-accent">The AI engineering control plane</div>
        <h2 className="text-[30px] leading-[1.15] font-semibold tracking-[-0.025em]">From request to production — with every step visible and every risky action approved.</h2>
        <div className="mt-8 rounded-xl border border-line bg-raised/90 p-4 shadow-pop backdrop-blur">
          <div className="mb-3 flex items-center justify-between text-[12px]">
            <span className="font-medium">“Implement password reset”</span>
            <span className="font-mono text-fg-subtle">run · 4m 12s</span>
          </div>
          <ul className="space-y-2">
            {DEMO_STEPS.map(([label, state]) => (
              <li key={label} className="flex items-center gap-2.5 text-[12.5px]">
                {state === 'done' && <Check className="size-3.5 text-ok" />}
                {state === 'live' && <Loader2 className="size-3.5 animate-spin text-arc" />}
                {state === 'gate' && <Hand className="size-3.5 text-accent" />}
                <span className={state === 'gate' ? 'text-accent' : state === 'live' ? 'text-fg' : 'text-fg-muted'}>{label}</span>
                {state === 'gate' && <span className="ml-auto rounded-sm bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">needs approval</span>}
              </li>
            ))}
          </ul>
          <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-sunken">
            <div className="forge-line h-full w-4/5 rounded-full" />
          </div>
        </div>
      </div>
      <div className="relative text-[11.5px] text-fg-subtle">GitHub · Jira · Trello · Notion · GitHub Actions · your CI/CD</div>
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  return { error, loading, onSubmit };
}

export function LoginPage() {
  useDocumentTitle('Sign in');
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, loading, onSubmit } = useSubmit(() => login(email, password));
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your Forgeline workspace.">
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={loading}>
          Sign in
        </Button>
      </form>
      {SHOW_DEMO_HINT && (
        <button
          type="button"
          onClick={() => {
            setEmail('engineer@forgeline.dev');
            setPassword('Forgeline!2026');
          }}
          className="mt-4 w-full rounded-md border border-dashed border-line px-3 py-2 text-left text-[12px] text-fg-muted hover:border-line-strong"
        >
          <span className="font-medium text-fg">Seeded demo accounts</span> — engineer@ / lead@ / admin@forgeline.dev · password <span className="font-mono">Forgeline!2026</span>. Click to fill.
        </button>
      )}
      <p className="mt-6 text-[12.5px] text-fg-muted">
        New to Forgeline?{' '}
        <Link to="/register" className="font-medium text-accent hover:underline">
          Create a workspace
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  useDocumentTitle('Create workspace');
  const { register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const { error, loading, onSubmit } = useSubmit(() => register({ ...form, organizationName: form.organizationName || undefined }));
  return (
    <AuthLayout title="Create your workspace" subtitle="Connect your tools and start delivering with agents in minutes.">
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <Field label="Your name">
          <Input autoComplete="name" required value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Work email">
          <Input type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 10 characters with upper-case, lower-case and a digit.">
          <Input type="password" autoComplete="new-password" required minLength={10} value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Workspace name" hint="Usually your company or team.">
          <Input value={form.organizationName} onChange={set('organizationName')} placeholder="Acme Engineering" />
        </Field>
        {error && <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={loading}>
          Create workspace
        </Button>
      </form>
      <p className="mt-6 text-[12.5px] text-fg-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  useDocumentTitle('Join workspace');
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { error, loading, onSubmit } = useSubmit(async () => {
    await acceptInvite({ token, name, password });
    navigate('/dashboard');
  });
  return (
    <AuthLayout title="Join your team" subtitle="You’ve been invited to a Forgeline workspace. Set up your account to continue.">
      {!token ? (
        <p className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">This invitation link is missing its token. Ask your admin for a new link.</p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
          <Field label="Your name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Password" hint="At least 10 characters with upper-case, lower-case and a digit.">
            <Input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={loading}>
            Accept invitation
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

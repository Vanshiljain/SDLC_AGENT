import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Compass, TriangleAlert } from 'lucide-react';
import { EmptyState, Page } from '@/components/ui/page';
import { Button } from '@/components/ui/button';

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unexpected error';
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<TriangleAlert />}
        title="Something broke on this screen"
        description={message}
        action={
          <Button variant="primary" onClick={() => window.location.assign('/dashboard')}>
            Back to Command Center
          </Button>
        }
      />
    </div>
  );
}

export function NotFoundPage() {
  return (
    <Page>
      <EmptyState
        icon={<Compass />}
        title="Nothing here"
        description="This page doesn’t exist or you don’t have access to it."
        action={
          <Link to="/dashboard">
            <Button variant="primary">Go to Command Center</Button>
          </Link>
        }
      />
    </Page>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error boundary caught:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-red-200 bg-white p-6 shadow-card field:border-2 field:border-black" role="alert">
        <div className="flex items-start gap-3">
          <ExclamationTriangleIcon className="h-7 w-7 shrink-0 text-red-600" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">This screen hit an unexpected error</h1>
            <p className="mt-1 break-words text-sm text-muted">{error.message}</p>
            <p className="mt-2 text-sm text-muted">Your saved drafts are stored locally and are not affected.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" icon={ArrowPathIcon} onClick={() => this.setState({ error: null })}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>Reload the app</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
